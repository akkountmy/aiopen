/**
 * Обложка книги для плеера.
 *
 * MP3 из озвучки не содержит ID3-обложки, а рядом с файлом её обычно нет:
 * в панели оставалась синяя плитка с нотой. Здесь сервис сам ищет обложку в
 * книжных магазинах и кладёт её рядом с записью — под именем книги, без
 * суффикса «часть 1 из 12», чтобы обложка находилась и у всех частей.
 *
 * Источники: «Лабиринт» и «Литрес» (русские издания), Open Library
 * (английские). Каждый ответ проверяем: имя похоже на книгу, картинка
 * действительно картинка и не гигантская. Найденное кэшируется на диске,
 * поэтому второй раз в сеть не ходим.
 */

import fs from 'node:fs';
import path from 'node:path';
import { assertPublicUrl, assertResolvesPublic } from './search.mjs';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MIN_IMAGE_BYTES = 1200;
const SEARCH_TIMEOUT_MS = 9000;
const IMAGE_TIMEOUT_MS = 12000;
const MISS_TTL_MS = 5 * 60 * 1000;
const IMAGE_EXT = /\.(jpe?g|png|webp|gif|avif)$/i;

/* Один поиск на книгу: одновременно её могут запросить плеер и запуск озвучки. */
const LOOKUPS = new Map();
/* Книги, которых нет в магазинах, не ищем на каждый клик. */
const MISSES = new Map();

function norm(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^a-zа-я0-9]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeEntities(value) {
  return String(value || '')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&laquo;/gi, '«')
    .replace(/&raquo;/gi, '»')
    .replace(/&mdash;/gi, '—')
    .replace(/&ndash;/gi, '–')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/gi, '&');
}

/** Имя книги из имени файла: без расширения, части и служебных приписок. */
export function bookTitleFromFile(file) {
  let base = path.basename(String(file || ''), path.extname(String(file || '')));
  base = base.replace(/\s*[—–-]\s*часть\s+\d+\s+из\s+\d+\s*$/i, '');
  /* Приписку о выжимке убираем и в начале, и в конце: имя может быть
     «Атомные привычки — выжимка», «Выжимка — Атомные привычки» или
     «Атомные привычки (конспект)». */
  const mark = '(?:выжимк[^\\s—–:·-]*|конспект[^\\s—–:·-]*|краткое\\s+содержание|обзор[^\\s—–:·-]*|summary)';
  base = base.replace(new RegExp(`^\\s*${mark}\\s*[—–:·-]\\s*`, 'i'), '');
  base = base.replace(new RegExp(`\\s*[—–:·-]\\s*${mark}\\s*$`, 'i'), '');
  base = base.replace(new RegExp(`\\s*\\(${mark}\\)\\s*$`, 'i'), '');
  base = base.replace(/^\d{1,2}[.)]\s+/, '');
  return base.trim() || 'озвучка';
}

/** Имя файла обложки: то же, что у книги, но без частей и запрещённых знаков. */
export function coverBase(title) {
  const value = String(title || '')
    .replace(/[\\/:*?"<>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '');
  if (!value) return 'обложка';
  return value.length > 80 ? `${value.slice(0, 79).trimEnd()}…` : value;
}

/** Уже лежит готовая обложка: своя, cover, обложка или имя книги. */
function existingCover(dir, base) {
  const wanted = new Set([norm(base), 'cover', 'обложка', 'обложк', 'front', 'folder', 'book']);
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !IMAGE_EXT.test(entry.name)) continue;
    const stem = norm(path.basename(entry.name, path.extname(entry.name)));
    if (!stem) continue;
    const exact = stem === norm(base);
    const usual = wanted.has(stem);
    const labelled = stem.startsWith(`${norm(base)} `) && /обложк|cover/.test(stem);
    if (exact || usual || labelled) {
      return { file: path.join(dir, entry.name), source: 'рядом с записью' };
    }
  }
  return null;
}

/** Насколько найденное название похоже на нашу книгу: 0 — не она. */
function similarity(query, name) {
  const q = norm(query);
  const n = norm(name);
  if (!q || !n) return 0;
  if (q === n) return 100;
  if (n.startsWith(q) || q.startsWith(n)) return 94;
  if (n.includes(q) || q.includes(n)) return 82;
  const qWords = [...new Set(q.split(' ').filter((word) => word.length > 2))];
  const nWords = new Set(n.split(' ').filter((word) => word.length > 2));
  if (!qWords.length) return 0;
  let hit = 0;
  for (const word of qWords) if (nWords.has(word)) hit += 1;
  const ratio = hit / qWords.length;
  if (ratio < 0.75) return 0;
  return 60 + Math.round(ratio * 20);
}

