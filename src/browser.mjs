/**
 * Проверка страницы: настоящий браузер, три ширины, снимки и машинный отчёт.
 *
 * Браузер здесь не «есть или нет», а лестница, и каждая ступень проверяется
 * настоящим запуском:
 *   1. Chromium, установленный рядом с сервисом (Playwright у разработчика,
 *      /ms-playwright в Docker-образе);
 *   2. встроенный Linux-бинарник @sparticuz/chromium — у node-сборки в облаке
 *      нет ни root, ни системных библиотек под Chromium, а этот пакет несёт их
 *      с собой и распаковывается в /tmp при первом запуске;
 *   3. системный Chrome на машине.
 * Если ни одна ступень не поднялась — проверка не исчезает и не врёт: те же
 * факты собираются разбором кода, а «только браузером» честно помечено
 * в отчёте и видно в /api/health?browser=1.
 *
 * В облаке на маленьком тарифе памяти мало, поэтому прогоны идут по одному
 * (очередь), браузер поднимается один раз на всю проверку и закрывается
 * в конце, а при нехватке памяти живая проверка не начинается вовсе.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertPublicUrl } from './search.mjs';
import { staticPageChecks, staticNotes, staticIssueCount, formatRow } from './pagecheck.mjs';

const DEFAULT_TIMEOUT_MS = 30000;
const MAX_TIMEOUT_MS = 90000;
const MAX_TEXT_CHARS = 2500;
const WIDTH_PRESETS = [390, 768, 1440];
/* Аргументы общие для всех драйверов: в контейнере и в облаке нет user
   namespaces (--no-sandbox), /dev/shm мал (--disable-dev-shm-usage), GPU нет. */
const LAUNCH_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--hide-scrollbars',
  '--mute-audio',
  '--lang=ru-RU',
];
/* Сколько ждать очереди на браузер, прежде чем честно сказать «занято». */
const DEFAULT_QUEUE_MS = 45000;
/* Провал запуска кэшируется не навсегда: в облаке Chromium может появиться
   после перезапуска, а разовый сбой не должен отключать проверку. */
const RETRY_AFTER_MS = 5 * 60 * 1000;
const MIN_FREE_MB = 400;

const engineCache = { value: null };
const candidates = { list: null, reason: '' };
const state = { pending: null, lastError: '', failedAt: 0 };
const gate = { busy: false, waiters: [] };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function shortError(error) {
  return String(error?.message || error || 'сбой').split('\n')[0].slice(0, 240);
}

async function optionalModule(name) {
  try {
    return await import(name);
  } catch {
    return null;
  }
}

/** Chromium, который поставил Playwright рядом с сервисом (не в облачной сборке). */
function bundledChromium(playwright) {
  try {
    const file = playwright?.chromium?.executablePath?.();
    return file && fs.existsSync(file) ? file : '';
  } catch {
    return '';
  }
}

