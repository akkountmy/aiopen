/* Свои темы «Top news»: пользователь добавляет свою тему, а блок новостей по
 * ней собирается в фоне и кешируется на сутки.
 *
 * Почему так, а не «сразу в ответе»:
 *  - поиск и редактор занимают десятки секунд, а раздел открывают часто;
 *  - одна и та же тема нужна всем запросам экрана за день, поэтому результат
 *    складывается в файл и второй раз ничего не стоит;
 *  - общий выпуск при этом не трогается: свои блоки живут отдельно и только
 *    добавляются к шести темам выпуска.
 *
 * Кеш: data/topnews/personal/<пользователь>/<YYYY-MM-DD>.json (дата по Минску).
 * Содержимое: { dateKey, builtAt, blocks: [{ topicId, title, kicker, tone,
 * status, items }] }, status — ready | building | empty.
 */
import fs from 'node:fs';
import path from 'node:path';

import {
  TOPNEWS_DIR,
  addDaysKey,
  dedupeAndRank,
  localInfo,
  makeItem,
  publicNewsItem,
  sameStory,
  searchCategory,
  selectWithEditor,
} from './topnews.mjs';
import { atomicWrite, nowIso } from './util.mjs';

/** Каталог кеша своих тем: data/topnews/personal. */
export const PERSONAL_DIR = path.join(TOPNEWS_DIR, 'personal');

/* В блоке своей темы — не больше двух новостей: это добавка к выпуску, а не
 * второй выпуск. Меньше двух — блок пустой: одна строка выглядит как обрыв
 * вёрстки, и непонятно, тема пуста или сборка не доделалась. */
const MAX_ITEMS = 2;

/* Сутки кеша и ещё два предыдущих дня. Дольше не держим: вчерашние новости
 * по своей теме никому не нужны, а каталог живёт на том же диске, что данные. */
const KEEP_DAYS = 3;

/* Кто сейчас собирается. Сборку запускает запрос экрана, и без этой карты два
 * одновременных запроса запустили бы два платных поиска по одной теме. */
const inflight = new Map();

/* Сколько запись «собирается» ещё считается живой. Сборка трёх тем — это три
 * поиска и три ответа редактора, то есть единицы минут; четверть часа — запас
 * на медленную сеть, после которого запись уже враньё. */
const BUILDING_STALE_MS = 15 * 60 * 1000;

/* ------------------------------------------------------------------ */
/* Имена и даты                                                        */
/* ------------------------------------------------------------------ */

function toDate(value) {
  const at = value instanceof Date ? value : value ? new Date(value) : new Date();
  return Number.isFinite(at.getTime()) ? at : new Date();
}

/** Дата по Минску: 'YYYY-MM-DD'. Календарь кеша живёт по местному дню, а не по UTC. */
export function dateKeyNow(now = new Date()) {
  return localInfo(toDate(now)).dateKey;
}

/* Идентификатор пользователя приходит из хранилища, но путь строим сами:
 * слэши и «..» в имени каталога оказаться не должны. */
function userKey(userId) {
  const raw = String(userId ?? '').trim();
  if (!raw) return '';
  return raw.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 64);
}

function userDir(userId) {
  const key = userKey(userId);
  return key ? path.join(PERSONAL_DIR, key) : '';
}