async function fetchText(url) {
  const safe = assertPublicUrl(url);
  await assertResolvesPublic(safe.hostname);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
  try {
    const response = await fetch(safe, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8' },
      redirect: 'follow',
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const type = String(response.headers.get('content-type') || '');
    if (!/text\/html|application\/json/i.test(type)) throw new Error('Не страница');
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

/** «Лабиринт»: в карточке товара есть ссылка на обложку и точное название. */
async function labirintCandidates(title) {
  const html = await fetchText(`https://www.labirint.ru/search/${encodeURIComponent(title)}/`);
  const list = [];
  const card = /<div[^>]+class="product-card[^"]*"[^>]*>/gi;
  let match;
  while ((match = card.exec(html))) {
    const block = html.slice(match.index, match.index + 5000);
    const id = /data-product-id="(\d+)"/.exec(block)?.[1];
    const name = decodeEntities(/data-name="([^"]*)"/.exec(block)?.[1] || '');
    if (!id || !name) continue;
    list.push({
      url: `https://imo10.labirint.ru/books/${id}/cover.jpg/600-0`,
      name,
      source: 'Лабиринт',
    });
  }
  return list;
}

/** «Литрес»: обложки на CDN, название — в alt картинки. */
async function litresCandidates(title) {
  const html = await fetchText(`https://www.litres.ru/search/?q=${encodeURIComponent(title)}`);
  const list = [];
  const patterns = [
    /<img[^>]+alt="([^"]*)"[^>]+src="(https:\/\/cdn\d*\.litres\.ru\/pub\/c\/cover_\d+\/\d+)"/gi,
    /<img[^>]+src="(https:\/\/cdn\d*\.litres\.ru\/pub\/c\/cover_\d+\/\d+)"[^>]+alt="([^"]*)"/gi,
  ];
  for (const [index, pattern] of patterns.entries()) {
    let match;
    while ((match = pattern.exec(html))) {
      const name = decodeEntities(index === 0 ? match[1] : match[2]);
      const url = index === 0 ? match[2] : match[1];
      if (!name) continue;
      /* Подкаст с названием книги — не книга: у него своя картинка, часто
         совсем не обложка. Берём только книги и аудиокниги. */
      const before = html.slice(Math.max(0, match.index - 3000), match.index);
      const links = [...before.matchAll(/href="([^"]+)"/g)].map((item) => item[1]);
      const container = [...links].reverse().find((href) => /\/(book|audiobook|podcast)\//.test(href)) || '';
      if (container.includes('/podcast/')) continue;
      list.push({ url, name, source: 'Литрес' });
    }
  }
  return list;
}

/** Open Library: для англоязычных книг, у русских там обложек почти нет. */
async function openLibraryCandidates(title) {
  const endpoint =
    `https://openlibrary.org/search.json?q=${encodeURIComponent(title)}` +
    '&limit=8&fields=title,author_name,cover_i,language,first_publish_year';
  const raw = await fetchText(endpoint);
  const data = JSON.parse(raw);
  const list = [];
  for (const doc of Array.isArray(data.docs) ? data.docs : []) {
    if (!doc?.cover_i || !doc.title) continue;
    list.push({
      url: `https://covers.openlibrary.org/b/id/${doc.cover_i}-L.jpg`,
      name: [doc.title, ...(doc.author_name || []).slice(0, 1)].join(' '),
      source: 'Open Library',
    });
  }
  return list;
}

function hasCyrillic(value) {
  return /[а-яё]/i.test(String(value || ''));
}

