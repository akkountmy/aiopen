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
import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import TurndownService from 'turndown';
import gfmPlugin from 'turndown-plugin-gfm';

const { gfm } = gfmPlugin;

const MAX_MARKDOWN = 300000;
const FALLBACK_URL = 'https://example.invalid/';

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

function makeTurndown() {
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
 */
export function extractReadable(html, baseUrl, { maxChars = 0 } = {}) {
  const raw = String(html || '');
  const limit = Number(maxChars) > 0 ? Math.min(Number(maxChars), MAX_MARKDOWN) : 0;
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
      markdown: makeTurndown().turndown(mainHtml),
      headings: headingsFrom(container),
      tables: tablesFrom(container),
      links: linksFrom(container, docBase),
    };
  } catch {
    full = null;
  }

  /* Вариант Readability — на клоне, чтобы не портить исходный документ. */
  let article = null;
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
        markdown: makeTurndown().turndown(articleHtml),
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

/**
 * Поля по CSS-селекторам: `{ price: ".price", link: "a.buy@href" }`.
 * `@attr` в конце селектора берёт атрибут вместо текста.
 * Несколько совпадений — массив, одно — строка.
 */
export function extractFields(html, baseUrl, selectors) {
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