function dayFile(userId, dateKey) {
  const dir = userDir(userId);
  const day = String(dateKey ?? '').trim();
  if (!dir || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return '';
  return path.join(dir, `${day}.json`);
}

/* ------------------------------------------------------------------ */
/* Форма данных                                                        */
/* ------------------------------------------------------------------ */

function cleanText(raw, limit) {
  return String(raw ?? '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

/* Клиент знает палитру тем и подставит золотой цвет для незнакомого значения.
 * Поэтому здесь достаточно «слово из латиницы» — но не произвольная строка. */
const TONE_RE = /^[a-z]{2,16}$/;

function normaliseTone(raw) {
  const tone = cleanText(raw, 16).toLowerCase();
  return TONE_RE.test(tone) ? tone : 'gold';
}

function normaliseTopics(topics) {
  if (!Array.isArray(topics)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of topics) {
    if (!raw || typeof raw !== 'object') continue;
    const id = cleanText(raw.id, 64);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      title: cleanText(raw.title, 80) || 'Своя тема',
      kicker: cleanText(raw.kicker, 120),
      tone: normaliseTone(raw.tone),
      query: cleanText(raw.query, 240),
      extraQueries: Array.isArray(raw.extraQueries)
        ? raw.extraQueries.map((query) => cleanText(query, 240)).filter(Boolean).slice(0, 3)
        : [],
    });
  }
  return out;
}

function blockHead(topic) {
  return { topicId: topic.id, title: topic.title, kicker: topic.kicker, tone: topic.tone };
}

/* Метка «сборка началась» остаётся в файле кеша и наружу не отдаётся: по ней
 * видно, что запись «собирается» протухла, а не ждёт готовности. */
function placeholderBlock(topic) {
  return { ...blockHead(topic), status: 'building', items: [], buildingAt: nowIso() };
}

function emptyBlock(topic) {
  return { ...blockHead(topic), status: 'empty', items: [] };
}

/**
 * Протухшая запись «собирается».
 *
 * Сборка идёт в памяти процесса: перезапуск сервиса посреди сборки оставляет
 * в кеше вечный `building`, и если отдавать его как есть, раздел до полуночи
 * будет показывать «собираем…». Поэтому старую запись считаем отсутствующей —
 * раздел запустит сборку заново, а сам пока покажет то же «собирается».
 */
function isStaleBuilding(raw) {
  if (!raw || typeof raw !== 'object' || raw.status !== 'building') return false;
  const startedAt = Date.parse(String(raw.buildingAt || ''));
  /* Записи без метки — из версии без неё: проверить нечего, считаем протухшей. */
  if (!Number.isFinite(startedAt)) return true;
  return Date.now() - startedAt > BUILDING_STALE_MS;
}

/** Одна новость в форме выпуска. Ссылка на первоисточник обязательна. */
function normaliseItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const url = String(raw.url || '').trim();
  if (!/^https?:\/\//i.test(url)) return null;
  const headline = cleanText(raw.headline, 160);
  if (headline.length < 8) return null;
  return {
    rank: Number.isFinite(Number(raw.rank)) ? Number(raw.rank) : 0,
    headline,
    summary: cleanText(raw.summary, 400),
    source: cleanText(raw.source, 44),
    url,
    publishedAt: typeof raw.publishedAt === 'string' ? raw.publishedAt : null,
  };
}

function normaliseItems(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map(normaliseItem)
    .filter(Boolean)
    .slice(0, MAX_ITEMS)
    .map((item, index) => ({ ...item, rank: index + 1 }));
}

function normaliseBlock(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const topicId = cleanText(raw.topicId, 64);
  if (!topicId) return null;
  const items = normaliseItems(raw.items);
  let status = String(raw.status || '');
  if (status !== 'building' && status !== 'empty') status = 'ready';
  /* Готовым блок считается только с двумя новостями: одиночная строка — это
   * недобор, а не блок, и обещать её в интерфейсе нечестно. */
  if (status === 'ready' && items.length < MAX_ITEMS) status = 'empty';
  return {
    topicId,
    title: cleanText(raw.title, 80),
    kicker: cleanText(raw.kicker, 120),
    tone: normaliseTone(raw.tone),
    status,
    items: status === 'empty' ? [] : items,
  };
}

/* ------------------------------------------------------------------ */
/* Кеш                                                                 */
/* ------------------------------------------------------------------ */

function persist(userId, dateKey, blocks) {
  const file = dayFile(userId, dateKey);
  if (!file) return false;
  const payload = {
    dateKey,
    builtAt: nowIso(),
    blocks: (blocks || []).map((block) => ({
      topicId: block.topicId,
      title: block.title,
      kicker: block.kicker,
      tone: block.tone,
      status: block.status,
      items: block.items || [],
      ...(block.buildingAt ? { buildingAt: block.buildingAt } : {}),
    })),
  };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    atomicWrite(file, JSON.stringify(payload));
    pruneOldDays(userId, dateKey);
    return true;
  } catch (error) {
    /* Кеш — удобство, а не условие работы: без него блок просто соберётся
     * заново на следующем запросе. */
    console.warn(`[topnews] своя тема: кеш не записался: ${String(error?.message || error).slice(0, 140)}`);
    return false;
  }
}

