import dns from 'node:dns/promises';
import net from 'node:net';
import { extractDocumentText } from './docparse.mjs';
import { extractReadable, extractFields } from './extract.mjs';
import { truncate } from './util.mjs';
import { deepseekEnabled, deepseekSearch, deepseekFetch } from './deepseek-search.mjs';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const MAX_BYTES = 12 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 30000;
const SEARCH_TIMEOUT_MS = 20000;
/* Локальные и служебные адреса из облака недоступны: сервис работает на общем
   хосте, и запрос к 127.0.0.1 или к метаданным хостинга — это попытка пройти
   внутрь инфраструктуры. Страницы пользователя ходят только по публичным IP.

   Раньше проверялось только написание хоста: `2130706433`, `0x7f.0.0.1`,
   `[::ffff:127.0.0.1]` и домены вроде `127.0.0.1.nip.io` проходили её насквозь,
   а перенаправление с публичного сайта на localhost проверялось уже после
   запроса. Теперь адрес разбирается как IP, а имена разрешаются через DNS. */
const SKIP_EXT = /\.(png|jpe?g|gif|svg|webp|ico|bmp|zip|rar|7z|gz|mp4|mp3|avi|mov|woff2?|ttf|eot|exe|dmg|apk)(\?|#|$)/i;

const LOCAL_NAMES = /(^|\.)(localhost|local|internal|intranet|home\.arpa|lan|localdomain)$/i;

function isPrivateAddress(value) {
  const ip = String(value || '')
    .replace(/^\[|\]$/g, '')
    .toLowerCase();
  if (!ip) return true;
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 198 && (b === 18 || b === 19)) return true;
    return a >= 224;
  }
  if (net.isIPv6(ip)) {
    if (ip === '::' || ip === '::1') return true;
    if (ip.startsWith('::ffff:')) {
      /* URL-парсер переписывает IPv4-хвост в hex: [::ffff:127.0.0.1] приходит
         как ::ffff:7f00:1. Разбираем оба написания. */
      const tail = ip.slice(7);
      if (net.isIPv4(tail)) return isPrivateAddress(tail);
      const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(tail);
      if (hex) {
        const high = parseInt(hex[1], 16);
        const low = parseInt(hex[2], 16);
        return isPrivateAddress(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
      }
      return true;
    }
    if (ip.startsWith('fe8') || ip.startsWith('fe9') || ip.startsWith('fea') || ip.startsWith('feb')) return true;
    if (ip.startsWith('fc') || ip.startsWith('fd')) return true;
    if (ip.startsWith('ff')) return true;
    return false;
  }
  return true;
}

function allowPrivate() {
  return process.env.DSHOW_ALLOW_PRIVATE_FETCH === '1';
}

function assertPublicHostname(hostname) {
  const raw = String(hostname || '')
    .toLowerCase()
    .replace(/\.$/, '');
  /* URL отдаёт адрес IPv6 в скобках: [::1]. net.isIP скобок не понимает. */
  const host = raw.replace(/^\[|\]$/g, '');
  if (!host) throw new Error('Локальные и служебные адреса недоступны из облака');
  if (net.isIP(host)) {
    if (isPrivateAddress(host)) throw new Error('Локальные и служебные адреса недоступны из облака');
    return;
  }
  if (LOCAL_NAMES.test(host)) throw new Error('Локальные и служебные адреса недоступны из облака');
}

/* Имя может указывать на внутренний адрес (nip.io, свой DNS): разрешаем его
   заранее и проверяем каждый полученный IP. */
export async function assertResolvesPublic(hostname) {
  if (allowPrivate() || net.isIP(String(hostname || '').replace(/^\[|\]$/g, ''))) return;
  let addresses = [];
  try {
    addresses = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new Error(`Не удалось найти сайт ${hostname}`);
  }
  if (!addresses.length) throw new Error(`Не удалось найти сайт ${hostname}`);
  for (const entry of addresses) {
    if (isPrivateAddress(entry.address)) throw new Error('Локальные и служебные адреса недоступны из облака');
  }
}

