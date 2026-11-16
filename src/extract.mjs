/**
 * Бесплатное извлечение статьи из HTML: Mozilla Readability (движок «Режима
 * чтения» Firefox) + Turndown для Markdown.
 *
 * Зачем: регулярки в search.mjs вытаскивают текст вместе с меню, баннерами и
 * подписями кнопок. Readability оставляет основной текст, Markdown сохраняет
 * заголовки, списки и таблицы — модели проще читать и цитировать.
 *
 * Readability иногда обрезает статью (например, у Википедии берёт только первый
 * раздел). Поэтому рядом считается полный текст смыслового контейнера; если
 * Readability потерял больше трети, отдаём полный вариант, а не половину статьи.
 */
/* jsdom, Readability и Turndown весят секунды на холодном старте: их импорт
   тянулся и в server.mjs через search.mjs → extract.mjs, поэтому сервис
   поднимался ~14 с. Разбор статьи нужен только в момент, когда статью реально
   достают, — грузим набор по требованию и один раз на процесс. */
/* Тяжёлый разбор идёт в отдельном потоке (см. parse-thread.mjs): в главном
   потоке он останавливал HTTP, сторожевой таймер и журнал. */
import { isMainThread } from 'node:worker_threads';
import { parseOffThread, parseThreadEnabled } from './parse-thread.mjs';

let parsersPromise = null;

function loadParsers() {
  if (!parsersPromise) {
    parsersPromise = (async () => {
      const [{ JSDOM }, { Readability }, turndown, gfmPlugin] = await Promise.all([
        import('jsdom'),
        import('@mozilla/readability'),
        import('turndown'),
        import('turndown-plugin-gfm'),
      ]);
      return {
        JSDOM,
        Readability,
        TurndownService: turndown.default,
        gfm: gfmPlugin.default.gfm,
      };
    })().catch((error) => {
      /* Неудача не должна отравлять процесс: следующая попытка грузит заново. */
      parsersPromise = null;
      throw error;
    });
  }
  return parsersPromise;
}

const MAX_MARKDOWN = 300000;
const FALLBACK_URL = 'https://example.invalid/';

/* Пределы размера страницы для тяжёлого разбора (jsdom + Readability + Turndown).
   Замер 16.11.2026 на этом коде: 0.55 МБ HTML → 8.6 с и 503 МБ RSS, 1 МБ → 18 с,
   2 МБ → 44 с, 4 МБ → нехватка памяти. Основная стоимость — Readability (10 с на
   контейнер в 287 КБ): она клонирует документ и склонна к квадратичной работе.
   В контейнере 0.25 ядра те же страницы идут в 3–5 раз дольше, поэтому здесь
   работают три предохранителя вместо одного:
     – служебные блоки (скрипты, стили, svg) вырезаются до jsdom: на живых
       страницах это половина и больше веса;
     – выше CLEAN_LIMIT_CHARS работает дешёвый разбор по регуляркам;
     – выше READABILITY_MAX_CHARS Readability не запускается вовсе, остаётся
       смысловой контейнер — он даёт почти тот же текст за секунды вместо минут. */
const MAX_DOM_CHARS = 700000;
const READABILITY_MAX_CHARS = 200000;
const TURNDOWN_MAX_CHARS = 400000;
/* Верхняя граница дешёвого разбора: держим в памяти не больше двух мегабайт
   текста страницы, остальное отбрасываем по границе. */
const CHEAP_MAX_CHARS = 2000000;