function pruneOldDays(userId, dateKey) {
  const dir = userDir(userId);
  if (!dir) return;
  const oldest = addDaysKey(dateKey, -(KEEP_DAYS - 1));
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const match = /^(\d{4}-\d{2}-\d{2})\.json$/.exec(name);
    /* Ключи сравниваются как строки: для 'YYYY-MM-DD' это верный порядок. */
    if (!match || match[1] >= oldest) continue;
    try {
      fs.unlinkSync(path.join(dir, name));
    } catch {
      /* Не смогли удалить старый день — не повод ломать сборку. */
    }
  }
}

/**
 * Блоки своих тем за указанный день. Нет кеша — пустой список: раздел просто
 * покажет шесть тем выпуска.
 */
export function readPersonalBlocks(userId, dateKey) {
  const day = String(dateKey ?? '').trim() || dateKeyNow();
  const file = dayFile(userId, day);
  if (!file) return [];
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      console.warn(`[topnews] своя тема: кеш не прочитался: ${String(error?.message || error).slice(0, 140)}`);
    }
    return [];
  }
  if (!parsed || parsed.dateKey !== day || !Array.isArray(parsed.blocks)) return [];
  /* Протухшее «собирается» отдаём как отсутствие: раздел по отсутствию сам
   * запускает сборку и показывает «собирается» — то же самое, но уже честно. */
  return parsed.blocks
    .filter((raw) => !isStaleBuilding(raw))
    .map(normaliseBlock)
    .filter(Boolean);
}

/**
 * Убрать из кеша одну свою тему (или весь кеш пользователя, если `topicId` не
 * передан). Нужно после удаления темы: иначе её блок переживёт саму тему.
 */
export function clearPersonalCache(userId, topicId) {
  const dir = userDir(userId);
  if (!dir) return false;
  const target = topicId ? cleanText(topicId, 64) : '';
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return false;
  }
  let touched = false;
  for (const name of names) {
    const match = /^\d{4}-\d{2}-\d{2}\.json$/.exec(name);
    if (!match) continue;
    const file = path.join(dir, name);
    if (!target) {
      try {
        fs.unlinkSync(file);
        touched = true;
      } catch {
        /* Файл уже удалён — цель всё равно достигнута. */
      }
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    if (!parsed || !Array.isArray(parsed.blocks)) continue;
    const rest = parsed.blocks.filter((block) => String(block?.topicId || '') !== target);
    if (rest.length === parsed.blocks.length) continue;
    touched = true;
    try {
      if (!rest.length) fs.unlinkSync(file);
      else atomicWrite(file, JSON.stringify({ ...parsed, blocks: rest }));
    } catch (error) {
      console.warn(`[topnews] своя тема: кеш не очистился: ${String(error?.message || error).slice(0, 140)}`);
    }
  }
  return touched;
}

// ------------------------------------------------------------------
// Сборка

/** Идёт ли сборка своих тем у этого пользователя. */
export function isBuilding(userId) {
  const key = userKey(userId);
  return Boolean(key && inflight.has(key));
}

function hostOf(rawUrl) {
  try {
    return new URL(rawUrl).hostname.replace(/^www\./i, '');
  } catch {
    return '';
  }
}