/** Проверяет ссылку и возвращает её объект; локальные адреса запрещены. */
export function assertPublicUrl(raw) {
  let url;
  try {
    url = new URL(String(raw).trim());
  } catch {
    throw new Error('Некорректная ссылка: нужен полный адрес вида https://…');
  }
  if (!/^https?:$/.test(url.protocol)) throw new Error('Разрешены только ссылки http:// и https://');
  /* Для локальной установки, где сервис сам ходит в свои микросервисы, запрет
     снимается явным флагом окружения. В облаке флаг не выставляется. */
  if (!allowPrivate()) assertPublicHostname(url.hostname);
  return url;
}

function decodeEntities(text) {
  return String(text)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

/** Текст ответа с учётом кодировки из заголовка или <meta charset>. */
export function decodeBody(buffer, contentType = '') {
  const declared = /charset\s*=\s*"?([\w-]+)/i.exec(contentType)?.[1];
  let charset = declared;
  if (!charset) {
    const head = buffer.subarray(0, 4096).toString('latin1');
    charset = /<meta[^>]+charset\s*=\s*"?([\w-]+)/i.exec(head)?.[1];
  }
  const name = String(charset || 'utf-8').toLowerCase();
  try {
    return new TextDecoder(name).decode(buffer);
  } catch {
    return buffer.toString('utf8');
  }
}

export function htmlToText(html) {
  return decodeEntities(
    String(html)
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<\/(p|div|li|tr|h[1-6]|section|article|blockquote)>/gi, '\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t\u00a0]{2,}/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Убирает служебные блоки и комментарии — из них получается «мусорный» текст. */
function stripBoilerplate(html) {
  const tags = 'script|style|noscript|svg|iframe|form|nav|header|footer|aside|template|select';
  return String(html)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(new RegExp(`<(${tags})\\b[\\s\\S]*?<\\/\\1>`, 'gi'), ' ');
}

/** Ищет основной блок страницы: article → main → role=main → body. */
function pickMain(html) {
  const candidates = [
    /<article\b[^>]*>([\s\S]*?)<\/article>/i,
    /<main\b[^>]*>([\s\S]*?)<\/main>/i,
    /<div\b[^>]*role="main"[^>]*>([\s\S]*?)<\/div>\s*<\/(?:div|main)>/i,
  ];
  for (const pattern of candidates) {
    const match = html.match(pattern);
    if (match && htmlToText(match[1]).length > 400) return match[1];
  }
  const body = html.match(/<body\b[^>]*>([\s\S]*)<\/body>/i);
  return body ? body[1] : html;
}

function extractTitle(html, fallback = '') {
  const raw = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  if (raw && htmlToText(raw)) return htmlToText(raw).slice(0, 200);
  const h1 = /<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1];
  if (h1 && htmlToText(h1)) return htmlToText(h1).slice(0, 200);
  return fallback;
}

function extractMeta(html, name) {
  const pattern = new RegExp(
    `<meta[^>]+(?:name|property)=["']${name}["'][^>]*content=["']([^"']*)["']`,
    'i',
  );
  const second = new RegExp(
    `<meta[^>]+content=["']([^"']*)["'][^>]*(?:name|property)=["']${name}["']`,
    'i',
  );
  const match = html.match(pattern) || html.match(second);
  return match ? decodeEntities(match[1]).slice(0, 500) : '';
}

function extractHeadings(html) {
  const headings = [];
  const re = /<h([1-3])\b[^>]*>([\s\S]*?)<\/h\1>/gi;
  let match;
  while ((match = re.exec(html)) && headings.length < 40) {
    const text = htmlToText(match[2]);
    if (text) headings.push({ level: Number(match[1]), text: text.slice(0, 160) });
  }
  return headings;
}

function extractTables(html) {
  const tables = [];
  const tableRe = /<table\b[\s\S]*?<\/table>/gi;
  let table;
  while ((table = tableRe.exec(html)) && tables.length < 6) {
    const rows = [];
    const rowRe = /<tr\b[\s\S]*?<\/tr>/gi;
    let row;
    while ((row = rowRe.exec(table[0])) && rows.length < 30) {
      const cells = [];
      const cellRe = /<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi;
      let cell;
      while ((cell = cellRe.exec(row[0])) && cells.length < 12) {
        cells.push(htmlToText(cell[1]).slice(0, 120));
      }
      if (cells.some(Boolean)) rows.push(cells);
    }
    if (rows.length) tables.push(rows);
  }
  return tables;
}

function extractLinks(html, baseUrl, origin) {
  const links = [];
  const seen = new Set();
  const re = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = re.exec(html)) && links.length < 120) {
    const href = decodeEntities(match[1]).trim();
    if (!href || href.startsWith('#') || /^(mailto|tel|javascript):/i.test(href)) continue;
    let resolved;
    try {
      resolved = new URL(href, baseUrl);
    } catch {
      continue;
    }
    if (!/^https?:$/.test(resolved.protocol)) continue;
    resolved.hash = '';
    const key = resolved.href;
    if (seen.has(key)) continue;
    seen.add(key);
    links.push({
      href: key,
      text: htmlToText(match[2]).slice(0, 120),
      sameOrigin: resolved.origin === origin,
    });
  }
  return links;
}