/** Вырезать служебные блоки до разбора: линейно, миллисекунды. */
export function stripJunkHtml(html) {
  return String(html || '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<template\b[\s\S]*?<\/template>/gi, ' ')
    .replace(/<svg\b[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<canvas\b[\s\S]*?<\/canvas>/gi, ' ')
    .replace(/<iframe\b[\s\S]*?<\/iframe>/gi, ' ');
}

/**
 * Вырезать смысловой блок страницы регулярками.
 *
 * Нужно, чтобы большая страница (книжная глава, статья с комментариями) всё же
 * прошла через полноценный разбор: обычно текст лежит в одном <article>/<main>,
 * и его одного хватает. Если блока нет, возвращается пустая строка.
 */
export function sliceMainContainer(html) {
  const source = String(html || '');
  if (!source) return '';
  const pairs = [
    [/<article\b[^>]*>/i, /<\/article\s*>/gi],
    [/<main\b[^>]*>/i, /<\/main\s*>/gi],
    [/<(div|section)\b[^>]*(?:entry-content|post-content|article-body|article-content|content-body|book-text|chapter)[^>]*>/i, /<\/div\s*>/gi],
    [/<div\b[^>]*\bid=["'](?:content|main|text)["'][^>]*>/i, /<\/div\s*>/gi],
  ];
  let best = '';
  for (const [openRe, closeRe] of pairs) {
    const openMatch = openRe.exec(source);
    if (!openMatch) continue;
    const start = openMatch.index;
    let end = -1;
    closeRe.lastIndex = start;
    for (let match = closeRe.exec(source); match; match = closeRe.exec(source)) end = match.index;
    if (end > start) {
      const slice = source.slice(start, end);
      if (slice.length > best.length) best = slice;
    }
  }
  return best;
}

const CONTAINER_SELECTORS = [
  'article',
  'main',
  '[role="main"]',
  '#mw-content-text',
  '.post-content',
  '.entry-content',
  '.article-content',
  '.article-body',
  '.content-body',
  '#content',
];

const JUNK_SELECTOR = [
  'script',
  'style',
  'noscript',
  'iframe',
  'svg',
  'canvas',
  'form',
  'nav',
  'aside',
  'footer',
  'body > header',
  '#header',
  '.site-header',
  '.page-header',
  '[role="navigation"]',
  '[role="banner"]',
  '[role="contentinfo"]',
  '.mw-editsection',
  '.toc',
  '#toc',
  '.navbox',
  '.catlinks',
  '.printfooter',
  '.mw-jump-link',
  '.noprint',
  '.advert',
  '.ads',
  '.advertisement',
  '.cookie',
  '.cookies',
  '.newsletter',
  '.subscribe',
  '.social',
  '.share',
  '.related',
  '.comments',
].join(', ');

function cleanText(value) {
  return String(value || '')
    .replace(/\u00a0/g, ' ')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Markdown чистим бережнее: отступы вложенных списков и цитат значимы. */
function cleanMarkdown(value) {
  return String(value || '')
    .replace(/\u00a0/g, ' ')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function absoluteUrl(raw, base) {
  const value = String(raw || '').trim();
  if (!value || /^(data|javascript|mailto|tel):/i.test(value)) return '';
  try {
    const url = new URL(value, base || FALLBACK_URL);
    return /^https?:$/.test(url.protocol) ? url.href : '';
  } catch {
    return '';
  }
}

/** Ссылки для человека: http(s), mailto и tel; javascript/data отбрасываем. */
function linkUrl(raw, base) {
  const value = String(raw || '').trim();
  if (/^(mailto|tel):/i.test(value)) return value;
  return absoluteUrl(value, base);
}

function metaContent(document, selectors) {
  for (const selector of selectors) {
    const node = document.querySelector(selector);
    const value = node?.getAttribute('content')?.trim();
    if (value) return value;
  }
  return '';
}

function readMeta(document) {
  return {
    title:
      metaContent(document, ['meta[property="og:title"]', 'meta[name="twitter:title"]']) ||
      cleanText(document.querySelector('title')?.textContent || ''),
    description: metaContent(document, [
      'meta[name="description"]',
      'meta[property="og:description"]',
      'meta[name="twitter:description"]',
    ]),
    siteName: metaContent(document, ['meta[property="og:site_name"]']),
    publishedTime: metaContent(document, [
      'meta[property="article:published_time"]',
      'meta[name="date"]',
      'meta[itemprop="datePublished"]',
    ]),
    author: metaContent(document, ['meta[name="author"]', 'meta[property="article:author"]']),
    lang: String(document.documentElement?.getAttribute('lang') || '').slice(0, 12),
  };
}

function makeTurndown({ TurndownService, gfm }) {
  const service = new TurndownService({
    headingStyle: 'atx',
    hr: '---',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
    emDelimiter: '_',
    strongDelimiter: '**',
    linkStyle: 'inlined',
  });
  service.use(gfm);
  service.remove(['script', 'style', 'noscript', 'iframe', 'form', 'button', 'svg', 'canvas']);
  service.addRule('cleanImage', {
    filter: 'img',
    replacement: (_content, node) => {
      const src = node.getAttribute('src') || '';
      if (!src) return '';
      const alt = cleanText(node.getAttribute('alt') || '').replace(/[[\]]/g, '');
      return `![${alt}](${src})`;
    },
  });
  return service;
}

/** Смысловой контейнер страницы: самый длинный из подходящих. */
function pickContainer(document) {
  for (const selector of CONTAINER_SELECTORS) {
    let nodes = [];
    try {
      nodes = [...document.querySelectorAll(selector)];
    } catch {
      continue;
    }
    const candidates = nodes
      .map((node) => ({ node, length: cleanText(node.textContent).length }))
      .filter((item) => item.length > 200)
      .sort((a, b) => b.length - a.length);
    if (candidates.length) return candidates[0].node;
  }
  return document.body || document.documentElement;
}

function absolutize(root, baseUrl) {
  for (const link of root.querySelectorAll('a[href]')) {
    const href = linkUrl(link.getAttribute('href'), baseUrl);
    if (href) link.setAttribute('href', href);
    else link.removeAttribute('href');
  }
  for (const image of root.querySelectorAll('img')) {
    const src = imageSource(image, baseUrl);
    if (src) image.setAttribute('src', src);
    else image.remove();
  }
}

/** Ленивые картинки: src часто пустой/заглушка, настоящий адрес — в data-src/srcset. */
function imageSource(image, baseUrl) {
  const src = String(image.getAttribute('src') || '').trim();
  const lazy = String(
    image.getAttribute('data-src') ||
    image.getAttribute('data-original') ||
    image.getAttribute('data-lazy-src') ||
    '',
  ).trim();
  const placeholder = !src || /^data:/i.test(src) || /(?:blank|spacer|transparent|pixel|1x1)[^/]*$/i.test(src);
  const chosen = placeholder && lazy ? lazy : src || lazy;
  const set = String(image.getAttribute('srcset') || image.getAttribute('data-srcset') || '').trim();
  const fromSet = set.split(',')[0]?.trim().split(/\s+/)[0] || '';
  return absoluteUrl(chosen, baseUrl) || absoluteUrl(fromSet, baseUrl);
}

/** Учитывает <base href>: относительные ссылки считаются от него, а не от URL страницы. */
function pageBase(document, fallback) {
  try {
    const href = document.baseURI;
    if (href && !/^about:/i.test(href)) return href;
  } catch {
    /* ниже — запасной вариант */
  }
  return fallback || FALLBACK_URL;
}

/** Текст с переносами на границах блоков: textContent сам их не ставит. */
function blockText(root) {
  const clone = root.cloneNode(true);
  const document = clone.ownerDocument;
  for (const br of clone.querySelectorAll('br')) {
    br.replaceWith(document.createTextNode('\n'));
  }
  for (const node of clone.querySelectorAll(
    'p, div, li, tr, h1, h2, h3, h4, h5, h6, section, article, blockquote, pre, table, ul, ol, figure',
  )) {
    node.append(document.createTextNode('\n'));
  }
  return cleanText(clone.textContent);
}

function headingsFrom(root) {
  const seen = new Set();
  const headings = [];
  for (const node of root.querySelectorAll('h1, h2, h3, h4')) {
    const text = cleanText(node.textContent).slice(0, 200);
    if (!text) continue;
    const level = Number(node.tagName.slice(1)) || 2;
    const key = `${level}:${text.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    headings.push({ level, text });
    if (headings.length >= 80) break;
  }
  return headings;
}

function tablesFrom(root) {
  const tables = [];
  for (const table of [...root.querySelectorAll('table')].slice(0, 6)) {
    const rows = [];
    for (const row of [...table.querySelectorAll('tr')].slice(0, 60)) {
      const cells = [...row.querySelectorAll('th, td')]
        .slice(0, 12)
        .map((cell) => cleanText(cell.textContent).slice(0, 240));
      if (cells.some(Boolean)) rows.push(cells);
    }
    if (rows.length) tables.push(rows);
  }
  return tables;
}

function linksFrom(root, baseUrl) {
  const seen = new Set();
  const links = [];
  for (const anchor of root.querySelectorAll('a[href]')) {
    const href = linkUrl(anchor.getAttribute('href'), baseUrl);
    if (!href || seen.has(href)) continue;
    seen.add(href);
    links.push({ href, text: cleanText(anchor.textContent).slice(0, 160) });
    if (links.length >= 120) break;
  }
  return links;
}

function linkDensity(text, links) {
  if (!text.length) return 0;
  const linked = links.reduce((sum, link) => sum + Math.min(link.text.length, 120), 0);
  return linked / text.length;
}

/**
 * Разбирает HTML в статью. Всегда возвращает результат, даже на битой разметке.
 *
 * Это «тяжёлый» вариант: jsdom + Readability + Turndown. Вызывать его можно
 * только в отдельном потоке разбора — в главном он останавливает сервис.
 */
export async function extractReadableLocal(html, baseUrl, { maxChars = 0 } = {}) {
  const raw = String(html || '');
  const limit = Number(maxChars) > 0 ? Math.min(Number(maxChars), MAX_MARKDOWN) : 0;
  const { JSDOM, Readability, TurndownService, gfm } = await loadParsers();
  const turndown = () => makeTurndown({ TurndownService, gfm });
  let dom;
  try {
    dom = new JSDOM(raw, { url: baseUrl || FALLBACK_URL });
  } catch {
    return empty('empty');
  }
  const document = dom.window.document;
  const meta = readMeta(document);
  const docBase = pageBase(document, baseUrl);

  /* Полный вариант: смысловой контейнер без навигации и рекламы. */
  let full = null;
  try {
    const container = pickContainer(document);
    for (const node of container.querySelectorAll(JUNK_SELECTOR)) node.remove();
    absolutize(container, docBase);
    const mainHtml = container.innerHTML;
    full = {
      text: blockText(container),
      /* Turndown на мегабайтном контейнере добавляет секунды и память, а модели
         нужен прежде всего текст. Markdown для больших страниц собирается из
         текста — ниже. */
      markdown:
        mainHtml.length > TURNDOWN_MAX_CHARS ? '' : turndown().turndown(mainHtml),
      headings: headingsFrom(container),
      tables: tablesFrom(container),
      links: linksFrom(container, docBase),
    };
  } catch {
    full = null;
  }

  /* Readability — на клоне, чтобы не портить исходный документ. На больших
     контейнерах её не запускаем: замер 16.11.2026 — 10 с и 383 МБ heap на
     контейнер в 287 КБ, и это ещё без клона документа. Смысловой контейнер
     даёт почти тот же текст за секунды. */
  const containerChars = full ? full.text.length : 0;
  const allowReadability = raw.length <= READABILITY_MAX_CHARS && containerChars <= READABILITY_MAX_CHARS;
  let article = null;
  if (allowReadability) {
    try {
      article = new Readability(document.cloneNode(true), {
        charThreshold: 250,
        keepClasses: false,
        disableJSONLD: false,
        nbTopCandidates: 6,
      }).parse();
    } catch {
      article = null;
    }
  }

  let chosen = null;
  let engine = 'dom';
  if (article && cleanText(article.textContent).length >= 250) {
    let articleDom = null;
    try {
      articleDom = new JSDOM(String(article.content || ''), { url: docBase || FALLBACK_URL });
      const root = articleDom.window.document.body;
      for (const node of root.querySelectorAll(JUNK_SELECTOR)) node.remove();
      absolutize(root, docBase);
      const articleHtml = root.innerHTML;
      const candidate = {
        text: blockText(root),
        markdown: turndown().turndown(articleHtml),
        headings: headingsFrom(root),
        tables: tablesFrom(root),
        links: linksFrom(root, docBase),
      };
      if (candidate.text.length >= 200) {
        chosen = candidate;
        engine = 'readability';
      }
    } catch {
      chosen = null;
    } finally {
      articleDom?.window.close();
    }
  }

  /* Readability потерял кусок статьи — берём полный контейнер. */
  if (chosen && full) {
    const ratio = full.text.length / Math.max(1, chosen.text.length);
    const density = linkDensity(full.text, full.links);
    if (ratio > 1.5 && density < 0.25 && full.text.length > 800) {
      chosen = full;
      engine = 'dom-full';
    }
  }
  if (!chosen) {
    chosen = full || { text: '', markdown: '', headings: [], tables: [], links: [] };
    engine = 'dom';
  }

  dom.window.close();

  let text = cleanText(chosen.text);
  let markdown = cleanMarkdown(chosen.markdown);
  if (!markdown) markdown = text;
  if (limit) {
    if (text.length > limit) text = text.slice(0, limit);
    if (markdown.length > limit) markdown = markdown.slice(0, limit);
  }

  return {
    engine,
    title: cleanText(article?.title || meta.title || '').slice(0, 300),
    description: cleanText(article?.excerpt || meta.description || '').slice(0, 600),
    byline: cleanText(article?.byline || meta.author || '').slice(0, 200),
    siteName: meta.siteName,
    publishedTime: meta.publishedTime,
    lang: meta.lang,
    text,
    markdown,
    headings: chosen.headings,
    tables: chosen.tables,
    links: chosen.links,
    chars: text.length,
    markdownChars: markdown.length,
  };
}

function empty(engine) {
  return {
    engine,
    title: '',
    description: '',
    byline: '',
    siteName: '',
    publishedTime: '',
    lang: '',
    text: '',
    markdown: '',
    headings: [],
    tables: [],
    links: [],
    chars: 0,
    markdownChars: 0,
  };
}

/* --- Дешёвый разбор: регулярки вместо DOM --- */

const ENTITIES = {
  nbsp: ' ',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  laquo: '«',
  raquo: '»',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  copy: '©',
  reg: '®',
  trade: '™',
};

function decodeEntitiesBasic(value) {
  return String(value || '').replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    const named = ENTITIES[body.toLowerCase()];
    return named === undefined ? match : named;
  });
}

/**
 * Разбор без DOM: чистим разметку регулярками и берём текст.
 *
 * Нужен для больших страниц (интернет-магазины, книги, архивы), где jsdom
 * съедает десятки секунд или падает по памяти. Текст выходит грубее — вместе
 * с меню и подписями, — зато страница не останавливает сервис.
 */
export function cheapReadable(html, baseUrl, { maxChars = 0 } = {}) {
  const limit = Number(maxChars) > 0 ? Math.min(Number(maxChars), MAX_MARKDOWN) : 0;
  let raw = String(html || '').slice(0, CHEAP_MAX_CHARS);
  if (!raw) return empty('regex-big');

  const meta = {
    title: '',
    description: '',
    author: '',
    siteName: '',
    publishedTime: '',
    lang: '',
  };
  for (const [key, patterns] of [
    ['title', [/<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']*)["']/i, /<meta[^>]+name=["']twitter:title["'][^>]*content=["']([^"']*)["']/i]],
    [
      'description',
      [
        /<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)["']/i,
        /<meta[^>]+property=["']og:description["'][^>]*content=["']([^"']*)["']/i,
      ],
    ],
    [
      'author',
      [/<meta[^>]+name=["']author["'][^>]*content=["']([^"']*)["']/i, /<meta[^>]+property=["']article:author["'][^>]*content=["']([^"']*)["']/i],
    ],
    ['siteName', [/<meta[^>]+property=["']og:site_name["'][^>]*content=["']([^"']*)["']/i]],
    ['publishedTime', [/<meta[^>]+property=["']article:published_time["'][^>]*content=["']([^"']*)["']/i]],
  ]) {
    for (const pattern of patterns) {
      const found = raw.match(pattern);
      if (found) {
        meta[key] = decodeEntitiesBasic(found[1]).trim();
        break;
      }
    }
  }
  const langMatch = raw.match(/<html[^>]+lang=["']([^"']+)["']/i);

  /* Служебные блоки вырезаем целиком: в них больше всего мусора. */
  const cleaned = stripJunkHtml(raw);

  const title =
    meta.title ||
    (cleaned.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '') ||
    (cleaned.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ?? '');

  const headings = [];
  const seen = new Set();
  for (const match of cleaned.matchAll(/<h([1-4])[^>]*>([\s\S]*?)<\/h\1>/gi)) {
    const text = cleanText(decodeEntitiesBasic(match[2].replace(/<[^>]+>/g, ' '))).slice(0, 200);
    if (!text) continue;
    const level = Number(match[1]) || 2;
    const key = `${level}:${text.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    headings.push({ level, text });
    if (headings.length >= 80) break;
  }

  const links = [];
  const seenLinks = new Set();
  for (const match of cleaned.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const href = linkUrl(decodeEntitiesBasic(match[1]), baseUrl);
    if (!href || seenLinks.has(href)) continue;
    seenLinks.add(href);
    links.push({ href, text: cleanText(decodeEntitiesBasic(match[2].replace(/<[^>]+>/g, ' '))).slice(0, 160) });
    if (links.length >= 120) break;
  }

  const text = cleanText(
    decodeEntitiesBasic(
      cleaned
        .replace(/<\/(p|div|li|tr|h[1-6]|section|article|blockquote|pre|table|ul|ol|figure)>/gi, '\n')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<[^>]+>/g, ' '),
    ),
  );

  let outText = text;
  let markdown = text;
  if (limit) {
    if (outText.length > limit) outText = outText.slice(0, limit);
    if (markdown.length > limit) markdown = markdown.slice(0, limit);
  }

  return {
    engine: 'regex-big',
    title: cleanText(decodeEntitiesBasic(title)).slice(0, 300),
    description: cleanText(meta.description).slice(0, 600),
    byline: cleanText(meta.author || meta.siteName).slice(0, 200),
    siteName: cleanText(meta.siteName),
    publishedTime: cleanText(meta.publishedTime),
    lang: String(langMatch?.[1] || '').slice(0, 12),
    text: outText,
    markdown,
    headings,
    tables: [],
    links,
    chars: outText.length,
    markdownChars: markdown.length,
  };
}

/**
 * Публичный разбор страницы: выбирает место работы так, чтобы главный поток
 * никогда не вставал на секунды.
 *
 *  1. Служебные блоки (скрипты, стили, svg) вырезаются регулярками — это
 *     миллисекунды и часто половина веса страницы.
 *  2. Если после очистки осталось больше MAX_DOM_CHARS — дешёвый разбор по
 *     регуляркам (линейный, доли секунды).
 *  3. Иначе страница уходит в отдельный поток разбора.
 *  4. Внутри потока разбора — тяжёлый разбор на месте (иначе бесконечная
 *     рекурсия), но с отключённой Readability на больших контейнерах.
 *
 * Любая неудача потока (время, память, падение) не роняет задачу: страница
 * разбирается дешёвым способом, а причина уходит в журнал.
 */
export async function extractReadable(html, baseUrl, options = {}) {
  const raw = String(html || '');
  if (!raw) return empty('empty');
  const cleaned = stripJunkHtml(raw);
  /* Большая страница: пробуем вырезать смысловой блок и разобрать только его —
     так сохраняется качество Readability. Если блока нет, работает дешёвый
     разбор по регуляркам. */
  let target = cleaned;
  if (cleaned.length > MAX_DOM_CHARS) {
    const core = sliceMainContainer(cleaned);
    if (core.length > 2000 && core.length <= MAX_DOM_CHARS) {
      target = core;
      console.log(
        `[parse] страница ${(raw.length / 1024 / 1024).toFixed(1)} МБ: взят смысловой блок ` +
          `${(core.length / 1024).toFixed(0)} КБ и разбирается с DOM`,
      );
    } else {
      const started = Date.now();
      const result = cheapReadable(cleaned, baseUrl, options);
      console.log(
        `[parse] страница ${(raw.length / 1024 / 1024).toFixed(1)} МБ (без служебных блоков ` +
          `${(cleaned.length / 1024).toFixed(0)} КБ) — быстрый разбор без DOM, ` +
          `${Date.now() - started} мс, текста ${result.chars}`,
      );
      return result;
    }
  }
  if (!isMainThread || !parseThreadEnabled()) return extractReadableLocal(target, baseUrl, options);
  const startedAt = Date.now();
  try {
    const result = await parseOffThread(
      { kind: 'readable', html: target, baseUrl, options },
      { timeoutMs: 45000 },
    );
    const spent = Date.now() - startedAt;
    if (result.chars < 500 && target !== cleaned) {
      console.warn('[parse] в смысловом блоке почти нет текста — разбираю страницу без DOM');
      return cheapReadable(cleaned, baseUrl, options);
    }
    if (spent > 3000) {
      console.log(
        `[parse] страница ${(target.length / 1024).toFixed(0)} КБ разобрана в потоке за ${spent} мс ` +
          `(${result.engine}, текста ${result.chars})`,
      );
    }
    return result;
  } catch (error) {
    console.warn(
      `[parse] разбор в потоке не удался (${String(error?.message || error)}) — беру быстрый разбор, ` +
        `страница ${(raw.length / 1024).toFixed(0)} КБ`,
    );
    return cheapReadable(cleaned, baseUrl, options);
  }
}

/**
 * Поля по CSS-селекторам: `{ price: ".price", link: "a.buy@href" }`.
 * `@attr` в конце селектора берёт атрибут вместо текста.
 * Несколько совпадений — массив, одно — строка.
 *
 * Публичная версия: большую страницу разбираем в отдельном потоке, иначе
 * выборка полей вставала бы в главном потоке так же, как разбор статьи.
 */
export async function extractFields(html, baseUrl, selectors) {
  const raw = stripJunkHtml(String(html || ''));
  if (raw.length > 200000 && isMainThread && parseThreadEnabled()) {
    try {
      return await parseOffThread(
        { kind: 'fields', html: raw, baseUrl, selectors },
        { timeoutMs: 45000 },
      );
    } catch (error) {
      console.warn(`[parse] выборка полей в потоке не удалась (${String(error?.message || error)})`);
      return extractFieldsLocal(raw.slice(0, MAX_DOM_CHARS), baseUrl, selectors);
    }
  }
  return extractFieldsLocal(raw.slice(0, MAX_DOM_CHARS), baseUrl, selectors);
}

/** Тяжёлый вариант выборки полей — только в потоке разбора. */
export async function extractFieldsLocal(html, baseUrl, selectors) {
  const { JSDOM } = await loadParsers();
  const dom = new JSDOM(String(html || ''), { url: baseUrl || FALLBACK_URL });
  const document = dom.window.document;
  const docBase = pageBase(document, baseUrl);
  const result = Object.create(null);
  for (const [rawKey, rawSelector] of Object.entries(selectors || {}).slice(0, 40)) {
    const key = String(rawKey || '').slice(0, 80);
    let selector = String(rawSelector || '').trim();
    if (!key || !selector) continue;
    let attribute = '';
    const at = selector.lastIndexOf('@');
    if (at > 0 && /^[a-z][\w-]*$/i.test(selector.slice(at + 1))) {
      attribute = selector.slice(at + 1).trim().toLowerCase();
      selector = selector.slice(0, at).trim();
    }
    let nodes;
    try {
      nodes = [...document.querySelectorAll(selector)];
    } catch {
      result[key] = { error: `Некорректный селектор: ${selector}` };
      continue;
    }
    const values = [];
    for (const node of nodes.slice(0, 25)) {
      let value;
      if (attribute) {
        value = node.getAttribute(attribute) || '';
        if (['href', 'action'].includes(attribute)) {
          value = linkUrl(value, docBase) || value;
        } else if (attribute === 'src') {
          value = absoluteUrl(value, docBase) || value;
        }
      } else {
        value = cleanText(node.textContent);
      }
      value = String(value).trim().slice(0, 2000);
      if (value && !values.includes(value)) values.push(value);
    }
    result[key] = values.length <= 1 ? values[0] || '' : values;
  }
  dom.window.close();
  return result;
}