/** Системный Chrome/Chromium/Edge: последняя ступень лестницы. */
function platformChrome() {
  const list = [];
  if (process.platform === 'win32') {
    for (const root of [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA]) {
      if (!root) continue;
      list.push(path.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'));
      list.push(path.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
    }
  } else if (process.platform === 'darwin') {
    list.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
    list.push('/Applications/Chromium.app/Contents/MacOS/Chromium');
  } else {
    list.push(
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/lib/chromium/chromium',
      '/snap/bin/chromium',
    );
  }
  return list.find((item) => item && fs.existsSync(item)) || '';
}

/** Встроенный бинарник @sparticuz/chromium: распаковывается в /tmp при первом вызове. */
async function embeddedChromium() {
  const sparticuz = await optionalModule('@sparticuz/chromium');
  if (!sparticuz) return { path: '', args: [] };
  const box = sparticuz.default || sparticuz;
  if (typeof box?.executablePath !== 'function') return { path: '', args: [] };
  try {
    const file = await box.executablePath();
    return {
      path: file && fs.existsSync(file) ? file : '',
      args: Array.isArray(box.args) ? box.args : [],
    };
  } catch (error) {
    state.lastError = shortError(error);
    return { path: '', args: [] };
  }
}

function remember(value) {
  engineCache.value = value;
  return value;
}

function resetEngine() {
  engineCache.value = null;
  candidates.list = null;
  candidates.reason = '';
  state.lastError = '';
  state.failedAt = 0;
}

/**
 * Кандидаты по порядку: сначала то, что ближе к сервису, потом запасные.
 * Наличие файла ещё ничего не значит — проверяем запуском в engine().
 */
async function buildCandidates() {
  if (candidates.list) return candidates.list;
  const off = String(process.env.DSHOW_BROWSER || '').trim().toLowerCase();
  if (process.env.DSHOW_NO_BROWSER === '1' || ['off', '0', 'false', 'no'].includes(off)) {
    candidates.list = [];
    candidates.reason = 'браузер выключен в этом окружении (DSHOW_BROWSER=off)';
    return candidates.list;
  }

  const forced = String(process.env.DSHOW_BROWSER_DRIVER || '').trim().toLowerCase();
  const custom = String(process.env.DSHOW_CHROME_PATH || '').trim();
  if (custom && !fs.existsSync(custom)) {
    candidates.list = [];
    candidates.reason = `DSHOW_CHROME_PATH указывает на несуществующий файл: ${custom}`;
    return candidates.list;
  }

  const playwright = (await optionalModule('playwright')) || (await optionalModule('playwright-core'));
  const puppeteer = await optionalModule('puppeteer-core');
  const embedded = custom ? { path: '', args: [] } : await embeddedChromium();
  const bundled = custom ? '' : bundledChromium(playwright);
  const system = custom || platformChrome();
  const want = (driver) => !forced || forced === driver;
  const list = [];

  if (custom && playwright && want('playwright')) {
    list.push({ driver: 'playwright', module: playwright, executablePath: custom, args: LAUNCH_ARGS, label: 'Chrome по DSHOW_CHROME_PATH' });
  }
  if (custom && puppeteer && want('puppeteer')) {
    list.push({ driver: 'puppeteer', module: puppeteer, executablePath: custom, args: LAUNCH_ARGS, label: 'Chrome по DSHOW_CHROME_PATH' });
  }
  if (bundled && want('playwright')) {
    list.push({ driver: 'playwright', module: playwright, executablePath: bundled, args: LAUNCH_ARGS, label: 'Chromium Playwright' });
  }
  if (embedded.path && puppeteer && want('puppeteer')) {
    list.push({
      driver: 'puppeteer',
      module: puppeteer,
      executablePath: embedded.path,
      args: [...LAUNCH_ARGS, ...embedded.args],
      label: 'встроенный Chromium (@sparticuz)',
    });
  }
  if (system && !custom && puppeteer && want('puppeteer')) {
    list.push({ driver: 'puppeteer', module: puppeteer, executablePath: system, args: LAUNCH_ARGS, label: 'системный Chrome' });
  }
  if (system && !custom && playwright && want('playwright')) {
    list.push({ driver: 'playwright', module: playwright, executablePath: system, args: LAUNCH_ARGS, label: 'системный Chrome' });
  }

  if (!list.length) {
    candidates.reason = forced
      ? `DSHOW_BROWSER_DRIVER=${forced}, но подходящего Chromium нет`
      : 'нет Chromium: ни рядом с сервисом, ни встроенного, ни системного';
  }
  candidates.list = list;
  return list;
}

/**
 * Рабочий движок выбирается запуском, а не наличием файла: чужой Chromium без
 * системных библиотек спокойно лежит рядом и всё равно не поднимается —
 * в облаке так и бывает, поэтому перебираем кандидатов до первого живого.
 * Результат запоминается: лишние секунды на каждом вызове инструмента не нужны.
 */
async function engine() {
  if (engineCache.value) return engineCache.value;
  if (state.pending) return state.pending;
  state.pending = (async () => {
    const list = await buildCandidates();
    if (!list.length) return remember({ reason: candidates.reason || 'браузера в окружении нет' });
    const tried = [];
    for (const candidate of list) {
      let browser = null;
      let failure = '';
      try {
        browser = await launch(candidate, 20000);
      } catch (error) {
        failure = shortError(error);
      }
      if (browser) {
        await browser.close().catch(() => {});
        return remember(candidate);
      }
      candidate.error = failure || 'сбой запуска';
      state.lastError = candidate.error;
      tried.push(`${candidate.label}: ${candidate.error}`);
    }
    return remember({ reason: `ни один браузер не запустился (${tried.join('; ')})` });
  })();
  try {
    return await state.pending;
  } finally {
    state.pending = null;
  }
}

async function launch(found, timeoutMs) {
  if (found.driver === 'playwright') {
    return found.module.chromium.launch({
      executablePath: found.executablePath || undefined,
      args: found.args,
      headless: true,
      timeout: Math.min(60000, Math.max(15000, timeoutMs)),
    });
  }
  return found.module.launch({
    executablePath: found.executablePath,
    args: found.args,
    headless: true,
    protocolTimeout: Math.max(120000, timeoutMs + 30000),
  });
}

/** Доступен ли браузер в этом окружении — от этого зависит глубина проверки. */
export async function browserAvailable() {
  const found = await engine();
  if (found.driver) return true;
  /* Разовый сбой не должен отключать проверку навсегда: в облаке Chromium
     может появиться после перезапуска, а память — освободиться. */
  const now = Date.now();
  if (!state.failedAt) state.failedAt = now;
  if (now - state.failedAt > RETRY_AFTER_MS) {
    resetEngine();
    return Boolean((await engine()).driver);
  }
  return false;
}

/**
 * Состояние браузера для /api/health. Без параметра — быстрый отчёт по уже
 * принятому решению, Chromium не запускается. probe: true (health?browser=1) —
 * честная проверка запуском, это секунды.
 */
export async function browserStatus({ probe: deep = false } = {}) {
  if (deep) {
    resetEngine();
    const found = await engine();
    return {
      engine: found.label || null,
      executable: found.executablePath ? path.basename(found.executablePath) : '',
      available: Boolean(found.driver),
      reason: found.driver ? '' : found.reason || 'браузер не запускается',
      checked: 'запуском',
    };
  }
  const found = engineCache.value;
  if (found) {
    return {
      engine: found.label || null,
      executable: found.executablePath ? path.basename(found.executablePath) : '',
      available: Boolean(found.driver),
      reason: found.reason || state.lastError || '',
    };
  }
  const list = await buildCandidates();
  return {
    engine: list.length ? list[0].label : null,
    executable: list.length && list[0].executablePath ? path.basename(list[0].executablePath) : '',
    available: null,
    reason: list.length ? '' : candidates.reason || '',
  };
}

function resolveTarget(rawUrl, root) {
  const raw = String(rawUrl || '').trim();
  if (!raw) throw new Error('Нужен адрес страницы или файл проекта');
  if (/^https?:\/\//i.test(raw)) return { url: assertPublicUrl(raw).href, local: false, file: null };
  if (/^file:\/\//i.test(raw)) throw new Error('Открывайте файл путём внутри проекта, а не ссылкой file://');
  const full = path.resolve(root || '.', raw);
  const base = path.resolve(root || '.');
  if (full !== base && !full.startsWith(base + path.sep)) {
    throw new Error('Файл должен лежать внутри проекта');
  }
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) throw new Error(`Нет такого файла: ${raw}`);
  return { url: pathToFileURL(full).href, local: true, file: full };
}

/** Ширины проверки: по умолчанию те самые 390 / 768 / 1440 px. */
export function normalizeWidths(raw) {
  let list = [];
  if (Array.isArray(raw)) list = raw;
  else if (typeof raw === 'string') list = raw.split(/[\s,;]+/);
  else if (raw !== undefined && raw !== null) list = [raw];
  const widths = [...new Set(list.map((item) => Math.round(Number(item))).filter((item) => item >= 320 && item <= 2400))];
  if (!widths.length) return [...WIDTH_PRESETS];
  return widths.slice(0, 4).sort((a, b) => a - b);
}

function screenshotPathFor(root, requested, width, widthsCount) {
  const base = path.resolve(root);
  const dir = path.join(base, 'screens');
  fs.mkdirSync(dir, { recursive: true });
  const explicit = Boolean(requested);
  const name = widthsCount > 1 ? `page-${width}.png` : 'page.png';
  if (!requested) return path.join(dir, name);
  const asFile = path.resolve(base, String(requested));
  if (asFile !== base && !asFile.startsWith(base + path.sep)) {
    throw new Error('Скриншот должен лежать внутри проекта');
  }
  /* Одно имя на несколько ширин не годится: снимки затрут друг друга. */
  if (explicit && widthsCount > 1) {
    const ext = path.extname(asFile).toLowerCase() === '.png' ? '' : '.png';
    return `${asFile.slice(0, asFile.length - ext.length)}-${width}.png`;
  }
  return asFile.toLowerCase().endsWith('.png') ? asFile : `${asFile}.png`;
}

function readSource(target, root) {
  if (target.file) {
    try {
      return fs.readFileSync(target.file, 'utf8');
    } catch {
      return '';
    }
  }
  return '';
}

/** Путь проекта в человеческом виде: без file:// и без процентов в кириллице. */
function localPath(requested) {
  const raw = String(requested).replace(/^file:\/{2,3}/i, '');
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/** Что видно на странице: тот же сбор фактов для обоих драйверов. */
function pageFacts() {
  const text = (document.body?.innerText || '').replace(/\n{3,}/g, '\n\n').trim();
  const docWidth = document.documentElement.scrollWidth;
  const viewWidth = document.documentElement.clientWidth;
  const wide = [...document.querySelectorAll('body *')]
    .filter((el) => el.getBoundingClientRect().right > viewWidth + 1)
    .slice(0, 5)
    .map((el) => {
      const rect = el.getBoundingClientRect();
      const name = el.tagName.toLowerCase() + (el.id ? `#${el.id}` : '') + (el.className && typeof el.className === 'string' ? `.${el.className.split(/\s+/)[0]}` : '');
      return `${name} шире экрана на ${Math.round(rect.right - viewWidth)} px`;
    });
  const headings = [...document.querySelectorAll('h1, h2, h3')].slice(0, 12).map((el) => `${el.tagName.toLowerCase()}: ${el.textContent.trim().slice(0, 120)}`);
  const h1 = document.querySelector('h1');
  const images = [...document.images];
  const withoutAlt = images.filter((img) => !img.hasAttribute('alt')).map((img) => (img.currentSrc || img.src || '').slice(0, 160)).slice(0, 8);
  return {
    title: document.title || '',
    text: text.slice(0, 6000),
    chars: text.length,
    scrollWidth: docWidth,
    clientWidth: viewWidth,
    overflow: docWidth > viewWidth + 1,
    wide,
    headings,
    h1: h1 ? h1.textContent.trim().slice(0, 160) : '',
    images: images.length,
    imagesWithoutAlt: withoutAlt,
  };
}

/** Страница под нужный драйвер: Playwright работает через контекст, puppeteer — через viewport. */
async function openSession(found, browser, viewport) {
  if (found.driver === 'playwright') {
    const context = await browser.newContext({ viewport, deviceScaleFactor: 1, locale: 'ru-RU' });
    const page = await context.newPage();
    return {
      page,
      close: () => context.close(),
      waitIdle: (timeout) => page.waitForLoadState('networkidle', { timeout }).catch(() => {}),
    };
  }
  const page = await browser.newPage();
  await page.setViewport({ ...viewport, deviceScaleFactor: 1 });
  return {
    page,
    close: () => page.close(),
    waitIdle: (timeout) => page.waitForNetworkIdle({ idleTime: 500, timeout }).catch(() => {}),
  };
}

/** Один прогон на одной ширине окна. Браузер общий, страница своя. */
async function checkOneWidth(found, browser, target, options) {
  const { width, height, fullPage, screenshot, waitMs, timeoutMs, root, widthsCount } = options;
  const session = await openSession(found, browser, { width, height });
  const { page } = session;
  try {
    const consoleErrors = [];
    const resourceErrors = [];
    const broken = [];
    const external = new Set();
    const pageOrigin = target.local ? 'file://' : new URL(target.url).origin;

    page.on('console', (message) => {
      if (message.type() !== 'error') return;
      const text = String(message.text()).slice(0, 300);
      /* «Failed to load resource» — ответ сервера (401, 404), а не падение
         сценария: такие строки уводим отдельно, чтобы не путать с ошибками кода. */
      if (/^Failed to load resource/i.test(text)) resourceErrors.push(text);
      else consoleErrors.push(text);
    });
    page.on('pageerror', (error) => consoleErrors.push(String(error?.message || error).slice(0, 300)));
    page.on('requestfailed', (request) => {
      broken.push(`${request.method()} ${request.url().slice(0, 200)} — ${request.failure()?.errorText || 'сбой'}`);
    });
    page.on('response', (response) => {
      const status = response.status();
      if (status >= 400) broken.push(`HTTP ${status} ${response.url().slice(0, 200)}`);
    });
    page.on('request', (request) => {
      const url = request.url();
      if (!/^https?:/i.test(url)) return;
      const origin = (() => {
        try {
          return new URL(url).origin;
        } catch {
          return '';
        }
      })();
      if (origin && origin !== pageOrigin) external.add(url.slice(0, 200));
    });

    let response = null;
    try {
      response = await page.goto(target.url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    } catch (error) {
      throw new Error(`Страница не открылась: ${shortError(error)}`);
    }
    /* Дожидаемся подгрузки: у современных страниц главное приходит после DOM. */
    await session.waitIdle(Math.min(15000, timeoutMs));
    if (waitMs) await sleep(waitMs);
    /* Дать догрузиться картинкам: их отсутствие видно только глазами. */
    await page.evaluate(() => Promise.all([...document.images].map((img) => (img.complete ? null : new Promise((resolve) => {
      img.addEventListener('load', resolve, { once: true });
      img.addEventListener('error', resolve, { once: true });
      setTimeout(resolve, 3000);
    }))))).catch(() => {});
    await sleep(50);

    const facts = await page.evaluate(pageFacts);

    const file = screenshotPathFor(root, screenshot, width, widthsCount);
    await page.screenshot({ path: file, fullPage: Boolean(fullPage) });
    const status = target.local ? 0 : response ? response.status() : 0;
    const finalUrl = page.url();

    return {
      width,
      height,
      status,
      url: finalUrl,
      title: facts.title,
      scrollWidth: facts.scrollWidth,
      clientWidth: facts.clientWidth,
      overflow: facts.overflow,
      wide: facts.wide,
      headings: facts.headings,
      h1: facts.h1,
      images: facts.images,
      imagesWithoutAlt: facts.imagesWithoutAlt,
      consoleErrors: consoleErrors.slice(0, 8),
      resourceErrors: resourceErrors.slice(0, 8),
      broken: [...new Set(broken)].slice(0, 8),
      external: [...external].slice(0, 8),
      text: facts.text,
      chars: facts.chars,
      screenshot: path.relative(root, file).replace(/\\/g, '/'),
    };
  } finally {
    await session.close().catch(() => {});
  }
}

function freeMemoryMb() {
  if (process.platform !== 'linux') return Number.POSITIVE_INFINITY;
  try {
    const info = fs.readFileSync('/proc/meminfo', 'utf8');
    const found = info.match(/MemAvailable:\s+(\d+)\s*kB/i);
    if (found) return Math.round(Number(found[1]) / 1024);
  } catch {
    /* /proc нет — не мешаем проверке. */
  }
  return Number.POSITIVE_INFINITY;
}

function minFreeMb() {
  const raw = Number(process.env.DSHOW_BROWSER_MIN_MB);
  return Number.isFinite(raw) && raw > 0 ? raw : MIN_FREE_MB;
}

/** Очередь: один браузер за раз, чтобы проверка не съела память сервиса. */
function acquireGate(limitMs) {
  if (!gate.busy) {
    gate.busy = true;
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    let timer = null;
    const waiter = {
      grant: () => {
        if (timer) clearTimeout(timer);
        resolve(true);
      },
    };
    timer = setTimeout(() => {
      const index = gate.waiters.indexOf(waiter);
      if (index >= 0) gate.waiters.splice(index, 1);
      resolve(false);
    }, Math.max(1000, limitMs));
    gate.waiters.push(waiter);
  });
}

function releaseGate() {
  const next = gate.waiters.shift();
  if (next) next.grant();
  else gate.busy = false;
}

/**
 * Открывает страницу и собирает то, что человек увидел бы глазами.
 * Без браузера возвращает статический разбор того же файла (mode: 'static').
 */
export async function checkPage(rawUrl, options = {}) {
  const root = String(options.root || process.cwd());
  const target = resolveTarget(rawUrl, root);
  const widths = normalizeWidths(options.widths ?? options.width);
  const height = Math.min(2400, Math.max(320, Number(options.height) || 900));
  const timeoutMs = Math.min(MAX_TIMEOUT_MS, Math.max(5000, Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS));
  const waitMs = Math.min(20000, Math.max(0, Number(options.waitMs) || 0));
  const source = readSource(target, root);
  const facts = staticPageChecks(source, { root, file: target.file });

  /* Файл проекта можно разобрать по коду в любом случае; адрес в интернете
     без браузера проверить нечем — там честная ошибка, а не пустой отчёт. */
  const degraded = (reason) => {
    if (!target.file) throw new Error(`Без браузера можно проверить только файл проекта — причина: ${reason}`);
    return {
      mode: 'static',
      url: target.url,
      requested: target.url,
      local: true,
      title: facts.title,
      widths,
      static: facts,
      variants: [],
      reason,
    };
  };

  const found = await engine();
  if (!found.driver) return degraded(found.reason || 'браузера в окружении нет');

  const free = freeMemoryMb();
  if (free < minFreeMb()) {
    return degraded(`мало памяти для браузера: свободно ${free} МБ, нужно ${Math.round(minFreeMb())} МБ`);
  }

  const queueMs = Number(process.env.DSHOW_BROWSER_QUEUE_MS) || DEFAULT_QUEUE_MS;
  const granted = await acquireGate(queueMs);
  if (!granted) return degraded('браузер занят другой проверкой — попробуйте через минуту');

  let browser = null;
  try {
    try {
      browser = await launch(found, timeoutMs);
    } catch (error) {
      state.lastError = shortError(error);
      throw new Error(`Браузер не запускается: ${state.lastError}`);
    }
    const variants = [];
    for (const width of widths) {
      variants.push(await checkOneWidth(found, browser, target, {
        width,
        height,
        fullPage: Boolean(options.fullPage),
        screenshot: String(options.screenshot || ''),
        waitMs,
        timeoutMs,
        root,
        widthsCount: widths.length,
      }));
    }
    const first = variants[0] || {};
    return {
      mode: 'browser',
      engine: found.label,
      url: first.url || target.url,
      requested: target.url,
      local: target.local,
      title: first.title || facts.title,
      widths,
      static: facts,
      variants,
    };
  } catch (error) {
    /* Браузер есть, но не поднялся (нет системных библиотек, кончилась память) —
       не роняем задачу, а отдаём статический отчёт с причиной. */
    state.lastError = shortError(error);
    return degraded(shortError(error));
  } finally {
    if (browser) await browser.close().catch(() => {});
    releaseGate();
  }
}

/** Итоги по всем ширинам: сколько проблем и что именно повторяется. */
function summarize(result) {
  const checks = [];
  const facts = result.static || {};
  const variants = result.variants || [];

  if (facts.title) checks.push({ state: 'ok', text: `заголовок вкладки: «${facts.title}»` });
  checks.push({ state: facts.h1 ? 'ok' : 'fail', text: facts.h1 ? `заголовок h1: «${facts.h1}»` : 'h1 отсутствует — не видно, о чём страница' });
  if (facts.images?.total) {
    checks.push({
      state: facts.images.withoutAlt ? 'fail' : 'ok',
      text: facts.images.withoutAlt
        ? `картинки без alt: ${facts.images.withoutAlt} из ${facts.images.total}`
        : `у всех картинок есть alt (${facts.images.total})`,
      details: facts.images.examples,
    });
  }
  checks.push({
    state: facts.externalCount ? 'fail' : 'ok',
    text: facts.externalCount ? `внешние запросы: ${facts.externalCount} — страница должна работать офлайн` : 'внешних запросов нет',
    details: facts.external,
  });
  checks.push({
    state: facts.missingLocal?.length ? 'fail' : 'ok',
    text: facts.missingLocal?.length ? `ссылки на отсутствующие файлы: ${facts.missingLocal.length}` : 'локальные ссылки на месте',
    details: facts.missingLocal,
  });
  checks.push({
    state: facts.fixedWidths?.length ? 'fail' : 'ok',
    text: facts.fixedWidths?.length ? `фиксированная ширина шире телефона: ${facts.fixedWidths.length}` : 'фиксированных ширин нет',
    details: facts.fixedWidths,
  });
  const tagProblems = [...(facts.unclosedTags || []).map((tag) => `<${tag}> не закрыт`), ...(facts.mismatchedTags || [])];
  checks.push({ state: tagProblems.length ? 'fail' : 'ok', text: tagProblems.length ? `теги: ${tagProblems.length} замечаний` : 'теги закрыты парно', details: tagProblems });
  if (facts.quoteIssues?.length) {
    checks.push({ state: 'fail', text: `незакрытые кавычки в атрибутах: ${facts.quoteIssues.length}`, details: facts.quoteIssues });
  }

  if (result.mode === 'browser') {
    for (const variant of variants) {
      checks.push({
        state: variant.overflow ? 'fail' : 'ok',
        text: variant.overflow
          ? `горизонтальная прокрутка на ${variant.width} px: содержимое ${variant.scrollWidth} px`
          : `по ширине помещается на ${variant.width} px (содержимое ${variant.scrollWidth} px)`,
        details: variant.wide,
      });
      checks.push({
        state: variant.consoleErrors.length ? 'fail' : 'ok',
        text: variant.consoleErrors.length ? `ошибки в консоли на ${variant.width} px: ${variant.consoleErrors.length}` : `ошибок в консоли нет на ${variant.width} px`,
        details: variant.consoleErrors,
      });
      if (variant.broken.length) {
        checks.push({ state: 'fail', text: `битые запросы на ${variant.width} px: ${variant.broken.length}`, details: variant.broken });
      }
      if (variant.external.length) {
        checks.push({ state: 'fail', text: `внешние запросы из браузера на ${variant.width} px: ${variant.external.length}`, details: variant.external });
      }
      if (variant.imagesWithoutAlt.length) {
        checks.push({ state: 'fail', text: `картинки без alt в DOM на ${variant.width} px: ${variant.imagesWithoutAlt.length}`, details: variant.imagesWithoutAlt });
      }
    }
  } else {
    checks.push({ state: '--', text: 'прокрутка, ошибки консоли и битые запросы: нужен браузер (Chromium рядом с сервисом)' });
  }
  return checks;
}

/** Человеческий разбор результата: сначала итоги, потом подробности. */
export function describePage(result) {
  const checks = summarize(result);
  const lines = [];
  const where = result.local ? localPath(result.requested || '') : result.url;
  lines.push(`Страница «${result.title || 'без заголовка'}» — ${where}`);
  if (result.mode === 'browser') {
    lines.push(`Режим: живой браузер (${result.engine || 'Chromium'}), ширины ${result.widths.join(' / ')} px`);
  } else {
    lines.push(`Режим: по коду (${result.reason || 'браузера в этом окружении нет'})`);
  }

  const shots = (result.variants || []).map((variant) => variant.screenshot);
  if (shots.length) lines.push(`Снимки: ${shots.join(', ')}`);

  const failed = checks.filter((item) => item.state === 'fail').length;
  const skipped = checks.filter((item) => item.state === '--').length;
  const okCount = checks.length - failed - skipped;
  const tail = skipped ? `, ${skipped} недоступно без браузера` : '';
  lines.push('');
  lines.push(failed ? `Проверки: ${okCount} ok, ${failed} с замечаниями${tail}` : `Проверки: ${okCount} ok, замечаний нет${tail}`);
  for (const check of checks) lines.push(formatRow(check));

  const notes = staticNotes(result.static || {});
  if (notes.length) {
    lines.push('');
    lines.push('Мелочи на будущее:');
    for (const note of notes) lines.push(`   · ${note}`);
  }

  const widest = (result.variants || [])[0];
  if (widest?.text) {
    lines.push('');
    lines.push(`Текст страницы (${widest.chars} знаков, снимок ${widest.screenshot}):`);
    lines.push(widest.text.slice(0, MAX_TEXT_CHARS));
  }
  return lines.join('\n');
}
