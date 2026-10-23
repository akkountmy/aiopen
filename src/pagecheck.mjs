/**
 * Проверка страницы по коду — то, что видно без браузера.
 *
 * Нужна там, где Chromium не запускается (облачное окружение Amvera без Docker):
 * структура, парность тегов, кавычки, ссылки, alt, внешние запросы и фиксированные
 * ширины ловятся разбором самого файла. Горизонтальную прокрутку и ошибки консоли
 * так не увидеть — поэтому отчёт честно делит проверки на «по коду» и «только
 * браузером», а не делает вид, что страница осмотрена глазами.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVICE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAX_HTML = 4 * 1024 * 1024;

const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr',
]);
const RAW_TAGS = new Set(['script', 'style', 'textarea']);
const SKIP_SCHEMES = /^(?:#|data:|mailto:|tel:|javascript:|blob:|about:|file:)/i;

function stripComments(html) {
  return html.replace(/<!--[\s\S]*?-->/g, '');
}

function textOf(fragment) {
  return String(fragment || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&laquo;/g, '«')
    .replace(/&raquo;/g, '»')
    .replace(/&mdash;/g, '—')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseAttrs(attrText) {
  const attrs = Object.create(null);
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  let match;
  while ((match = re.exec(attrText))) attrs[match[1].toLowerCase()] = match[3] ?? match[4] ?? match[5] ?? '';
  return attrs;
}

/**
 * Парность тегов и кавычек. Полноценный HTML-парсер здесь не нужен: задача —
 * поймать забытый </div>, лишний закрывающий тег и оборванный атрибут.
 */
