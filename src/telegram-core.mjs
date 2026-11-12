/**
 * telegram-core — чистые преобразования данных для раздела «Телеграм».
 *
 * Никаких сети/файлов/npm-зависимостей: только строки и объекты. Модуль используется
 * сервером (сбор t.me/s, /api/tg/feed, /api/tg/stats, /api/tg/export, /api/tg/digest)
 * и покрыт офлайн-тестом test/telegram-core.mjs.
 *
 * Контракт полей — tg-intel/spec.md:
 *   Post    = {ch, id, date, text, views, forwards, url, links, hasMedia, mediaKind}
 *   Channel = {username, title, addedAt, active, note}      (title считает backend)
 *   stats   = {channels:[{username,title,posts,viewsAvg,viewsMax,lastPostAt}],
 *              topKeywords:[{word,count}], topLinks:[{url,count}],
 *              duplicates:[{count, posts:[{ch,id,url,text}]}]}
 * Правило «не распарсили → null, а не 0» соблюдается везде.
 *
 * Разбор HTML намеренно терпимый: порядок атрибутов произвольный, лишние классы
 * допускаются, нераспознанный блок не бросает исключение, а только увеличивает
 * счётчики в результате `found` ({wraps, texts, dates}).
 */

// ---------------------------------------------------------------------------
// HTML: сущности, теги, атрибуты
// ---------------------------------------------------------------------------

const NAMED_ENTITIES = Object.freeze({
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ensp: ' ',
  emsp: ' ',
  thinsp: ' ',
  laquo: '«',
  raquo: '»',
  ldquo: '“',
  rdquo: '”',
  lsquo: '‘',
  rsquo: '’',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  middot: '·',
  bull: '•',
  deg: '°',
  plusmn: '±',
  times: '×',
  divide: '÷',
  rarr: '→',
  larr: '←',
  copy: '©',
  reg: '®',
  trade: '™',
  euro: '€',
  pound: '£',
  num: '#',
  dollar: '$',
  percnt: '%',
  sol: '/',
  colon: ':',
  comma: ',',
  period: '.',
  excl: '!',
  quest: '?',
  lpar: '(',
  rpar: ')',
  shy: '',
  zwj: '',
  zwnj: '',
  lrm: '',
  rlm: '',
});

/**
 * Раскодировать HTML-сущности: именованные (&amp;), десятичные (&#33;),
 * шестнадцатеричные (&#x1F600;). Неизвестная сущность остаётся как есть.
 */
function decodeEntities(input) {
  if (input === null || input === undefined || input === '') return '';
  return String(input).replace(/&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]{1,31});/g, (full, body) => {
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X';
      const code = hex ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return full;
      try {
        return String.fromCodePoint(code);
      } catch {
        return full;
      }
    }
    const key = body.toLowerCase();
    return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, key) ? NAMED_ENTITIES[key] : full;
  });
}

/** Убрать комментарии, <script> и <style>: в них нет постов, но могут быть те же классы. */
function stripNoise(html) {
  return String(html || '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, '');
}

/** Значение атрибута по имени, в любом порядке атрибутов и с любыми кавычками. */
function attrValue(html, name) {
  const re = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'<>]+))`, 'i');
  const m = re.exec(String(html || ''));
  if (!m) return null;
  const value = decodeEntities(m[1] ?? m[2] ?? m[3] ?? '').trim();
  return value || null;
}

/** Найти открывающий тег, у которого в class есть нужный класс (ровно как токен). */
function findOpenTag(html, className, tag = 'div') {
  const re = new RegExp(
    `<${tag}\\b[^>]*\\bclass\\s*=\\s*["'][^"']*\\b${className}\\b[^"']*["'][^>]*>`,
    'i',
  );
  return re.exec(String(html || ''));
}

/**
 * Границы div-блока: от позиции сразу после открывающего тега до парного </div>.
 * При сломанной разметке возвращает конец строки — вызывающий код не падает.
 */
function matchDivBlock(html, openTagEnd) {
  const source = String(html || '');
  const re = /<\/?div\b[^>]*>/gi;
  re.lastIndex = openTagEnd;
  let depth = 1;
  let guard = 0;
  let m;
  while ((m = re.exec(source))) {
    if (++guard > 50000) break;
    if (m[0][1] === '/') {
      depth -= 1;
      if (depth === 0) return { start: openTagEnd, end: m.index };
    } else {
      depth += 1;
    }
  }
  return { start: openTagEnd, end: source.length };
}

/** Внутренний HTML элемента по классу; null, если элемента нет. */
function extractElement(html, className, tag = 'div') {
  const source = String(html || '');
  const open = findOpenTag(source, className, tag);
  if (!open) return null;
  const openEnd = open.index + open[0].length;
  if (String(tag).toLowerCase() === 'div') {
    return source.slice(openEnd, matchDivBlock(source, openEnd).end);
  }
  const close = new RegExp(`</${tag}\\s*>`, 'i').exec(source.slice(openEnd));
  return close ? source.slice(openEnd, openEnd + close.index) : source.slice(openEnd);
}

/** Список токенов class-атрибутов внутри фрагмента (для определения медиа). */
function classTokens(html) {
  const tokens = new Set();
  const re = /\bclass\s*=\s*["']([^"']*)["']/gi;
  const source = String(html || '');
  let m;
  while ((m = re.exec(source))) {
    for (const token of m[1].split(/\s+/)) {
      if (token) tokens.add(token);
    }
  }
  return tokens;
}

/** HTML → плоский текст: <br> в перевод строки, теги вырезаны, сущности раскодированы. */
function htmlToText(html) {
  if (!html) return '';
  let s = String(html);
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/(?:p|div|blockquote|pre|li|h[1-6])>/gi, '\n');
  s = s.replace(/<[^>]*>/g, '');
  s = decodeEntities(s);
  s = s.replace(/\r\n?/g, '\n');
  s = s
    .split('\n')
    .map((line) => line.replace(/[ \t\u00a0]+/g, ' ').trim())
    .join('\n');
  return s.replace(/\n{3,}/g, '\n\n').trim();
}