/** Собрать кандидатов и отсортировать по похожести названия. */
async function coverCandidates(title) {
  const tasks = hasCyrillic(title)
    ? [
        { run: labirintCandidates, source: 'Лабиринт' },
        { run: litresCandidates, source: 'Литрес' },
        { run: openLibraryCandidates, source: 'Open Library' },
      ]
    : [
        { run: openLibraryCandidates, source: 'Open Library' },
        { run: labirintCandidates, source: 'Лабиринт' },
        { run: litresCandidates, source: 'Литрес' },
      ];
  const settled = await Promise.allSettled(tasks.map((task) => task.run(title)));
  const list = [];
  const seen = new Set();
  /* «Лабиринт» и Open Library показывают именно книгу, у «Литрес» в выдаче
     бывают подкасты и промо с тем же названием: при равном совпадении имени
     книга важнее. */
  const bonus = { 'Лабиринт': 8, 'Open Library': 6, 'Литрес': 0 };
  for (const outcome of settled) {
    if (outcome.status !== 'fulfilled') continue;
    for (const candidate of outcome.value) {
      const score = similarity(title, candidate.name);
      if (score < 60) continue;
      if (seen.has(candidate.url)) continue;
      seen.add(candidate.url);
      list.push({ ...candidate, rank: score + (bonus[candidate.source] || 0) });
    }
  }
  return list.sort((a, b) => b.rank - a.rank);
}

function imageInfo(buffer) {
  if (!buffer || buffer.length < MIN_IMAGE_BYTES) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8) return { ext: '.jpg', type: 'image/jpeg' };
  if (buffer[0] === 0x89 && buffer[1] === 0x50) return { ext: '.png', type: 'image/png' };
  if (buffer.subarray(0, 6).toString('latin1') === 'GIF87a' || buffer.subarray(0, 6).toString('latin1') === 'GIF89a') {
    return { ext: '.gif', type: 'image/gif' };
  }
  if (
    buffer.subarray(0, 4).toString('latin1') === 'RIFF' &&
    buffer.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return { ext: '.webp', type: 'image/webp' };
  }
  return null;
}

/** Скачать картинку, проверяя адрес на каждом шаге редиректа. */
async function downloadImage(url) {
  let target = assertPublicUrl(url);
  for (let hop = 0; hop < 4; hop += 1) {
    await assertResolvesPublic(target.hostname);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), IMAGE_TIMEOUT_MS);
    try {
      const response = await fetch(target, {
        headers: { 'User-Agent': UA, Accept: 'image/*' },
        redirect: 'manual',
        signal: controller.signal,
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        try {
          await response.body?.cancel();
        } catch {
          /* тело уже закрыто */
        }
        if (!location) throw new Error('Пустой редирект');
        target = assertPublicUrl(new URL(location, target).href);
        continue;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const length = Number(response.headers.get('content-length') || 0);
      if (length > MAX_IMAGE_BYTES) throw new Error('Картинка слишком большая');
      const buffer = Buffer.from(await response.arrayBuffer());
      const info = imageInfo(buffer);
      if (!info) throw new Error('Это не картинка');
      return { buffer, ...info };
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error('Слишком много редиректов');
}

function writeCover(dir, base, image) {
  const target = path.join(dir, `${coverBase(base)}${image.ext}`);
  const tmp = path.join(dir, `.${path.basename(target)}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, image.buffer);
  try {
    fs.renameSync(tmp, target);
  } catch (error) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* временный файл уже убран */
    }
    throw error;
  }
  return target;
}

/**
 * Найти и сохранить обложку рядом с записью. Возвращает `{ file, source }`
 * или null. Никогда не бросает: плеер из-за обложки ломаться не должен.
 */
export async function ensureBookCover({ dir, title, file = '' }) {
  if (!dir) return null;
  const book = bookTitleFromFile(title || file || '');
  const base = coverBase(book);
  const key = path.resolve(dir, base.toLowerCase());
  const cached = existingCover(dir, base);
  if (cached) return cached;
  const missAt = MISSES.get(key) || 0;
  if (missAt && Date.now() - missAt < MISS_TTL_MS) return null;
  if (LOOKUPS.has(key)) return LOOKUPS.get(key);

  const job = (async () => {
    try {
      const candidates = await coverCandidates(book);
      for (const candidate of candidates.slice(0, 5)) {
        try {
          const image = await downloadImage(candidate.url);
          const saved = writeCover(dir, base, image);
          MISSES.delete(key);
          return { file: saved, source: candidate.source };
        } catch {
          /* обложка не скачалась — пробуем следующую */
        }
      }
    } catch {
      /* поиск недоступен — остаётся плитка с нотой */
    }
    MISSES.set(key, Date.now());
    return null;
  })().finally(() => LOOKUPS.delete(key));

  LOOKUPS.set(key, job);
  return job;
}