/**
 * Приводим кандидатов к форме выпуска. Нужно и для устойчивости к заглушкам
 * поиска, и потому что ссылку на первоисточник проверяем здесь, а не в вёрстке.
 */
function normaliseCandidates(raw, cat) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const url = String(item.url || '').trim();
    if (!/^https?:\/\//i.test(url)) continue;
    const title = cleanText(item.title, 200);
    if (title.length < 8) continue;
    const publishedAt = item.publishedAt || item.date || null;
    out.push({
      id: '',
      categoryId: cat.id,
      title,
      summary: cleanText(item.summary, 360),
      url,
      urlKey: String(item.urlKey || url).toLowerCase(),
      titleKey: String(item.titleKey || title).toLowerCase(),
      site: cleanText(item.site, 44) || hostOf(url),
      publishedAt: publishedAt ? String(publishedAt) : null,
      authority: Number.isFinite(Number(item.authority)) ? Number(item.authority) : 2,
      position: Number.isFinite(Number(item.position)) ? Number(item.position) : out.length,
      provider: String(item.provider || 'search'),
      key: '',
    });
  }
  return out;
}

/**
 * Две истории из списка: сначала выбор редактора, потом добор сверху — так же,
 * как собирается общий выпуск. Больше двух не берём никогда.
 */
function chooseTwo(list, picks) {
  const byId = new Map(list.map((item) => [item.id, item]));
  const chosen = [];
  const repeats = (candidate) => chosen.some(({ candidate: other }) => sameStory(other.title, candidate.title));

  for (const pick of Array.isArray(picks) ? picks : []) {
    const candidate = byId.get(String(pick?.candidate || ''));
    if (!candidate || repeats(candidate)) continue;
    chosen.push({ candidate, pick });
    if (chosen.length >= MAX_ITEMS) break;
  }
  /* Редактор мог выбрать одну историю или не ответить совсем. Добор сверху
   * честнее пустого блока: это те же новости, только без отбора. */
  for (const candidate of list) {
    if (chosen.length >= MAX_ITEMS) break;
    if (chosen.some((entry) => entry.candidate === candidate)) continue;
    if (repeats(candidate)) continue;
    chosen.push({ candidate, pick: null });
  }
  /* Две колонки одного издания в блоке из двух строк выглядят как ошибка
   * вёрстки — вторую меняем на материал другого источника. */
  if (chosen.length === MAX_ITEMS && chosen[0].candidate.site === chosen[1].candidate.site) {
    const alt = list.find(
      (item) =>
        !chosen.some((entry) => entry.candidate === item) &&
        item.site !== chosen[0].candidate.site &&
        !sameStory(item.title, chosen[0].candidate.title),
    );
    if (alt) chosen[1] = { candidate: alt, pick: null };
  }
  return chosen.slice(0, MAX_ITEMS);
}

async function buildTopic(topic, { at, dateKey, search, editor }) {
  if (!topic.query) {
    console.warn(`[topnews] своя тема «${topic.title}»: нет поискового запроса`);
    return emptyBlock(topic);
  }
  /* Тема ведёт себя как тема выпуска: тот же поиск, тот же фильтр свежести и
   * тот же редактор. Отличается только тем, что домены не ограничены. */
  const cat = {
    id: topic.id,
    title: topic.title,
    kicker: topic.kicker,
    tone: topic.tone,
    search: true,
    query: topic.query,
    extraQueries: topic.extraQueries,
  };
  const candidates = normaliseCandidates(await search(cat, at), cat);
  if (candidates.length < MAX_ITEMS) return emptyBlock(topic);
  const list = dedupeAndRank(candidates, cat, at);
  if (list.length < MAX_ITEMS) return emptyBlock(topic);

  let picks = null;
  try {
    picks = await editor(dateKey, { [cat.id]: list }, at, [cat]);
  } catch (error) {
    /* Без редактора блок всё равно собирается из верхних историй. */
    console.warn(`[topnews] своя тема «${topic.title}»: редактор не ответил: ${String(error?.message || error).slice(0, 140)}`);
  }
  const chosen = chooseTwo(list, picks?.[cat.id]);
  const items = chosen
    .map(({ candidate, pick }, index) => publicNewsItem(makeItem(cat, candidate, pick, index + 1)))
    .map(normaliseItem)
    .filter(Boolean)
    .slice(0, MAX_ITEMS)
    .map((item, index) => ({ ...item, rank: index + 1 }));
  /* Меньше двух новостей — блок пустой. Ничего не досочиняем: лучше честное
   * «пока пусто», чем новость, которой нет. */
  if (items.length < MAX_ITEMS) return emptyBlock(topic);
  return { ...blockHead(topic), status: 'ready', items };
}