/**
 * Загружает страницу в читаемом виде: заголовок, описание, структура, таблицы,
 * ссылки и очищенный текст. Основной разбор — Readability (как «Режим чтения»):
 * он выкидывает меню, рекламу и подвал, а таблицы и списки сохраняет.
 * Если Readability не справился, работает прежний разбор регулярками.
 */
export async function readPage(rawUrl, { maxChars = 32000 } = {}) {
  const url = assertPublicUrl(rawUrl);
  const page = await requestPage(url.href, { accept: 'text/html,application/xhtml+xml,*/*;q=0.5' });
  if (page.kind !== 'html') {
    return { url: page.url, kind: page.kind, title: '', text: truncate(page.text, maxChars), tables: [], links: [], headings: [] };
  }
  try {
    const extracted = extractReadable(page.text, page.url);
    if (extracted.text) {
      /* Сравниваем с итоговым адресом после редиректов, иначе http→https
         или переезд на другой домен ломает обход: все ссылки «чужие». */
      const pageOrigin = new URL(page.url).origin;
      const links = extracted.links.map((link) => {
        try {
          return { ...link, sameOrigin: new URL(link.href).origin === pageOrigin };
        } catch {
          return { ...link, sameOrigin: false };
        }
      });
      return {
        url: page.url,
        kind: 'html',
        title: extracted.title || extractTitle(page.text),
        description: extracted.description || extractMeta(page.text, 'description') || extractMeta(page.text, 'og:description'),
        lang: extracted.lang || /<html[^>]+lang=["']([\w-]+)["']/i.exec(page.text)?.[1] || '',
        headings: extracted.headings,
        tables: extracted.tables,
        links,
        text: truncate(extracted.text, maxChars),
        markdown: truncate(extracted.markdown, maxChars),
        chars: extracted.chars,
        engine: extracted.engine,
      };
    }
  } catch {
    /* ниже — старый разбор: он хуже, но не оставляет пользователя без текста */
  }
  const html = stripBoilerplate(page.text);
  const main = pickMain(html);
  const text = htmlToText(main);
  return {
    url: page.url,
    kind: 'html',
    title: extractTitle(html) || extractTitle(page.text),
    description: extractMeta(html, 'description') || extractMeta(html, 'og:description'),
    lang: /<html[^>]+lang=["']([\w-]+)["']/i.exec(page.text)?.[1] || '',
    headings: extractHeadings(main),
    tables: extractTables(main),
    links: extractLinks(html, page.url, new URL(page.url).origin),
    text: truncate(text, maxChars),
    chars: text.length,
    engine: 'regex',
  };
}

/* Запрос с ручным разбором перенаправлений: каждый следующий адрес проходит ту
   же проверку, что и первый. Автоматический `redirect: 'follow'` этого не даёт —
   публичный сайт мог перенаправить сервис на 127.0.0.1 или в метаданные. */
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;

async function fetchGuarded(startUrl, { method, headers, body, signal }) {
  let target = startUrl;
  let currentMethod = method;
  let currentBody = body;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const url = assertPublicUrl(target);
    await assertResolvesPublic(url.hostname);
    const response = await fetch(url, {
      method: currentMethod,
      headers,
      body: currentMethod === 'GET' || currentMethod === 'HEAD' ? undefined : currentBody ?? undefined,
      redirect: 'manual',
      signal,
    });
    if (!REDIRECT_STATUS.has(response.status)) return { response, url };
    const location = response.headers.get('location');
    if (!location) return { response, url };
    if (hop === MAX_REDIRECTS) throw new Error('Слишком много перенаправлений');
    const next = new URL(location, url);
    if (response.status === 303 || ((response.status === 301 || response.status === 302) && currentMethod !== 'GET' && currentMethod !== 'HEAD')) {
      currentMethod = 'GET';
      currentBody = null;
    }
    target = next.href;
  }
  throw new Error('Слишком много перенаправлений');
}

/** Один HTTP-запрос с разбором кодировки и типа содержимого. */
async function requestPage(rawUrl, { method = 'GET', headers = {}, body = null, timeoutMs = FETCH_TIMEOUT_MS, accept } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const requestHeaders = {
      'User-Agent': UA,
      'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8',
      Accept: accept || 'text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.5',
      ...headers,
    };
    const upper = String(method || 'GET').toUpperCase();
    const { response, url } = await fetchGuarded(assertPublicUrl(rawUrl), {
      method: upper,
      headers: requestHeaders,
      body,
      signal: controller.signal,
    });
    if (!response.ok && response.status >= 500) throw new Error(`Сайт ответил ${response.status}`);
    const contentType = response.headers.get('content-type') || '';
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > MAX_BYTES) throw new Error('Страница слишком большая (больше 12 МБ)');
    let text;
    let kind = 'text';
    if (contentType.includes('pdf') || url.pathname.toLowerCase().endsWith('.pdf')) {
      text = extractDocumentText(buffer, 'download.pdf', 'application/pdf').text;
      kind = 'pdf';
    } else if (contentType.includes('json')) {
      text = decodeBody(buffer, contentType);
      kind = 'json';
    } else if (contentType.includes('html') || contentType.includes('xml')) {
      text = decodeBody(buffer, contentType);
      kind = 'html';
    } else {
      text = decodeBody(buffer, contentType);
      kind = contentType.startsWith('text/') ? 'text' : 'binary';
    }
    return {
      url: response.url || url.href,
      status: response.status,
      contentType,
      kind,
      text,
      bytes: buffer.length,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Загружает страницу и приводит её к тексту. `markdown: true` — с разметкой. */
export async function fetchUrl(url, { maxChars = 24000, method = 'GET', headers = {}, body = null, markdown = false } = {}) {
  /* Fetch API отдаёт уже очищенный Markdown и не зависит от вёрстки. Берём его
     для обычного GET без своих заголовков; POST/API и приватные адреса идут
     прежним путём, где нужны тело запроса и точный контроль. */
  if (deepseekEnabled() && method === 'GET' && !body && !Object.keys(headers || {}).length) {
    try {
      assertPublicUrl(url);
      const page = await deepseekFetch(url);
      const content = truncate(page.content, maxChars);
      return {
        url: page.url || url,
        kind: 'text',
        status: 200,
        contentType: 'text/markdown',
        title: page.title || String(content.match(/^#{1,3}\s+(.+)$/m)?.[1] || '').trim(),
        text: content,
        markdown: markdown ? content : undefined,
        bytes: Buffer.byteLength(page.content),
      };
    } catch {
      // Сайт не отдался через DeepSeek — ниже обычная загрузка с браузерным fallback.
    }
  }
  const page = await requestPage(url, { method, headers, body });
  let text = page.text;
  let title = (text.match(/^.{0,120}/) || [''])[0].trim();
  let extracted = null;
  if (page.kind === 'html') {
    try {
      extracted = extractReadable(page.text, page.url);
      text = (markdown ? extracted.markdown : extracted.text) || htmlToText(page.text);
      title = extracted.title || extractTitle(page.text);
    } catch {
      text = htmlToText(page.text);
      title = extractTitle(page.text);
    }
  }
  return {
    url: page.url,
    kind: page.kind,
    status: page.status,
    contentType: page.contentType,
    title,
    text: truncate(text, maxChars),
    markdown: extracted && page.kind === 'html' ? truncate(extracted.markdown, maxChars) : undefined,
    bytes: page.bytes,
  };
}

/**
 * Отрисовывает страницу настоящим браузером. Нужно для SPA и сайтов, которые
 * отдают контент только после JS. В облаке без Chromium честно говорит, что
 * браузера нет, — вместо пустого текста.
 */
async function renderHtml(rawUrl, { timeoutMs = 45000, waitMs = 0, waitSelector = '' } = {}) {
  const url = assertPublicUrl(rawUrl);
  await assertResolvesPublic(url.hostname);
  let playwright;
  try {
    playwright = await import('playwright');
  } catch {
    throw new Error('Браузер недоступен в этом окружении: используйте render:false');
  }
  let browser;
  try {
    browser = await playwright.chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  } catch (error) {
    throw new Error(`Браузер не запускается: ${String(error?.message || error).split('\n')[0]}`);
  }
  try {
    const context = await browser.newContext({ locale: 'ru-RU', userAgent: UA, serviceWorkers: 'block' });
    /* Браузер грузит не только главный адрес: картинки, шрифты и XHR могут
       смотреть на localhost. Проверяем каждый запрос, иначе публичная страница
       превращается в SSRF-прокси к внутренней сети. */
    const hostChecks = new Map();
    await context.route('**/*', async (route) => {
      const target = route.request().url();
      if (/^(data|blob):/i.test(target)) return route.continue();
      try {
        const parsed = assertPublicUrl(target);
        const host = parsed.hostname;
        if (!hostChecks.has(host)) {
          hostChecks.set(host, assertResolvesPublic(host).then(() => true).catch(() => false));
        }
        if (!(await hostChecks.get(host))) return route.abort();
        return route.continue();
      } catch {
        return route.abort();
      }
    });
    const page = await context.newPage();
    const response = await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    /* После редиректа адрес мог стать внутренним — проверяем ещё раз. */
    const finalUrl = assertPublicUrl(page.url());
    await assertResolvesPublic(finalUrl.hostname);
    await page.waitForLoadState('networkidle', { timeout: Math.min(12000, timeoutMs) }).catch(() => {});
    if (waitSelector) {
      await page.waitForSelector(String(waitSelector), { timeout: Math.min(20000, timeoutMs) }).catch(() => {});
    }
    if (waitMs) await page.waitForTimeout(Math.min(20000, Math.max(0, waitMs)));
    const html = await page.content();
    if (html.length > 12_000_000) throw new Error('Страница слишком большая для разбора (больше 12 МБ HTML)');
    return { html, url: page.url(), status: response?.status() || 200, kind: 'html' };
  } finally {
    await browser.close().catch(() => {});
  }
}

/**
 * Профессиональный разбор одной страницы: Markdown, чистый текст или поля по
 * CSS-селекторам. Всё локально и бесплатно, без внешних API и ключей.
 */
export async function scrapePage(
  rawUrl,
  {
    format = 'markdown',
    maxChars = 30000,
    selectors = null,
    render = false,
    timeoutMs = 45000,
    waitMs = 0,
    waitSelector = '',
  } = {},
) {
  const url = assertPublicUrl(rawUrl);
  const page = render
    ? await renderHtml(url.href, { timeoutMs, waitMs, waitSelector })
    : await requestPage(url.href, { accept: 'text/html,application/xhtml+xml,*/*;q=0.5' });
  if (page.kind && page.kind !== 'html') {
    return {
      url: page.url,
      kind: page.kind,
      status: page.status,
      title: '',
      text: truncate(page.text, maxChars),
      fields: null,
    };
  }
  const html = page.text || page.html || '';
  const extracted = extractReadable(html, page.url);
  let fields = null;
  if (selectors && typeof selectors === 'object' && Object.keys(selectors).length) {
    fields = extractFields(html, page.url, selectors);
  }
  const body = format === 'markdown' ? extracted.markdown || extracted.text : extracted.text;
  return {
    url: page.url,
    kind: 'html',
    status: page.status,
    title: extracted.title,
    description: extracted.description,
    byline: extracted.byline,
    publishedTime: extracted.publishedTime,
    lang: extracted.lang,
    engine: extracted.engine,
    chars: extracted.chars,
    markdownChars: extracted.markdownChars,
    text: truncate(body, maxChars),
    fields,
    headings: extracted.headings.slice(0, 30),
    tables: extracted.tables,
    links: extracted.links.slice(0, 30),
  };
}

/** Загружает несколько адресов параллельно; ошибки не срывают остальные. */
export async function fetchMany(urls, { maxChars = 8000, concurrency = 3 } = {}) {
  const list = [...new Set((Array.isArray(urls) ? urls : []).map((item) => String(item).trim()).filter(Boolean))].slice(0, 6);
  if (!list.length) throw new Error('Нужен хотя бы один адрес');
  const results = new Array(list.length);
  let next = 0;
  const workers = new Array(Math.min(concurrency, list.length)).fill(0).map(async () => {
    while (next < list.length) {
      const index = next++;
      const url = list[index];
      try {
        const page = await fetchUrl(url, { maxChars: Math.min(maxChars, 20000) });
        results[index] = { url: page.url, title: page.title, kind: page.kind, status: page.status, text: truncate(page.text, maxChars) };
      } catch (error) {
        results[index] = { url, error: String(error?.message || error) };
      }
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Обход сайта по ссылкам: до maxPages страниц в пределах одного сайта.
 * Нужен, когда данных нет на одной странице — прайсы, каталоги, документация.
 */
export async function crawlSite(rawUrl, { maxPages = 8, maxDepth = 1, maxChars = 4000, concurrency = 3 } = {}) {
  const start = assertPublicUrl(rawUrl);
  start.hash = '';
  const seen = new Set([start.href]);
  const queue = [{ url: start.href, depth: 0 }];
  const pages = [];
  const pagesLimit = Math.max(1, Math.min(Number(maxPages) || 8, 20));
  const depthLimit = Math.max(0, Math.min(Number(maxDepth) || 0, 2));

  while (queue.length && pages.length < pagesLimit) {
    const batch = queue.splice(0, Math.max(1, Math.min(Number(concurrency) || 3, 4)));
    const settled = await Promise.allSettled(batch.map((item) => readPage(item.url, { maxChars: 20000 })));
    for (let index = 0; index < settled.length; index++) {
      const item = batch[index];
      const result = settled[index];
      if (result.status !== 'fulfilled') {
        pages.push({ url: item.url, error: String(result.reason?.message || result.reason) });
        continue;
      }
      const page = result.value;
      if (page.kind !== 'html') {
        pages.push({ url: page.url, kind: page.kind, text: truncate(page.text, maxChars) });
        continue;
      }
      pages.push({
        url: page.url,
        title: page.title,
        headings: page.headings.slice(0, 8).map((heading) => heading.text),
        text: truncate(page.text, maxChars),
      });
      if (item.depth >= depthLimit) continue;
      for (const link of page.links) {
        if (!link.sameOrigin) continue;
        let href;
        try {
          const next = new URL(link.href);
          if (!/^https?:$/.test(next.protocol)) continue;
          next.hash = '';
          href = next.href;
        } catch {
          continue;
        }
        if (SKIP_EXT.test(href)) continue;
        if (seen.has(href)) continue;
        if (pages.length + queue.length >= pagesLimit * 3) break;
        seen.add(href);
        queue.push({ url: href, depth: item.depth + 1 });
      }
    }
  }
  return { start: start.href, pages: pages.slice(0, pagesLimit), found: seen.size };
}

/** Поиск в интернете без ключей. Возвращает [{ title, url, snippet }]. */
/* Простое совпадение по началу слова: «доллара» должно находить «доллар»,
   а «курсы» — «курс». Служебные слова не считаем, иначе любой посторонний
   результат с «сегодня» проходил бы проверку. */
const SEARCH_STOP = new Set([
  'это', 'как', 'что', 'где', 'когда', 'зачем', 'почему', 'какой', 'какая', 'какие',
  'сегодня', 'сейчас', 'новый', 'новая', 'новые', 'последние', 'самые', 'лучше',
  'нужно', 'можно', 'стоит', 'через', 'после', 'перед', 'между', 'также', 'очень',
]);

function queryTokens(query) {
  return [...new Set(
    String(query)
      .toLowerCase()
      .replace(/ё/g, 'е')
      .split(/[^\p{L}\p{N}]+/u)
      .filter((word) => word.length >= 3 && !/^\d+$/.test(word) && !SEARCH_STOP.has(word)),
  )].slice(0, 8);
}

function looksRelevant(result, tokens) {
  if (!tokens.length) return true;
  const haystack = `${result.title || ''} ${result.snippet || ''} ${result.url || ''}`
    .toLowerCase()
    .replace(/ё/g, 'е');
  const hits = tokens.filter((token) => haystack.includes(token.slice(0, Math.min(5, token.length))));
  const need = Math.min(2, tokens.length);
  return hits.length >= need;
}

/* Bing отдаёт ссылки через свой редирект ck/a с адресом в base64url-поле u.
   Разворачиваем его, иначе модель получает ссылку на bing.com и не может
   открыть источник. */
function bingLink(raw) {
  let link = decodeEntities(raw);
  try {
    const url = new URL(link, 'https://www.bing.com');
    const encoded = url.searchParams.get('u');
    if (encoded && encoded.startsWith('a1')) {
      const base64 = encoded.slice(2).replace(/-/g, '+').replace(/_/g, '/');
      const decoded = Buffer.from(base64, 'base64').toString('utf8');
      if (/^https?:\/\//i.test(decoded)) link = decoded;
    }
  } catch {
    /* оставляем исходную ссылку */
  }
  return link;
}

/* Резервная выдача, когда DuckDuckGo отвечает проверкой на робота (202).
   Bing отдаёт обычный HTML без ключа; разбираем только органические блоки
   b_algo. При смене вёрстки функция вернёт пустой список, и вызывающий код
   покажет честную ошибку вместо выдуманных источников. */
async function bingSearch(query, limit = 6) {
  const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}&setlang=ru`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': UA,
        'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8',
        Accept: 'text/html,application/xhtml+xml',
      },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Поиск недоступен (${response.status})`);
    const html = await response.text();
    const results = [];
    const tokens = queryTokens(query);
    const blockRe = /<li class="b_algo"[\s\S]*?<\/li>/g;
    let match;
    while ((match = blockRe.exec(html)) && results.length < limit) {
      const block = match[0];
      const titleMatch = block.match(/<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
      if (!titleMatch) continue;
      const link = bingLink(titleMatch[1]);
      if (!/^https?:/i.test(link)) continue;
      const title = htmlToText(titleMatch[2]).slice(0, 200);
      const snippetMatch = block.match(/<p[^>]*>([\s\S]*?)<\/p>/);
      const snippet = snippetMatch ? htmlToText(snippetMatch[1]).slice(0, 400) : '';
      const candidate = { title, url: link, snippet };
      /* Bing иногда отдаёт вместо выдачи случайные блоки. Не показываем их
         модели как источники: лучше честная ошибка, чем чужие ссылки. */
      if (!looksRelevant(candidate, tokens)) continue;
      results.push(candidate);
    }
    return results;
  } finally {
    clearTimeout(timer);
  }
}

/* Лента Google Новостей отдаётся обычным RSS без ключа и без проверки на
   робота. Это не замена общему поиску, но для новостей, курсов, цен и
   законов она даёт свежие материалы с датой и издателем. */
async function newsSearch(query, limit = 6) {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=ru&gl=RU&ceid=RU:ru`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8' },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Лента новостей недоступна (${response.status})`);
    const xml = await response.text();
    const results = [];
    const tokens = queryTokens(query);
    const itemRe = /<item>([\s\S]*?)<\/item>/g;
    let match;
    while ((match = itemRe.exec(xml)) && results.length < limit) {
      const item = match[1];
      const titleRaw = item.match(/<title>([\s\S]*?)<\/title>/)?.[1] || '';
      const linkRaw = item.match(/<link>([\s\S]*?)<\/link>/)?.[1] || '';
      const dateRaw = item.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1] || '';
      const sourceName = item.match(/<source[^>]*>([\s\S]*?)<\/source>/)?.[1] || '';
      const title = htmlToText(decodeEntities(titleRaw)).slice(0, 200);
      const link = decodeEntities(linkRaw).trim();
      if (!title || !/^https?:/i.test(link)) continue;
      const source = htmlToText(decodeEntities(sourceName)).trim();
      const date = dateRaw ? new Date(dateRaw) : null;
      const when = date && !Number.isNaN(date.getTime())
        ? date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' })
        : '';
      const snippet = [source, when].filter(Boolean).join(' · ').slice(0, 400);
      const candidate = { title, url: link, snippet };
      if (!looksRelevant(candidate, tokens)) continue;
      results.push(candidate);
    }
    return results;
  } finally {
    clearTimeout(timer);
  }
}

export async function webSearch(query, limit = 6) {
  let deepseekError = null;
  if (deepseekEnabled()) {
    try {
      const found = await deepseekSearch(query, { count: Math.max(1, Math.min(10, Number(limit) || 6)) });
      if (found.length) return found;
      deepseekError = new Error('DeepSeek Search вернул пустую выдачу');
    } catch (error) {
      deepseekError = error;
    }
  }
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}&kl=ru-ru`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
  let ddgError = null;
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8' },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Поиск недоступен (${response.status})`);
    const html = await response.text();
    const results = [];
    const blockRe = /<a[^>]+class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>([\s\S]{0,900}?)(?=<a[^>]+class="result__a"|<\/body>)/g;
    let match;
    while ((match = blockRe.exec(html)) && results.length < limit) {
      let link = decodeEntities(match[1]);
      const uddg = link.match(/[?&]uddg=([^&]+)/);
      if (uddg) link = decodeURIComponent(uddg[1]);
      if (link.startsWith('//')) link = `https:${link}`;
      if (!/^https?:/.test(link)) continue;
      const title = htmlToText(match[2]).slice(0, 200);
      const snippetMatch = match[3].match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/);
      const snippet = snippetMatch ? htmlToText(snippetMatch[1]).slice(0, 400) : '';
      results.push({ title, url: link, snippet });
    }
    if (results.length) return results;
    ddgError = new Error('DuckDuckGo вернул пустую выдачу');
  } catch (error) {
    ddgError = error;
  } finally {
    clearTimeout(timer);
  }

  const errors = [deepseekError?.message, ddgError?.message].filter(Boolean);
  try {
    const results = await bingSearch(query, limit);
    if (results.length) return results;
    errors.push('Bing вернул пустую или нерелевантную выдачу');
  } catch (error) {
    errors.push(error.message);
  }

  try {
    const results = await newsSearch(query, limit);
    if (results.length) return results;
    errors.push('Лента новостей вернула пустую выдачу');
  } catch (error) {
    errors.push(error.message);
  }

  throw new Error(`Поиск недоступен: ${errors.join('; ')}`);
}

/** Несколько поисковых запросов подряд с объединением и дедупликацией выдачи. */
export async function searchMany(queries, { perQuery = 4 } = {}) {
  const list = [...new Set((Array.isArray(queries) ? queries : [queries]).map((q) => String(q).trim()).filter(Boolean))].slice(0, 4);
  if (!list.length) throw new Error('Нужен хотя бы один поисковый запрос');
  const settled = await Promise.allSettled(list.map((query) => webSearch(query, perQuery)));
  const seen = new Set();
  const results = [];
  const failures = [];
  settled.forEach((outcome, index) => {
    if (outcome.status !== 'fulfilled') {
      failures.push(`${list[index]}: ${outcome.reason?.message || outcome.reason}`);
      return;
    }
    for (const item of outcome.value) {
      if (seen.has(item.url)) continue;
      seen.add(item.url);
      results.push({ ...item, query: list[index] });
    }
  });
  return { queries: list, results, failures };
}