function scanTags(source) {
  const unclosed = [];
  const mismatched = [];
  const quoteIssues = [];
  const stack = [];
  const re = /<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;
  let match;
  while ((match = re.exec(source))) {
    const closing = match[1] === '/';
    const name = match[2].toLowerCase();
    const attrText = match[3] || '';
    if (!closing) {
      const quotes = (attrText.match(/"/g) || []).length;
      const singles = (attrText.match(/'/g) || []).length;
      if (quotes % 2 === 1 || singles % 2 === 1) {
        quoteIssues.push(`<${name}${attrText.slice(0, 60)}> — незакрытая кавычка в атрибуте`);
      }
    }
    if (closing) {
      if (!stack.length) {
        mismatched.push(`</${name}> — закрывает тег, которого не открывали`);
        continue;
      }
      const top = stack[stack.length - 1];
      if (top === name) {
        stack.pop();
      } else {
        const index = stack.lastIndexOf(name);
        if (index >= 0) {
          mismatched.push(`</${name}> — внутри не закрыт ${stack.slice(index + 1).join(', ')}`);
          stack.length = index;
        } else {
          mismatched.push(`</${name}> — без открывающего тега`);
        }
      }
      continue;
    }
    const selfClosing = match[4] === '/' || VOID_TAGS.has(name);
    if (selfClosing) continue;
    if (RAW_TAGS.has(name)) {
      /* Содержимое script/style/textarea — не разметка: перепрыгиваем его
         вместе с закрывающим тегом, иначе код внутри ломает счётчик. */
      const close = new RegExp(`</${name}\\s*>`, 'i');
      const rest = source.slice(re.lastIndex);
      const found = rest.search(close);
      if (found >= 0) {
        const tail = rest.slice(found).match(close)[0];
        re.lastIndex += found + tail.length;
      }
      continue;
    }
    stack.push(name);
  }
  unclosed.push(...stack);
  return {
    unclosedTags: [...new Set(unclosed)],
    mismatchedTags: mismatched.slice(0, 10),
    quoteIssues: quoteIssues.slice(0, 10),
  };
}

function collectRefs(source) {
  const refs = [];
  const re = /<(a|img|link|script|source|video|audio|iframe|form)\b([^>]*)>/gi;
  let match;
  while ((match = re.exec(source))) {
    const tag = match[1].toLowerCase();
    const attrs = parseAttrs(match[2]);
    const value = attrs.src || attrs.href || attrs.poster || attrs.action;
    if (!value) continue;
    refs.push({ tag, value: value.trim(), alt: Object.prototype.hasOwnProperty.call(attrs, 'alt'), altValue: attrs.alt });
  }
  return refs;
}

/** Абсолютные адреса внутри CSS: фон, шрифт, импорт. */
function collectCssRefs(source) {
  const urls = [];
  const re = /url\(\s*["']?([^)"']+)["']?\s*\)/g;
  let match;
  while ((match = re.exec(source))) urls.push(match[1].trim());
  const imports = [...source.matchAll(/@import\s+(?:url\()?\s*["']([^"']+)["']/g)].map((item) => item[1]);
  return [...urls, ...imports];
}

function styleBlocks(source) {
  return [...source.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((item) => item[1]);
}

/** Ширины, из-за которых страница не помещается в телефон. */
function fixedWidths(source) {
  const found = [];
  for (const css of styleBlocks(source)) {
    for (const block of css.split('}')) {
      const width = block.match(/(?<![-\w])width\s*:\s*(\d{3,4})\s*px/i);
      if (!width || Number(width[1]) < 480) continue;
      if (/max-width/i.test(block)) continue;
      const selector = block.split('{')[0].trim().slice(0, 60);
      found.push(`${selector || 'style'} — width: ${width[1]}px без max-width`);
    }
  }
  for (const match of source.matchAll(/style\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
    const css = match[1] ?? match[2] ?? match[3] ?? '';
    const width = css.match(/(?<![-\w])width\s*:\s*(\d{3,4})\s*px/i);
    if (!width || Number(width[1]) < 480 || /max-width/i.test(css)) continue;
    found.push(`атрибут style — width: ${width[1]}px без max-width`);
  }
  return [...new Set(found)].slice(0, 8);
}

function resolveLocalFile(ref, { root, file }) {
  if (!file) return null;
  const clean = ref.split('#')[0].split('?')[0];
  if (!clean) return null;
  let decoded = clean;
  try {
    decoded = decodeURIComponent(clean);
  } catch {
    /* битый процентный код — оставляем как есть */
  }
  const baseDir = path.dirname(file);
  const candidates = decoded.startsWith('/')
    ? [path.join(root || baseDir, decoded.replace(/^\/+/, ''))]
    : [path.resolve(baseDir, decoded)];
  return candidates[0] || null;
}

/**
 * Разбор страницы по коду. Ничего не бросает: любой файл даёт отчёт, даже
 * обрывок разметки.
 *
 * @param {string} html исходник страницы
 * @param {{root?: string, file?: string}} options проект и путь к файлу (для проверки локальных ссылок)
 */
export function staticPageChecks(html, options = {}) {
  const root = options.root ? path.resolve(options.root) : null;
  const file = options.file ? path.resolve(options.file) : null;
  const source = String(html || '').slice(0, MAX_HTML);
  const clean = stripComments(source);

  const titleMatch = clean.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const htmlTag = clean.match(/<html\b([^>]*)>/i);
  const lang = htmlTag ? (parseAttrs(htmlTag[1]).lang || '') : '';
  const doctype = /^\s*<!doctype\s+html/i.test(source);
  const charset = /<meta\b[^>]*charset\s*=/i.test(clean);
  const viewport = /<meta\b[^>]*name\s*=\s*["']?viewport/i.test(clean);

  const headings = [];
  for (const match of clean.matchAll(/<(h[1-3])\b[^>]*>([\s\S]*?)<\/\1>/gi)) {
    headings.push({ level: Number(match[1][1]), text: textOf(match[2]).slice(0, 120) });
  }
  const h1 = headings.find((item) => item.level === 1) || null;

  const refs = collectRefs(clean);
  const cssRefs = collectCssRefs(clean);

  const images = refs.filter((item) => item.tag === 'img');
  const imagesWithoutAlt = images.filter((item) => !item.alt).map((item) => item.value).slice(0, 10);
  const imagesWithoutSrc = images.filter((item) => !item.value).length;

  const external = [];
  const local = [];
  for (const ref of [...refs.map((item) => item.value), ...cssRefs]) {
    if (!ref || SKIP_SCHEMES.test(ref)) continue;
    if (/^[a-z][a-z0-9+.-]*:/i.test(ref) || ref.startsWith('//')) {
      if (/^(?:https?:)?\/\//i.test(ref)) external.push(ref);
      continue;
    }
    local.push(ref);
  }
  const missingLocal = [];
  for (const ref of [...new Set(local)]) {
    const target = resolveLocalFile(ref, { root, file });
    if (!target) continue;
    const insideRoot = root ? target === root || target.startsWith(root + path.sep) : true;
    if (!insideRoot) {
      missingLocal.push(`${ref} — ссылка выходит за папку проекта`);
      continue;
    }
    if (!fs.existsSync(target)) missingLocal.push(`${ref} — файла нет в проекте`);
  }

  const tags = scanTags(clean);
  const hasErrorPlaque = /addEventListener\(\s*["']error["']|\.onerror\s*=/i.test(clean);
  const scripts = [...clean.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)];
  const scriptsWithSrc = [...clean.matchAll(/<script\b[^>]*\bsrc\s*=/gi)].length;

  return {
    chars: source.length,
    title: textOf(titleMatch?.[1] || ''),
    lang,
    doctype,
    charset,
    viewport,
    h1: h1 ? h1.text : '',
    headings: headings.slice(0, 12),
    images: { total: images.length, withoutAlt: imagesWithoutAlt.length, withoutSrc: imagesWithoutSrc, examples: imagesWithoutAlt },
    external: [...new Set(external)].slice(0, 10),
    externalCount: [...new Set(external)].length,
    localRefs: [...new Set(local)].length,
    missingLocal: missingLocal.slice(0, 10),
    fixedWidths: fixedWidths(clean),
    inlineScripts: scripts.length,
    externalScripts: scriptsWithSrc,
    hasErrorPlaque,
    ...tags,
  };
}

/** Готовый каркас страницы: hero, числа, карточки, таблица, адаптив, плашка ошибок. */
export function pageTemplate() {
  const file = path.join(SERVICE_ROOT, 'templates', 'page.html');
  if (!fs.existsSync(file)) throw new Error('Шаблон страницы не найден в сервисе — сообщите администратору.');
  return fs.readFileSync(file, 'utf8');
}

/** Сколько замечаний даёт разбор по коду — одной строкой для телеметрии. */
export function staticIssueCount(facts) {
  return [
    facts.h1 ? 0 : 1,
    facts.images.withoutAlt,
    facts.externalCount,
    facts.missingLocal.length,
    facts.fixedWidths.length,
    facts.unclosedTags.length + facts.mismatchedTags.length,
  ].reduce((sum, item) => sum + item, 0);
}

/** Мелочи, которые не ломают страницу, но которые стоит поправить. */
export function staticNotes(facts) {
  const notes = [];
  if (!facts.doctype) notes.push('нет <!doctype html> — браузер включит режим совместимости');
  if (facts.lang !== 'ru') notes.push(`язык страницы: ${facts.lang || 'не указан'} (ожидался ru)`);
  if (!facts.viewport) notes.push('нет meta viewport — телефон покажет уменьшенную копию страницы');
  if (!facts.charset) notes.push('нет meta charset — возможны кракозябры в кириллице');
  if (!facts.hasErrorPlaque) notes.push('нет плашки ошибок (window.onerror) — поломка останется молчаливой');
  return notes;
}

/**
 * Текст отчёта «по коду»: сначала то, что сломает страницу, потом мелочи.
 * Браузерные проверки сюда не входят — о них отдельно.
 */
export function describeStatic(facts) {
  const rows = [];
  const add = (state, text, details = []) => rows.push({ state, text, details });

  add(facts.h1 ? 'ok' : 'fail', facts.h1 ? `h1 на месте: «${facts.h1}»` : 'h1 отсутствует — не видно, о чём страница');

  if (facts.images.total) {
    if (facts.images.withoutAlt) {
      add('fail', `картинки без alt: ${facts.images.withoutAlt} из ${facts.images.total}`, facts.images.examples);
    } else {
      add('ok', `у всех картинок есть alt (${facts.images.total})`);
    }
  }

  add(
    facts.externalCount ? 'fail' : 'ok',
    facts.externalCount
      ? `внешние запросы: ${facts.externalCount} — страница должна работать офлайн`
      : 'внешних запросов нет — страница работает офлайн',
    facts.external,
  );

  add(
    facts.missingLocal.length ? 'fail' : 'ok',
    facts.missingLocal.length
      ? `ссылки на файлы, которых нет в проекте: ${facts.missingLocal.length}`
      : 'все локальные ссылки на месте',
    facts.missingLocal,
  );

  add(
    facts.fixedWidths.length ? 'fail' : 'ok',
    facts.fixedWidths.length
      ? `фиксированная ширина шире телефона: ${facts.fixedWidths.length}`
      : 'фиксированных ширин нет — вёрстка резиновая',
    facts.fixedWidths,
  );

  const tagProblems = [...facts.unclosedTags.map((tag) => `<${tag}> не закрыт`), ...facts.mismatchedTags];
  add(tagProblems.length ? 'fail' : 'ok', tagProblems.length ? `теги: ${tagProblems.length} замечаний` : 'теги закрыты парно', tagProblems);

  add(
    facts.quoteIssues.length ? 'fail' : 'ok',
    facts.quoteIssues.length ? `незакрытые кавычки в атрибутах: ${facts.quoteIssues.length}` : 'кавычки в атрибутах в порядке',
    facts.quoteIssues,
  );
  if (!facts.doctype) add('fail', 'нет <!doctype html> — браузер включит режим совместимости');

  return rows.map((row) => formatRow(row)).join('\n');
}

/** Одна строка отчёта с пометкой состояния; детали — вложенными строками. */
export function formatRow(row) {
  const labels = { ok: ' ok ', fail: 'нет ', '--': ' -- ' };
  const lines = [`${labels[row.state] || ' -- '} ${row.text}`];
  for (const detail of (row.details || []).slice(0, 6)) lines.push(`         · ${detail}`);
  return lines.join('\n');
}