function blocksForTopics(blocks, topics) {
  const byId = new Map((Array.isArray(blocks) ? blocks : []).map((block) => [block.topicId, block]));
  return topics.map((topic) => byId.get(topic.id)).filter(Boolean);
}

/**
 * Собрать недостающие блоки своих тем и вернуть их.
 *
 * Вызывается из раздела: сначала отдать `readPersonalBlocks` (мгновенно), а
 * этот вызов запустить в фоне. Тогда экран видит `building`, а готовые блоки
 * появляются сами. Если дождаться промиса, вернутся уже собранные блоки.
 *
 * `deps` — только для проверок: подменить поиск и редактора без сети и модели.
 */
export async function buildPersonalBlocks(userId, topics, { now, deps } = {}) {
  const at = toDate(now);
  const list = normaliseTopics(topics);
  /* Своих тем нет — работы нет: вызов делается на каждом открытии раздела. */
  if (!list.length) return [];
  const key = userKey(userId);
  if (!key) return [];

  const dateKey = dateKeyNow(at);
  const search = typeof deps?.search === 'function' ? deps.search : searchCategory;
  const editor = typeof deps?.editor === 'function' ? deps.editor : selectWithEditor;

  /* Второй сборки тому же человеку не нужно: дожидаемся первой и отдаём её
   * результат вместо повторного поиска. */
  const running = inflight.get(key);
  if (running) {
    await running.catch(() => {});
    return blocksForTopics(readPersonalBlocks(userId, dateKey), list);
  }

  const cached = readPersonalBlocks(userId, dateKey);
  const cachedById = new Map(cached.map((block) => [block.topicId, block]));
  /* Собираем только то, чего нет. «ready» и «empty» — уже результат за эти
   * сутки; повторять по ним поиск значит платить дважды без пользы. */
  const pending = list.filter((topic) => {
    const block = cachedById.get(topic.id);
    return !block || block.status === 'building';
  });
  if (!pending.length) return blocksForTopics(cached, list);

  const merged = new Map(cached.map((block) => [block.topicId, block]));
  for (const topic of pending) merged.set(topic.id, placeholderBlock(topic));
  /* «Собирается» пишем сразу и синхронно, до первого ожидания: запрос экрана
   * идёт следом за запуском сборки и должен увидеть блок, а не пустоту. */
  persist(userId, dateKey, [...merged.values()]);

  const run = (async () => {
    for (const topic of pending) {
      let block;
      try {
        block = await buildTopic(topic, { at, dateKey, search, editor });
      } catch (error) {
        /* Поиск и модель падают регулярно; своя тема — не повод ронять раздел. */
        console.warn(`[topnews] своя тема «${topic.title}»: ${String(error?.message || error).slice(0, 160)}`);
        block = emptyBlock(topic);
      }
      merged.set(topic.id, block);
      /* Сохраняем после каждой темы: перезапуск процесса не должен терять уже
       * собранное, а незавершённое останется в состоянии «собирается». */
      persist(userId, dateKey, [...merged.values()]);
    }
    return [...merged.values()];
  })();

  inflight.set(key, run);
  try {
    await run;
  } finally {
    inflight.delete(key);
  }
  return blocksForTopics([...merged.values()], list);
}
