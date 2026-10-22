import { extractDocumentText } from './docparse.mjs';
import { truncate } from './util.mjs';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const MAX_BYTES = 12 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 30000;
const SEARCH_TIMEOUT_MS = 20000;
/* Локальные и служебные адреса из облака недоступны: сервис работает на общем
   хосте, и запрос к 127.0.0.1 или к метаданным хостинга — это попытка пройти
   внутрь инфраструктуры. Страницы пользователя ходят только по публичным IP. */
const PRIVATE_NET =
  /^(localhost|.+\.localhost|0\.0\.0\.0|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?$)/i;
const SKIP_EXT = /\.(png|jpe?g|gif|svg|webp|ico|bmp|zip|rar|7z|gz|mp4|mp3|avi|mov|woff2?|ttf|eot|exe|dmg|apk)(\?|#|$)/i;

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

/** Проверяет ссылку и возвращает её объект; локальные адреса запрещены. */
export function assertPublicUrl(raw) {
  let url;
  try {
    url = new URL(String(raw).trim());
  } catch {
    throw new Error('Некорректная ссылка: нужен полный адрес вида https://…');
  }
  if (!/^https?:$/.test(url.protocol)) throw new Error('Разрешены только ссылки http:// и https://');
  const host = url.hostname.toLowerCase();
  /* Для локальной установки, где сервис сам ходит в свои микросервисы, запрет
     снимается явным флагом окружения. В облаке флаг не выставляется. */
  const allowPrivate = process.env.DSHOW_ALLOW_PRIVATE_FETCH === '1';
  if (!allowPrivate && PRIVATE_NET.test(host)) throw new Error('Локальные и служебные адреса недоступны из облака');
  return url;
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
 * ссылки и очищенный текст. Работает без браузера — разбирает HTML регулярками
 * и выкидывает навигацию, скрипты и подвалы.
 */
export async function readPage(rawUrl, { maxChars = 32000 } = {}) {
  const url = assertPublicUrl(rawUrl);
  const page = await requestPage(url.href, { accept: 'text/html,application/xhtml+xml,*/*;q=0.5' });
  if (page.kind !== 'html') {
    return { url: page.url, kind: page.kind, title: '', text: truncate(page.text, maxChars), tables: [], links: [], headings: [] };
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
    links: extractLinks(html, page.url, url.origin),
    text: truncate(text, maxChars),
    chars: text.length,
  };
}

/** Один HTTP-запрос с разбором кодировки и типа содержимого. */
async function requestPage(rawUrl, { method = 'GET', headers = {}, body = null, timeoutMs = FETCH_TIMEOUT_MS, accept } = {}) {
  const url = assertPublicUrl(rawUrl);
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
    const response = await fetch(url, {
      method: upper,
      headers: requestHeaders,
      body: upper === 'GET' || upper === 'HEAD' ? undefined : body ?? undefined,
      redirect: 'follow',
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

/** Загружает страницу и приводит её к тексту. */
export async function fetchUrl(url, { maxChars = 24000, method = 'GET', headers = {}, body = null } = {}) {
  const page = await requestPage(url, { method, headers, body });
  const text = page.kind === 'html' ? htmlToText(page.text) : page.text;
  return {
    url: page.url,
    kind: page.kind,
    status: page.status,
    contentType: page.contentType,
    title: page.kind === 'html' ? extractTitle(page.text) : (text.match(/^.{0,120}/) || [''])[0].trim(),
    text: truncate(text, maxChars),
    bytes: page.bytes,
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
  const origin = start.origin;
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
        if (SKIP_EXT.test(link.href)) continue;
        if (seen.has(link.href)) continue;
        if (pages.length + queue.length >= pagesLimit * 3) break;
        seen.add(link.href);
        queue.push({ url: link.href, depth: item.depth + 1 });
      }
    }
  }
  return { start: start.href, pages: pages.slice(0, pagesLimit), found: seen.size };
}

/** Поиск в интернете без ключей. Возвращает [{ title, url, snippet }]. */
export async function webSearch(query, limit = 6) {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}&kl=ru-ru`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
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
    return results;
  } finally {
    clearTimeout(timer);
  }
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