/** Все http(s)-ссылки из <a href="..."> внутри фрагмента, без дублей. */
function extractHrefs(html) {
  const out = [];
  const seen = new Set();
  const re = /<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>`]+))/gi;
  const source = String(html || '');
  let m;
  while ((m = re.exec(source))) {
    const href = decodeEntities(m[1] ?? m[2] ?? m[3] ?? '').trim();
    if (!/^https?:\/\//i.test(href)) continue;
    if (seen.has(href)) continue;
    seen.add(href);
    out.push(href);
  }
  return out;
}

/** <meta content="..." property="og:title">, порядок атрибутов любой. */
function metaContent(html, key) {
  const safe = String(key).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const tag = new RegExp(`<meta\\b[^>]*${safe}[^>]*>`, 'i').exec(String(html || ''));
  if (!tag) return null;
  return attrValue(tag[0], 'content');
}

// ---------------------------------------------------------------------------
// Числа и даты
// ---------------------------------------------------------------------------

function suffixMultiplier(raw) {
  const tail = String(raw || '')
    .toLowerCase()
    .replace(/[.]/g, '');
  if (!tail) return 1;
  const letters = /^[a-zа-я]+/.exec(tail);
  if (!letters) return 1;
  const word = letters[0];
  if (word.startsWith('k') || word.startsWith('к') || word.startsWith('тыс')) return 1000;
  if (word.startsWith('m') || word.startsWith('м')) return 1e6;
  return null;
}

function normalizeDecimal(numRaw, hasMultiplier) {
  const s = String(numRaw);
  if (hasMultiplier) return s.replace(/,/g, '.');
  if (/^[0-9]{1,3}([.,][0-9]{3})+$/.test(s)) return s.replace(/[.,]/g, '');
  if (/^[0-9]+[.,][0-9]{1,2}$/.test(s)) return s.replace(',', '.');
  return s.replace(/[.,]/g, '');
}

/**
 * "890" → 890, "1.2K" → 1200, "12.3K" → 12300, "1.2M" → 1200000,
 * "1,2 тыс." → 1200, "1 234" → 1234. Нечисловое ("—", "", "views") → null.
 */
function parseCount(raw) {
  if (raw === null || raw === undefined) return null;
  let s = decodeEntities(String(raw).replace(/<[^>]*>/g, ' '));
  s = s.replace(/[\s\u00a0\u202f\u2009]/g, '');
  if (!s) return null;
  const m = /^([0-9][0-9.,]*)([^\d\s]*)/.exec(s);
  if (!m) return null;
  const multiplier = suffixMultiplier(m[2]);
  if (multiplier === null) return null;
  const base = Number(normalizeDecimal(m[1], multiplier > 1));
  if (!Number.isFinite(base)) return null;
  return Math.round(base * multiplier);
}

/** ISO-8601 UTC или null. */
function parseIsoDate(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  const value = decodeEntities(String(raw)).trim();
  if (!value) return null;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return null;
  return new Date(time).toISOString();
}

function dateMs(post) {
  const time = Date.parse(post && post.date);
  return Number.isFinite(time) ? time : Number.NEGATIVE_INFINITY;
}

function byDateDesc(a, b) {
  const ta = dateMs(a);
  const tb = dateMs(b);
  if (ta === tb) return 0;
  return tb - ta;
}

function byDateAsc(a, b) {
  const ta = dateMs(a);
  const tb = dateMs(b);
  if (ta === tb) return 0;
  return ta - tb;
}

function resolveNow(value) {
  if (value === null || value === undefined || value === '') return Date.now();
  const time = typeof value === 'number' ? value : Date.parse(String(value));
  return Number.isFinite(time) ? time : Date.now();
}

function positiveNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function nonNegativeInt(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
}

// ---------------------------------------------------------------------------
// parseChannelPage
// ---------------------------------------------------------------------------

const MEDIA_KINDS = [
  ['photo', ['tgme_widget_message_photo']],
  ['video', ['tgme_widget_message_video', 'tgme_widget_message_roundvideo', 'tgme_widget_message_gif']],
  ['poll', ['tgme_widget_message_poll']],
];
const MEDIA_OTHER = [
  'tgme_widget_message_document',
  'tgme_widget_message_audio',
  'tgme_widget_message_voice',
  'tgme_widget_message_sticker',
  'tgme_widget_message_location',
  'tgme_widget_message_contact',
];

function hasTokenPrefix(tokens, prefix) {
  for (const token of tokens) {
    if (token === prefix || token.startsWith(`${prefix}_`) || token.startsWith(`${prefix}-`)) return true;
  }
  return false;
}

/**
 * Медиа сообщения. Проверяем токены классов, а не подстроки: иначе аватар
 * `tgme_widget_message_user_photo` ложно помечал бы каждый пост как фото.
 * mediaKind строго из контракта: photo | video | poll | null.
 * Документы/аудио/голосовые — это медиа (hasMedia=true), но вид вне контракта → null.
 */
function detectMedia(block) {
  const tokens = classTokens(block);
  let kind = null;
  let hasMedia = false;
  for (const [name, prefixes] of MEDIA_KINDS) {
    if (prefixes.some((prefix) => hasTokenPrefix(tokens, prefix))) {
      hasMedia = true;
      if (!kind) kind = name;
    }
  }
  if (!hasMedia && MEDIA_OTHER.some((prefix) => hasTokenPrefix(tokens, prefix))) {
    hasMedia = true;
  }
  return { hasMedia, mediaKind: kind };
}

function pickChannel(fromDataPost, fallback) {
  const raw = String(fromDataPost || '').trim().toLowerCase();
  if (/^[a-z0-9_]{3,32}$/.test(raw) && raw !== 'c' && raw !== 'joinchat') return raw;
  const hint = String(fallback || '').trim().toLowerCase();
  return /^[a-z0-9_]{3,32}$/.test(hint) ? hint : null;
}

/** Время сообщения: сначала <time datetime="...">, потом любой datetime в блоке. */
function extractDatetime(block) {
  const strict = /<time\b[^>]*\bdatetime\s*=\s*["']([^"']+)["']/i.exec(block);
  if (strict) return strict[1];
  return attrValue(block, 'datetime');
}

/**
 * Внутренний HTML текста сообщения: сначала js-message_text, потом любой
 * tgme_widget_message_text. null — элемента текста в посте нет (только медиа).
 */
function extractPostText(block) {
  const preferred = extractElement(block, 'js-message_text', 'div');
  if (preferred !== null) return preferred;
  return extractElement(block, 'tgme_widget_message_text', 'div');
}

function parsePostBlock(block, channelHint, found) {
  const dataPost = attrValue(block, 'data-post');
  if (!dataPost) return null;
  const parts = String(dataPost).split(/[?#]/)[0].split('/').filter(Boolean);
  if (parts.length < 2) return null;
  const idRaw = parts[parts.length - 1];
  const id = Number.parseInt(idRaw, 10);
  if (!Number.isFinite(id) || id <= 0) return null;
  const ch = pickChannel(parts[0], channelHint);
  if (!ch) return null;

  const rawText = extractPostText(block);
  const text = rawText === null ? '' : htmlToText(rawText);
  if (rawText !== null && found) found.texts += 1;

  const date = parseIsoDate(extractDatetime(block));
  if (date !== null && found) found.dates += 1;

  const media = detectMedia(block);
  return {
    ch,
    id: Math.trunc(id),
    date,
    text,
    views: parseCount(extractElement(block, 'tgme_widget_message_views', 'span')),
    forwards: parseCount(extractElement(block, 'tgme_widget_message_forwards', 'span')),
    url: `https://t.me/${ch}/${Math.trunc(id)}`,
    links: extractHrefs(rawText || ''),
    hasMedia: media.hasMedia,
    mediaKind: media.mediaKind,
  };
}

