/**
 * Проверка страницы: настоящий браузер, три ширины, снимки и машинный отчёт.
 *
 * Где браузер есть (Docker-образ с Chromium), страница открывается по-настоящему:
 * видно горизонтальную прокрутку, ошибки консоли, ответы 4xx/5xx, внешние запросы,
 * картинки без alt и отсутствие h1, а снимки 390/768/1440 px остаются в проекте
 * доказательством. Где браузера нет (облако Amvera без Docker), проверка не
 * исчезает и не врёт: те же факты собираются разбором кода, а «только браузером»
 * честно помечено в отчёте.
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
let availability = null;

async function loadPlaywright() {
  /* DSHOW_NO_BROWSER=1 — проверить поведение облака (Amvera без Docker) на машине,
     где Chromium установлен: тогда честно работает режим «по коду». */
  if (process.env.DSHOW_NO_BROWSER === '1') return null;
  try {
    return await import('playwright');
  } catch {
    return null;
  }
}

/** Открывается ли браузер на самом деле: одной проверки модуля мало. */
async function probe() {
  const playwright = await loadPlaywright();
  if (!playwright) return null;
  let browser = null;
  try {
    browser = await playwright.chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    return playwright;
  } catch {
    return null;
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

/** Доступен ли браузер в этом окружении — от этого зависит глубина проверки. */
export async function browserAvailable() {
  if (!availability) availability = probe();
  return Boolean(await availability);
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Путь проекта в человеческом виде: без file:// и без процентов в кириллице. */
function localPath(requested) {
  const raw = String(requested).replace(/^file:\/{2,3}/i, '');
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/** Один прогон браузера на одной ширине окна. */
async function checkOneWidth(playwright, target, options) {
  const { width, height, fullPage, screenshot, waitMs, timeoutMs, root, widthsCount } = options;
  let browser = null;
  try {
    browser = await playwright.chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  } catch (error) {
    throw new Error(`Браузер не запускается: ${String(error?.message || error).split('\n')[0]}`);
  }
  try {
    const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, locale: 'ru-RU' });
    const page = await context.newPage();
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
      throw new Error(`Страница не открылась: ${String(error?.message || error).split('\n')[0]}`);
    }
    /* Дожидаемся подгрузки: у современных страниц главное приходит после DOM. */
    await page.waitForLoadState('networkidle', { timeout: Math.min(15000, timeoutMs) }).catch(() => {});
    if (waitMs) await page.waitForTimeout(waitMs);
    /* Дать догрузиться картинкам: их отсутствие видно только глазами. */
    await page.evaluate(() => Promise.all([...document.images].map((img) => (img.complete ? null : new Promise((resolve) => {
      img.addEventListener('load', resolve, { once: true });
      img.addEventListener('error', resolve, { once: true });
      setTimeout(resolve, 3000);
    }))))).catch(() => {});
    await sleep(50);

    const facts = await page.evaluate(() => {
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
    });

    const file = screenshotPathFor(root, screenshot, width, widthsCount);
    await page.screenshot({ path: file, fullPage: Boolean(fullPage) });
    const status = target.local ? 0 : response ? response.status() : 0;
    const finalUrl = page.url();
    await context.close();

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
    if (browser) await browser.close().catch(() => {});
  }
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

  const playwright = await loadPlaywright();
  if (playwright) {
    try {
      const variants = [];
      for (const width of widths) {
        variants.push(await checkOneWidth(playwright, target, {
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
        url: first.url || target.url,
        requested: target.url,
        local: target.local,
        title: first.title || facts.title,
        widths,
        static: facts,
        variants,
      };
    } catch (error) {
      /* Браузер установлен, но не поднялся (нет системных библиотек) — не
         роняем задачу, а отдаём статический отчёт с причиной. */
      if (!target.file) throw error;
      return {
        mode: 'static',
        url: target.url,
        requested: target.url,
        local: target.local,
        title: facts.title,
        widths,
        static: facts,
        variants: [],
        reason: String(error?.message || error).split('\n')[0],
      };
    }
  }

  if (!target.file) {
    throw new Error('Без браузера можно проверить только файл проекта; адрес в интернете — в Docker-окружении с Chromium.');
  }
  return {
    mode: 'static',
    url: target.url,
    requested: target.url,
    local: true,
    title: facts.title,
    widths,
    static: facts,
    variants: [],
  };
}

/** Итоги по всем ширинам: сколько проблем и что именно повторяется. */
function summarize(result) {
  const checks = [];
  const facts = result.static || {};
  const variants = result.variants || [];

  if (facts.title) checks.push({ state: 'ok', text: `заголовок вкладки: «${facts.title}»` });
  checks.push({ state: facts.h1 ? 'ok' : 'fail', text: facts.h1 ? `заголовок h1: «${facts.h1}»` : 'h1 отсутствует — не видно, о чём страница' });
  if (facts.images.total) {
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
    state: facts.missingLocal.length ? 'fail' : 'ok',
    text: facts.missingLocal.length ? `ссылки на отсутствующие файлы: ${facts.missingLocal.length}` : 'локальные ссылки на месте',
    details: facts.missingLocal,
  });
  checks.push({
    state: facts.fixedWidths.length ? 'fail' : 'ok',
    text: facts.fixedWidths.length ? `фиксированная ширина шире телефона: ${facts.fixedWidths.length}` : 'фиксированных ширин нет',
    details: facts.fixedWidths,
  });
  const tagProblems = [...facts.unclosedTags.map((tag) => `<${tag}> не закрыт`), ...(facts.mismatchedTags || [])];
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
    checks.push({ state: '--', text: 'прокрутка, ошибки консоли и битые запросы: нужен браузер (Docker-образ с Chromium)' });
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
    lines.push(`Режим: живой браузер, ширины ${result.widths.join(' / ')} px`);
  } else {
    lines.push('Режим: по коду (браузера в этом окружении нет)');
    if (result.reason) lines.push(`Браузер не поднялся: ${result.reason}`);
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
