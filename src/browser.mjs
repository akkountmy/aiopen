/**
 * Настоящий браузер для проверки страниц: открыть адрес или собранный файл,
 * снять скриншот, показать ошибки консоли и горизонтальную прокрутку.
 *
 * Браузер есть не везде: в облачном окружении Amvera Chromium не ставится, а в
 * контейнере из Dockerfile — ставится. Поэтому модуль сначала проверяет, что
 * Playwright и его браузер действительно запускаются, и только потом declares
 * инструмент. Отсутствие браузера не ошибка — просто инструмента нет.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertPublicUrl } from './search.mjs';

const DEFAULT_TIMEOUT_MS = 30000;
const MAX_TIMEOUT_MS = 90000;
const MAX_TEXT_CHARS = 6000;
let availability = null;

async function loadPlaywright() {
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

/** Доступен ли браузер в этом окружении — от этого зависит список инструментов. */
export async function browserAvailable() {
  if (!availability) availability = probe();
  return Boolean(await availability);
}

function resolveTarget(rawUrl, root) {
  const raw = String(rawUrl || '').trim();
  if (!raw) throw new Error('Нужен адрес страницы или файл проекта');
  if (/^https?:\/\//i.test(raw)) return { url: assertPublicUrl(raw).href, local: false };
  if (/^file:\/\//i.test(raw)) throw new Error('Открывайте файл путём внутри проекта, а не ссылкой file://');
  const full = path.resolve(root || '.', raw);
  const base = path.resolve(root || '.');
  if (full !== base && !full.startsWith(base + path.sep)) {
    throw new Error('Файл должен лежать внутри проекта');
  }
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) throw new Error(`Нет такого файла: ${raw}`);
  return { url: pathToFileURL(full).href, local: true };
}

function screenshotPathFor(root, requested, width) {
  const base = path.resolve(root);
  const dir = path.join(base, 'screens');
  fs.mkdirSync(dir, { recursive: true });
  if (!requested) return path.join(dir, `page-${width}.png`);
  const full = path.resolve(base, String(requested));
  if (full !== base && !full.startsWith(base + path.sep)) {
    throw new Error('Скриншот должен лежать внутри проекта');
  }
  return full.toLowerCase().endsWith('.png') ? full : `${full}.png`;
}

/**
 * Открывает страницу и собирает то, что человек увидел бы глазами:
 * заголовок, текст, ошибки консоли, неудачные запросы, горизонтальную прокрутку
 * и скриншот.
 */
export async function checkPage(rawUrl, options = {}) {
  const root = String(options.root || process.cwd());
  const playwright = await loadPlaywright();
  if (!playwright) throw new Error('Браузер в этом окружении недоступен');
  const target = resolveTarget(rawUrl, root);
  const width = Math.min(2400, Math.max(320, Number(options.width) || 1280));
  const height = Math.min(2400, Math.max(320, Number(options.height) || 900));
  const timeoutMs = Math.min(MAX_TIMEOUT_MS, Math.max(5000, Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS));
  const waitMs = Math.min(20000, Math.max(0, Number(options.waitMs) || 0));

  let browser = null;
  try {
    browser = await playwright.chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  } catch (error) {
    throw new Error(`Браузер не запускается: ${String(error?.message || error).split('\n')[0]}`);
  }
  try {
    const context = await browser.newContext({
      viewport: { width, height },
      deviceScaleFactor: 1,
      locale: 'ru-RU',
    });
    const page = await context.newPage();
    const consoleErrors = [];
    const resourceErrors = [];
    const failedRequests = [];
    page.on('console', (message) => {
      if (message.type() !== 'error') return;
      const text = String(message.text()).slice(0, 300);
      /* «Failed to load resource» — это ответ сервера (401, 404), а не падение
         сценария: такие строки уводим отдельно, чтобы не путать с ошибками кода. */
      if (/^Failed to load resource/i.test(text)) resourceErrors.push(text);
      else consoleErrors.push(text);
    });
    page.on('pageerror', (error) => consoleErrors.push(String(error?.message || error).slice(0, 300)));
    page.on('requestfailed', (request) => {
      failedRequests.push(`${request.method()} ${request.url().slice(0, 200)} — ${request.failure()?.errorText || 'сбой'}`);
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
      const headings = [...document.querySelectorAll('h1, h2')].slice(0, 12).map((el) => `${el.tagName.toLowerCase()}: ${el.textContent.trim().slice(0, 120)}`);
      return {
        title: document.title || '',
        text: text.slice(0, 6000),
        chars: text.length,
        scrollWidth: docWidth,
        clientWidth: viewWidth,
        overflow: docWidth > viewWidth + 1,
        wide,
        headings,
      };
    });

    const file = screenshotPathFor(root, options.screenshot, width);
    await page.screenshot({ path: file, fullPage: Boolean(options.fullPage) });
    const status = target.local ? 0 : response ? response.status() : 0;
    const finalUrl = page.url();
    await context.close();

    return {
      url: finalUrl,
      requested: target.url,
      local: target.local,
      status,
      title: facts.title,
      width,
      height,
      fullPage: Boolean(options.fullPage),
      scrollWidth: facts.scrollWidth,
      clientWidth: facts.clientWidth,
      overflow: facts.overflow,
      wide: facts.wide,
      headings: facts.headings,
      consoleErrors: consoleErrors.slice(0, 10),
      resourceErrors: resourceErrors.slice(0, 10),
      failedRequests: failedRequests.slice(0, 10),
      text: facts.text,
      chars: facts.chars,
      screenshot: path.relative(root, file).replace(/\\/g, '/'),
    };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

/** Человеческий разбор результата: сначала главное, потом подробности. */
export function describePage(result) {
  const lines = [];
  const title = result.title ? `«${result.title}»` : '(без заголовка)';
  const where = result.local ? `файл ${result.screenshot}` : result.url;
  lines.push(`Страница — ${title} · ${where}`);
  if (result.status) lines.push(`Ответ сервера: ${result.status}`);
  lines.push(`Окно ${result.width}×${result.height}, ширина содержимого ${result.scrollWidth} px при ${result.clientWidth} px — ${result.overflow ? 'есть горизонтальная прокрутка' : 'по ширине помещается'}`);
  for (const item of result.wide) lines.push(`  · ${item}`);
  if (result.consoleErrors.length) {
    lines.push(`Ошибки в консоли (${result.consoleErrors.length}):`);
    for (const item of result.consoleErrors) lines.push(`  · ${item}`);
  } else {
    lines.push('Ошибок в консоли нет.');
  }
  if (result.resourceErrors?.length) {
    lines.push(`Ответы сервера на запросы страницы (${result.resourceErrors.length}) — обычно 401/404:`);
    for (const item of result.resourceErrors) lines.push(`  · ${item}`);
  }
  if (result.failedRequests.length) {
    lines.push(`Не загрузились (${result.failedRequests.length}):`);
    for (const item of result.failedRequests) lines.push(`  · ${item}`);
  }
  if (result.headings.length) {
    lines.push('Заголовки:');
    for (const item of result.headings) lines.push(`  · ${item}`);
  }
  if (result.text) {
    lines.push(`Снимок ${result.screenshot}, текст ${result.chars} символов:`);
    lines.push(result.text.slice(0, MAX_TEXT_CHARS));
  }
  return lines.join('\n');
}