function extractChannelTitle(html) {
  const fromDiv = htmlToText(extractElement(html, 'tgme_channel_info_header_title', 'div') || '');
  if (fromDiv) return fromDiv;
  const og = metaContent(html, 'og:title');
  if (og) return htmlToText(og) || null;
  const twitter = metaContent(html, 'twitter:title');
  return twitter ? htmlToText(twitter) || null : null;
}

/**
 * Разобрать страницу публичного превью https://t.me/s/<channel>.
 *
 * @returns {{title: string|null, posts: Array<object>, found: {wraps:number,texts:number,dates:number}, html: string}}
 *   found — диагностика, а не ошибка: wraps = сколько обёрток сообщений нашли,
 *   texts = в скольких распознанных постах был текст, dates = в скольких была дата.
 *   Если разметка незнакома, wraps > posts.length — это видно снаружи.
 */
export function parseChannelPage(html, username) {
  const source = typeof html === 'string' ? html : '';
  const scan = stripNoise(source);
  const channelHint = normalizeUsername(username) || String(username || '').trim().toLowerCase().replace(/^@/, '');

  const title = extractChannelTitle(scan);
  const posts = [];
  const found = { wraps: 0, texts: 0, dates: 0 };

  const wrapOpen = /<div\b[^>]*\bclass\s*=\s*["'][^"']*\btgme_widget_message_wrap\b[^"']*["'][^>]*>/gi;
  let m;
  while ((m = wrapOpen.exec(scan))) {
    found.wraps += 1;
    const openEnd = m.index + m[0].length;
    const { end } = matchDivBlock(scan, openEnd);
    const block = scan.slice(openEnd, end);
    const post = parsePostBlock(block, channelHint, found);
    if (post) posts.push(post);
    wrapOpen.lastIndex = Math.max(end, openEnd);
  }

  return { title, posts, found, html: source };
}

// ---------------------------------------------------------------------------
// parseChannelInfo
// ---------------------------------------------------------------------------

function parseSubscriberCount(html) {
  const openRe = /<div\b[^>]*\bclass\s*=\s*["'][^"']*\btgme_channel_info_counter\b[^"']*["'][^>]*>/gi;
  let m;
  while ((m = openRe.exec(html))) {
    const start = m.index + m[0].length;
    const { end } = matchDivBlock(html, start);
    const inner = html.slice(start, end);
    const type = htmlToText(extractElement(inner, 'counter_type', 'span') || '').toLowerCase();
    if (/subscri|подписчик|участник/.test(type)) {
      const value = parseCount(htmlToText(extractElement(inner, 'counter_value', 'span') || ''));
      if (value !== null) return value;
    }
    openRe.lastIndex = Math.max(end, start);
  }
  // Резерв: текст вида «1.2M subscribers» без разметки счётчиков.
  const plain = htmlToText(html);
  const loose = /([0-9][0-9.,]*\s*[kKmMкКмМ]?)\s*(?:subscribers|подписчик\w*)/.exec(plain);
  return loose ? parseCount(loose[1]) : null;
}

/**
 * Информация о канале из блока tgme_channel_info (или og-разметки).
 * Отсутствующее поле — null.
 */
export function parseChannelInfo(html) {
  const scan = stripNoise(typeof html === 'string' ? html : '');
  const title = extractChannelTitle(scan);
  const infoBlock = extractElement(scan, 'tgme_channel_info', 'div') ?? scan;

  let description = htmlToText(extractElement(infoBlock, 'tgme_channel_info_description', 'div') || '');
  if (!description) {
    const og = metaContent(scan, 'og:description');
    description = og ? htmlToText(og) : '';
  }

  return {
    title: title || null,
    description: description || null,
    subscriberCount: parseSubscriberCount(infoBlock),
  };
}

// ---------------------------------------------------------------------------
// normalizeUsername
// ---------------------------------------------------------------------------

const USERNAME_RE = /^[a-z0-9_]{4,32}$/;
// Служебные сегменты пути t.me. `s` — превью канала (t.me/s/durov), его пропускаем.
// joinchat/c/+ — это приватный инвайт или внутренний id, для них username не существует.
const INVITE_SEGMENTS = new Set(['joinchat', 'c', 'addstickers', 'share', 'proxy', 'iv', 'login', 'socks', 'setlanguage']);
const DOMAIN_PREFIXES = ['t.me/', 'telegram.me/', 'telegram.dog/', 'tlgg.ru/', 'telegram.org/'];

function decodeUriSafe(value) {
  if (!value.includes('%')) return value;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * "@durov" | "https://t.me/durov" | "t.me/s/durov" | "durov/123" | "Durov" → "durov".
 * Невалидное/приватное → null. Правило контракта: [a-z0-9_]{4,32}, регистр вниз.
 */
export function normalizeUsername(input) {
  if (input === null || input === undefined) return null;
  let raw = decodeUriSafe(String(input).trim());
  if (!raw) return null;
  raw = raw.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  raw = raw.replace(/^www\./i, '');
  const lower = raw.toLowerCase();
  for (const prefix of DOMAIN_PREFIXES) {
    if (lower.startsWith(prefix)) {
      raw = raw.slice(prefix.length);
      break;
    }
  }
  raw = raw.split(/[?#]/)[0];

  const segments = raw
    .split('/')
    .map((part) => part.trim())
    .filter(Boolean);
  if (!segments.length) return null;

  for (const segment of segments) {
    if (INVITE_SEGMENTS.has(segment.toLowerCase())) return null;
    if (segment.startsWith('+')) return null;
  }

  let index = 0;
  while (index < segments.length && segments[index].toLowerCase() === 's') index += 1;
  const candidate = String(segments[index] || '').replace(/^@+/, '').toLowerCase();
  return USERNAME_RE.test(candidate) ? candidate : null;
}

function normalizeChannelList(channels) {
  if (channels === null || channels === undefined || channels === '') return null;
  const raw = Array.isArray(channels) ? channels : String(channels).split(',');
  const set = new Set();
  for (const item of raw) {
    const value = normalizeUsername(item) || String(item || '').trim().toLowerCase();
    if (value) set.add(value);
  }
  return set.size ? set : null;
}

// ---------------------------------------------------------------------------
// dedupePosts
// ---------------------------------------------------------------------------

/**
 * Дедуп по (ch, id): остаётся запись с более поздним collectedAt.
 * Результат отсортирован по date (новые первыми); посты без даты — в конце.
 */
export function dedupePosts(posts) {
  const map = new Map();
  for (const post of Array.isArray(posts) ? posts : []) {
    if (!post || post.ch === undefined || post.id === undefined) continue;
    const key = `${String(post.ch).toLowerCase()}::${post.id}`;
    const prev = map.get(key);
    if (!prev) {
      map.set(key, post);
      continue;
    }
    const prevTs = Date.parse(prev.collectedAt || '');
    const nextTs = Date.parse(post.collectedAt || '');
    if (Number.isFinite(nextTs) && (!Number.isFinite(prevTs) || nextTs >= prevTs)) map.set(key, post);
  }
  return [...map.values()].sort(byDateDesc);
}

// ---------------------------------------------------------------------------
// filterPosts
// ---------------------------------------------------------------------------

/** Нормализация для поиска: нижний регистр, ё→е, схлопнутые пробелы, без обрамляющих кавычек. */
function normalizeSearchText(value) {
  return String(value ?? '')
    .replace(/[«»“”„]/g, '"')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^"+|"+$/g, '')
    .trim();
}

/** "слово \"точная фраза\"" → [{phrase:false,value},{phrase:true,value}]. */
function parseQuery(query) {
  const text = String(query ?? '').replace(/[«»“”„]/g, '"').trim();
  if (!text) return [];
  const tokens = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(text))) {
    const isPhrase = m[1] !== undefined;
    const value = normalizeSearchText(isPhrase ? m[1] : m[2]);
    if (value) tokens.push({ phrase: isPhrase, value });
  }
  return tokens;
}

function matchesQuery(postText, tokens) {
  const haystack = normalizeSearchText(postText);
  return tokens.every((token) => haystack.includes(token.value));
}

/**
 * Фильтры ленты: channels (массив или "a,b"), q (все слова + "точная фраза"),
 * hours (окно от now), before (ISO, строго раньше — курсор пагинации), limit.
 * Результат отсортирован по date убыв. Пост без даты в окно hours/before не попадает.
 */
export function filterPosts(posts, options = {}) {
  const opts = options || {};
  let out = (Array.isArray(posts) ? posts : []).filter(Boolean);

  const channels = normalizeChannelList(opts.channels);
  if (channels) out = out.filter((post) => channels.has(String(post.ch || '').toLowerCase()));

  const tokens = parseQuery(opts.q);
  if (tokens.length) out = out.filter((post) => matchesQuery(post.text, tokens));

  const hours = positiveNumber(opts.hours);
  if (hours !== null) {
    const from = resolveNow(opts.now) - hours * 3600000;
    out = out.filter((post) => dateMs(post) >= from);
  }

  if (opts.before !== null && opts.before !== undefined && opts.before !== '') {
    const before = Date.parse(String(opts.before));
    if (Number.isFinite(before)) out = out.filter((post) => dateMs(post) < before);
  }

  out = [...out].sort(byDateDesc);
  const limit = nonNegativeInt(opts.limit);
  if (limit !== null) out = out.slice(0, limit);
  return out;
}

// ---------------------------------------------------------------------------
// aggregateStats
// ---------------------------------------------------------------------------

/**
 * Стоп-слова для topKeywords: 72 самых частых служебных слова (36 рус + 36 англ).
 * Экспортируется, чтобы тест мог проверить размер словаря (по заданию 60-80).
 */
export const STOPWORDS = Object.freeze([
  'этот', 'эта', 'эти', 'этого', 'этих', 'такой', 'такие', 'также', 'только', 'очень',
  'чтобы', 'когда', 'тогда', 'может', 'можно', 'нужно', 'будет', 'есть', 'был', 'была',
  'были', 'было', 'быть', 'который', 'которые', 'кроме', 'после', 'перед', 'через', 'между',
  'теперь', 'сейчас', 'еще', 'уже', 'даже', 'если',
  'this', 'that', 'these', 'those', 'with', 'from', 'have', 'been', 'will', 'would',
  'should', 'could', 'their', 'there', 'where', 'which', 'what', 'when', 'then', 'than',
  'them', 'they', 'your', 'about', 'just', 'more', 'most', 'some', 'such', 'only',
  'also', 'very', 'into', 'over', 'like', 'being',
]);

const STOPWORD_SET = new Set(STOPWORDS);

/** Токены текста: нижний регистр, ё→е, только буквы/цифры. */
function tokenizeWords(text) {
  return (
    String(text ?? '')
      // ссылки заранее выкидываем, чтобы домены не попадали в ключевые слова
      .replace(/https?:\/\/\S+/gi, ' ')
      .replace(/ё/g, 'е')
      .replace(/Ё/g, 'е')
      .toLowerCase()
      .match(/[a-zа-я0-9]+/g) || []
  );
}

function isStopword(word) {
  return STOPWORD_SET.has(word);
}

function keywordsOf(text) {
  const words = tokenizeWords(text);
  const uniq = new Set();
  for (const word of words) {
    if (word.length < 4 || !/^[a-zа-я]+$/.test(word)) continue;
    if (isStopword(word)) continue;
    uniq.add(word);
  }
  return uniq;
}

/** «Шингл» текста: первые 3 значимых слова (для поиска одного сюжета в разных каналах). */
function shingleOf(text) {
  const words = tokenizeWords(text).filter((word) => word.length >= 3 && !isStopword(word));
  if (words.length < 3) return null;
  return words.slice(0, 3).join(' ');
}

function refOf(post) {
  const text = String(post.text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  return {
    ch: post.ch,
    id: post.id,
    url: post.url || `https://t.me/${post.ch}/${post.id}`,
    text,
  };
}

function buildDuplicates(posts) {
  const groups = new Map();
  for (const post of posts) {
    const key = shingleOf(post.text);
    if (!key) continue;
    const bucket = groups.get(key) || [];
    bucket.push(post);
    groups.set(key, bucket);
  }
  const result = [];
  for (const bucket of groups.values()) {
    const channels = new Set(bucket.map((post) => String(post.ch || '').toLowerCase()));
    if (bucket.length < 2 || channels.size < 2) continue;
    const ordered = [...bucket].sort(byDateDesc);
    result.push({ count: ordered.length, posts: ordered.map(refOf) });
  }
  return result.sort((a, b) => b.count - a.count || String(a.posts[0].url).localeCompare(String(b.posts[0].url))).slice(0, 10);
}

function inWindow(post, hours, nowMs) {
  if (hours === null) return true;
  const time = dateMs(post);
  if (!Number.isFinite(time)) return false;
  return time >= nowMs - hours * 3600000;
}

/**
 * Агрегаты по постам: каналы, ключевые слова (топ-20), ссылки (топ-20), повторы (до 10 групп).
 * viewsAvg/viewsMax — только по постам с известными просмотрами; если таких нет → null.
 * title берётся из поста (если сервер приложил title/chTitle), иначе null.
 */
export function aggregateStats(posts, options = {}) {
  const opts = options || {};
  const hours = positiveNumber(opts.hours);
  const nowMs = resolveNow(opts.now);
  const list = (Array.isArray(posts) ? posts : []).filter(
    (post) => post && post.ch !== undefined && inWindow(post, hours, nowMs),
  );

  const byChannel = new Map();
  const keywordCount = new Map();
  const linkCount = new Map();

  for (const post of list) {
    const username = String(post.ch);
    const entry = byChannel.get(username) || {
      username,
      title: null,
      posts: 0,
      views: [],
      lastPostAt: null,
    };
    entry.posts += 1;
    if (entry.title === null) {
      const title = typeof post.title === 'string' && post.title.trim() ? post.title.trim() : post.chTitle;
      if (typeof title === 'string' && title.trim()) entry.title = title.trim();
    }
    if (Number.isFinite(post.views)) entry.views.push(Number(post.views));
    if (post.date) {
      const time = dateMs(post);
      const prev = entry.lastPostAt ? Date.parse(entry.lastPostAt) : Number.NEGATIVE_INFINITY;
      if (Number.isFinite(time) && time > prev) entry.lastPostAt = new Date(time).toISOString();
    }
    byChannel.set(username, entry);

    for (const word of keywordsOf(post.text)) {
      keywordCount.set(word, (keywordCount.get(word) || 0) + 1);
    }
    const links = new Set(
      (Array.isArray(post.links) ? post.links : []).filter((link) => typeof link === 'string' && link.trim()),
    );
    for (const link of links) linkCount.set(link, (linkCount.get(link) || 0) + 1);
  }

  const channels = [...byChannel.values()]
    .map((entry) => {
      const viewsAvg = entry.views.length
        ? Math.round(entry.views.reduce((sum, value) => sum + value, 0) / entry.views.length)
        : null;
      return {
        username: entry.username,
        title: entry.title,
        posts: entry.posts,
        viewsAvg,
        viewsMax: entry.views.length ? Math.max(...entry.views) : null,
        lastPostAt: entry.lastPostAt,
      };
    })
    .sort((a, b) => b.posts - a.posts || a.username.localeCompare(b.username));

  const topKeywords = [...keywordCount.entries()]
    .map(([word, count]) => ({ word, count }))
    .sort((a, b) => b.count - a.count || a.word.localeCompare(b.word))
    .slice(0, 20);

  const topLinks = [...linkCount.entries()]
    .map(([url, count]) => ({ url, count }))
    .sort((a, b) => b.count - a.count || a.url.localeCompare(b.url))
    .slice(0, 20);

  return { channels, topKeywords, topLinks, duplicates: buildDuplicates(list) };
}

// ---------------------------------------------------------------------------
// renderExportMarkdown
// ---------------------------------------------------------------------------

function formatDateForExport(iso) {
  if (!iso) return '—';
  const flat = String(iso)
    .replace('T', ' ')
    .replace(/\.\d+Z?$/, '')
    .replace(/Z$/, '');
  return `${flat.replace(/:00$/, '')} UTC`;
}

function escapeTableCell(value) {
  return String(value ?? '')
    .replace(/\r?\n/g, ' ')
    .replace(/\|/g, '\\|')
    .trim();
}

/**
 * Markdown-экспорт постов для /api/tg/export: шапка с периодом, таблица
 * (дата, канал, просмотры, ссылка) и полные тексты с явным URL каждого поста.
 */
export function renderExportMarkdown(posts, meta = {}) {
  const info = meta || {};
  const list = (Array.isArray(posts) ? posts : []).filter(Boolean).slice().sort(byDateDesc);
  const hours = positiveNumber(info.hours);
  const lines = ['# Экспорт постов Telegram', ''];

  const facts = [];
  if (hours !== null) facts.push(`период: ${hours} ч`);
  facts.push(`постов: ${list.length}`);
  const channels = [...new Set(list.map((post) => String(post.ch || '')).filter(Boolean))];
  if (channels.length) facts.push(`каналов: ${channels.length} (${channels.join(', ')})`);
  facts.push(`сформировано: ${info.generatedAt ? String(info.generatedAt) : new Date().toISOString()}`);
  lines.push(facts.join(' · '), '');

  if (!list.length) {
    lines.push('_Постов за выбранный период нет._', '');
    return lines.join('\n');
  }

  lines.push('| Дата (UTC) | Канал | Просмотры | Пост |', '| --- | --- | --- | --- |');
  for (const post of list) {
    const url = post.url || `https://t.me/${post.ch}/${post.id}`;
    const views = Number.isFinite(post.views) ? String(post.views) : '—';
    const preview = escapeTableCell(String(post.text || '').replace(/\s+/g, ' ').trim().slice(0, 140));
    lines.push(`| ${formatDateForExport(post.date)} | ${escapeTableCell(post.ch)} | ${views} | [${post.id}](${url}) ${preview} |`);
  }
  lines.push('', '## Посты целиком', '');

  for (const post of list) {
    const url = post.url || `https://t.me/${post.ch}/${post.id}`;
    lines.push(`### ${formatDateForExport(post.date)} · ${post.ch} · #${post.id}`, '');
    const meta2 = [`Ссылка: ${url}`];
    if (Number.isFinite(post.views)) meta2.push(`просмотры: ${post.views}`);
    if (Number.isFinite(post.forwards)) meta2.push(`пересылки: ${post.forwards}`);
    if (post.mediaKind) meta2.push(`медиа: ${post.mediaKind}`);
    else if (post.hasMedia) meta2.push('медиа: есть');
    lines.push(meta2.join(' · '), '');
    const text = String(post.text || '').trim();
    lines.push(text || '_текста нет_', '');
    const links = Array.isArray(post.links) ? post.links.filter(Boolean) : [];
    if (links.length) lines.push(`Ссылки в тексте: ${links.join(' ')}`, '');
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// buildDigestPrompt
// ---------------------------------------------------------------------------

const DIGEST_SYSTEM = [
  'Ты — аналитик, который пишет дайджест по постам Telegram.',
  'Работай только с фактами из переданных постов: не выдумывай события, числа, цитаты и участников.',
  'Каждый факт подкрепляй ссылкой на пост в виде t.me/<канал>/<id> (полный вид: https://t.me/<канал>/<id>).',
  'Если данных мало или тема не раскрыта — скажи это прямо, без домыслов и без «воды».',
  'Пиши по-русски, коротко и по делу, без вступлений вроде «вот дайджест».',
].join('\n');

function oneLine(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

function truncateText(text, limit) {
  const value = String(text ?? '');
  if (value.length <= limit) return value;
  return `${value.slice(0, Math.max(0, limit - 1)).replace(/\s+$/, '')}…`;
}

/**
 * Промпт для LLM-дайджеста: system с правилами, user с компактным списком постов.
 * Лимиты: не более 120 постов (самые свежие), текст поста обрезан до 400 знаков,
 * порядок — от старых к новым. Ссылки на посты всегда попадают в промпт.
 */
export function buildDigestPrompt(posts, options = {}) {
  const opts = options || {};
  const hours = positiveNumber(opts.hours) ?? 24;
  const focus = oneLine(opts.focus);
  const POST_LIMIT = 120;
  const TEXT_LIMIT = 400;

  const all = (Array.isArray(posts) ? posts : [])
    .filter((post) => post && post.ch !== undefined && post.id !== undefined)
    .sort(byDateAsc);
  const chosen = all.length > POST_LIMIT ? all.slice(all.length - POST_LIMIT) : all;

  const entries = chosen.map((post, index) => {
    const url = post.url || `https://t.me/${post.ch}/${post.id}`;
    const when = post.date ? String(post.date) : 'дата неизвестна';
    const views = Number.isFinite(post.views) ? ` · просмотры: ${post.views}` : '';
    const body = truncateText(oneLine(post.text), TEXT_LIMIT) || '(без текста)';
    return `[${index + 1}] ${when} · ${post.ch}${views} · ${url}\n${body}`;
  });

  const header = [
    `Задача: собери дайджест по постам Telegram за последние ${hours} ч.`,
    `Постов в наборе: ${all.length}, в промпт попало: ${chosen.length} (не более ${POST_LIMIT}, самые свежие).`,
    'Посты отсортированы по времени: от старых к новым.',
  ];
  if (focus) header.push(`Фокус дайджеста: ${focus}`);
  header.push(
    '',
    'Формат ответа (markdown):',
    '1. Заголовок дня — одна строка, суть дня (не название канала).',
    '2. 3-7 тем: у каждой заголовок и 1-3 пункта, в каждом пункте ссылка на пост https://t.me/<канал>/<id>.',
    '3. Отдельный блок «Повторы»: одна новость в нескольких каналах, со ссылками на все посты.',
    'Правила: не выдумывай факты; ссылки бери только из списка постов; если постов нет — напиши одну строку «за период постов нет».',
    '',
    'Посты:',
  );

  const body = entries.length ? entries.join('\n\n') : '(пусто — постов за период нет)';
  return { system: DIGEST_SYSTEM, user: `${header.join('\n')}\n${body}` };
}

// ---------------------------------------------------------------------------
// renderDigestSources
// ---------------------------------------------------------------------------

const SOURCE_LINK_RE = /https?:\/\/t\.me\/([A-Za-z0-9_]+)\/(\d+)/g;
const SOURCE_LIMIT = 5;
const SOURCE_TEXT_LIMIT = 160;

/** "1 234 567" → "1,2 млн": та же компактная запись, что в интерфейсе. */
function compactNumber(value) {
  return String(Math.round(value * 10) / 10).replace('.', ',');
}

/** Просмотры по-человечески: 840, 1,2 тыс., 120 тыс., 1,3 млн. */
function formatSourceViews(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return '';
  if (number < 1000) return `${Math.round(number)} просмотров`;
  if (number < 1000000) return `${compactNumber(number / 1000)} тыс. просмотров`;
  return `${compactNumber(number / 1000000)} млн просмотров`;
}

/** "09.11.2026 08:46" — московское время, одно и то же на любом сервере. */
function formatSourceDate(iso) {
  const time = Date.parse(String(iso ?? ''));
  if (!Number.isFinite(time)) return '';
  const parts = new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Europe/Moscow',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date(time));
  const get = (type) => parts.find((part) => part.type === type)?.value || '';
  return `${get('day')}.${get('month')}.${get('year')} ${get('hour')}:${get('minute')}`;
}

function postKey(channel, id) {
  return `${String(channel || '').toLowerCase()}/${String(id)}`;
}

function sourceRecord(post) {
  const ch = String(post?.ch || '');
  const id = Number(post?.id);
  if (!ch || !Number.isFinite(id)) return null;
  const url = String(post.url || `https://t.me/${ch}/${id}`);
  return {
    ch,
    id,
    url,
    date: post.date ? String(post.date) : null,
    views: Number.isFinite(Number(post.views)) ? Number(post.views) : null,
    text: String(post.text || '').replace(/\s+/g, ' ').trim().slice(0, SOURCE_TEXT_LIMIT),
  };
}

/**
 * Блок «Источники» для дайджеста — его собирает код, а не модель: ссылки в
 * ответе модели могут отсутствовать, а приёмка требует их всегда.
 *
 * Порядок: сначала ссылки https://t.me/<канал>/<id> из текста модели (как они
 * появились), затем — если записей меньше пяти — посты набора по убыванию
 * просмотров. Дубликаты по URL отбрасываются.
 *
 * @returns {{block: string, sources: Array<{ch: string, id: number, url: string, date: string|null, views: number|null, text: string}>}}
 */
export function renderDigestSources(posts, modelText) {
  const list = (Array.isArray(posts) ? posts : []).filter(Boolean);
  const known = new Map();
  for (const post of list) {
    const record = sourceRecord(post);
    if (record) known.set(postKey(record.ch, record.id), record);
  }

  const picked = [];
  const seen = new Set();
  const push = (record) => {
    if (!record || seen.has(record.url)) return;
    seen.add(record.url);
    picked.push(record);
  };

  const text = String(modelText ?? '');
  SOURCE_LINK_RE.lastIndex = 0;
  for (let match = SOURCE_LINK_RE.exec(text); match; match = SOURCE_LINK_RE.exec(text)) {
    const channel = match[1];
    const id = Number(match[2]);
    if (!Number.isFinite(id)) continue;
    const found = known.get(postKey(channel, id));
    push(
      found || {
        ch: channel,
        id,
        url: `https://t.me/${channel}/${id}`,
        date: null,
        views: null,
        text: '',
      },
    );
    if (picked.length >= SOURCE_LIMIT) break;
  }

  if (picked.length < SOURCE_LIMIT) {
    const rest = list
      .map((post) => sourceRecord(post))
      .filter((record) => record && !seen.has(record.url))
      .sort((a, b) => {
        const va = a.views === null ? -1 : a.views;
        const vb = b.views === null ? -1 : b.views;
        if (va !== vb) return vb - va;
        return byDateDesc(a, b);
      });
    for (const record of rest) {
      push(record);
      if (picked.length >= SOURCE_LIMIT) break;
    }
  }

  if (!picked.length) return { block: '', sources: [] };

  const lines = ['## Источники', ''];
  for (const record of picked) {
    const facts = [formatSourceDate(record.date), formatSourceViews(record.views)].filter(Boolean);
    const suffix = facts.length ? ` — ${facts.join(' · ')}` : '';
    lines.push(`- [@${record.ch}/${record.id}](${record.url})${suffix}`);
  }
  return { block: lines.join('\n'), sources: picked };
}

// ---------------------------------------------------------------------------
// Предохранитель транспортов
// ---------------------------------------------------------------------------

/**
 * Мост tg.i-c-a.su отдаёт данные «по настроению»: одна и та же страница то
 * приходит за 0,2 с, то не приходит вовсе. Если каждый сбор честно ждать
 * таймаута, человек платит за это минутами ожидания, а донор — новыми 429.
 *
 * Поэтому у каждого транспорта есть предохранитель: два отказа подряд — пауза,
 * во время которой транспорт не пробуют вовсе. Правила живут здесь, ввод-вывод
 * (файл transport.json) — в telegram.mjs: так их видно в офлайновых тестах.
 */
export const TRANSPORTS = Object.freeze(['tme', 'bridge']);

/* Два отказа подряд — уже не случайность. Пауза растёт вдвое: 5, 10, 20, 40,
   дальше час. Любой успех снимает счётчик целиком. */
export const BREAKER_THRESHOLD = 2;
export const BREAKER_BASE_MS = 5 * 60 * 1000;
export const BREAKER_MAX_MS = 60 * 60 * 1000;

function emptyTransport() {
  return { failures: 0, until: 0, lastError: '', lastFailAt: null, lastOkAt: null };
}

/** Любое состояние (в том числе битый файл) → валидное и полное. */
export function normalizeBreaker(state) {
  const source = state && typeof state === 'object' && !Array.isArray(state) ? state : {};
  const out = {
    updatedAt: typeof source.updatedAt === 'string' ? source.updatedAt : null,
    tme: emptyTransport(),
    bridge: emptyTransport(),
  };
  for (const kind of TRANSPORTS) {
    const item = source[kind] && typeof source[kind] === 'object' ? source[kind] : {};
    const failures = Math.trunc(Number(item.failures));
    const until = Math.trunc(Number(item.until));
    out[kind] = {
      failures: Number.isFinite(failures) && failures > 0 ? failures : 0,
      until: Number.isFinite(until) && until > 0 ? until : 0,
      lastError: typeof item.lastError === 'string' ? item.lastError.slice(0, 300) : '',
      lastFailAt: typeof item.lastFailAt === 'string' ? item.lastFailAt : null,
      lastOkAt: typeof item.lastOkAt === 'string' ? item.lastOkAt : null,
    };
  }
  return out;
}

/** Сколько держать паузу после N отказов подряд. */
export function breakerCooldownMs(failures) {
  const over = Math.max(0, Math.trunc(Number(failures) || 0) - BREAKER_THRESHOLD);
  return Math.min(BREAKER_MAX_MS, BREAKER_BASE_MS * 2 ** over);
}

/** Успех: транспорт здоров, пауза и счётчик снимаются. */
export function breakerSuccess(state, kind, now = Date.now()) {
  const next = normalizeBreaker(state);
  if (!TRANSPORTS.includes(kind)) return next;
  next[kind] = { ...emptyTransport(), lastOkAt: new Date(now).toISOString() };
  next.updatedAt = new Date(now).toISOString();
  return next;
}

/** Отказ: счёт подряд, со второго — пауза по возрастающей. */
export function breakerFailure(state, kind, options = {}) {
  const now = Number(options.now) || Date.now();
  const next = normalizeBreaker(state);
  if (!TRANSPORTS.includes(kind)) return next;
  const prev = next[kind];
  const failures = prev.failures + 1;
  next[kind] = {
    failures,
    until: failures >= BREAKER_THRESHOLD ? now + breakerCooldownMs(failures) : prev.until,
    lastError: String(options.error || '').replace(/\s+/g, ' ').trim().slice(0, 300),
    lastFailAt: new Date(now).toISOString(),
    lastOkAt: prev.lastOkAt,
  };
  next.updatedAt = new Date(now).toISOString();
  return next;
}

/** Состояние для человека и для /api/tg/health. */
export function breakerView(state, now = Date.now()) {
  const next = normalizeBreaker(state);
  const view = {};
  for (const kind of TRANSPORTS) {
    const item = next[kind];
    const retryInMs = Math.max(0, item.until - now);
    view[kind] = {
      open: retryInMs > 0,
      failures: item.failures,
      retryInMs,
      lastError: item.lastError,
      lastFailAt: item.lastFailAt,
      lastOkAt: item.lastOkAt,
    };
  }
  return view;
}

/**
 * Порядок транспортов с учётом пауз. Базовый порядок задаёт вызывающий (t.me
 * первым; мост первым, если он явно запрошен). Транспорты на паузе выпадают;
 * если на паузе оба — пустой порядок и срок, когда снова будет смысл.
 */
export function breakerPlan(baseOrder, state, now = Date.now()) {
  const order = Array.isArray(baseOrder)
    ? baseOrder.filter((kind) => TRANSPORTS.includes(kind))
    : [...TRANSPORTS];
  const view = breakerView(state, now);
  const healthy = order.filter((kind) => !view[kind].open);
  const waiting = order
    .filter((kind) => view[kind].open)
    .map((kind) => ({ kind, retryInMs: view[kind].retryInMs }))
    .sort((a, b) => a.retryInMs - b.retryInMs);
  return {
    order: healthy,
    waiting,
    openAll: healthy.length === 0 && waiting.length > 0,
    retryInMs: waiting.length ? waiting[0].retryInMs : 0,
  };
}
