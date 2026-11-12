/**
 * telegram — сервис раздела «Телеграм»: каналы, сбор публичных превью t.me,
 * лента, статистика, дайджест и markdown-экспорт.
 *
 * Устроен как остальные прикладные модули сервиса (proofread, design): чистые
 * обработчики, которые зовёт server.mjs (`/api/tg/*`) и инструменты модели.
 * Разбор HTML и все преобразования живут в telegram-core.mjs, здесь — сеть и
 * файлы, поэтому тесты ядра остаются офлайновыми.
 *
 * Хранилище (<data>/telegram, см. TELEGRAM_DIR):
 *   channels.json        {updatedAt, channels:[Channel]}       — writeJson
 *   posts/<username>.jsonl                                     — append-only
 *   collect-state.json   {<username>: {lastCollectedAt, lastError, totalPosts}}
 *   transport.json       {tme:{failures,until,lastError,lastOkAt}, bridge:{…}}
 *                        — предохранитель транспортов (пауза после сбоев)
 *   digests.json         {digests:[Digest]}                    — последние 50
 * Посты намеренно НЕ попадают в index.json: индекс пишется целиком, а лента
 * растёт неограниченно (tg-intel/spec.md §2).
 *
 * Контракт полей — tg-intel/spec.md. Правило «не распарсили → null, а не 0»
 * соблюдается везде; тексты ошибок — по-русски, статус — на Error (server.mjs,
 * общий catch).
 */

import fs from 'node:fs';
import path from 'node:path';

import { MODEL, TELEGRAM, TELEGRAM_BRIDGE, TELEGRAM_DIR } from './config.mjs';
import { atomicWrite, nowIso, readJson, writeJson } from './util.mjs';
import { assertPublicUrl, assertResolvesPublic } from './search.mjs';
import { simpleCompletion } from './agent.mjs';
import {
  aggregateStats,
  breakerFailure,
  breakerPlan,
  breakerSuccess,
  breakerView,
  buildDigestPrompt,
  dedupePosts,
  filterPosts,
  normalizeBreaker,
  normalizeUsername,
  parseChannelInfo,
  parseChannelPage,
  renderDigestSources,
  renderExportMarkdown,
} from './telegram-core.mjs';

/* Браузерный user-agent: t.me отдаёт превью иначе (и может ответить заглушкой)
   ботам, а сервис забирает именно публичную страницу, как обычный читатель. */
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/* Пределы загрузки. Восемь мегабайт — это в десять раз больше самой большой
   реальной страницы t.me/s, но останавливает разросшийся ответ до того, как
   он съест память контейнера. */
const MAX_HTML_BYTES = 8 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 25000;
/* Проверке доступности нельзя висеть как сбор: её дергает интерфейс при
   открытии раздела, поэтому таймаут короткий и без повторов. */
const PROBE_TIMEOUT_MS = 8000;
const NETWORK_ATTEMPTS = 2;
const RETRY_DELAY_MS = 400;

const MAX_POSTS_PER_CHANNEL = 5000;
const COLLECT_LIMIT_DEFAULT = 40;
const COLLECT_LIMIT_MAX = 200;
/* Страница превью отдаёт ~20 постов; глубже добираем через ?before=<id>, но не
   больше четырёх страниц за один сбор — иначе один тяжёлый запрос занимает
   канал на минуту. */
const MAX_COLLECT_PAGES = 4;
const FEED_LIMIT_DEFAULT = 100;
const FEED_LIMIT_MAX = 200;
const DIGEST_KEEP = 50;
const DEFAULT_DIGEST_HOURS = 24;
const DEFAULT_STATS_HOURS = 168;
const PROBE_CHANNEL = 'durov';

/* Мост Telegram (xtrime-ru/TelegramRSS) — второй транспорт: публичный JSON
   канала по MTProto. Нужен там, где контейнер не пускает t.me напрямую.
   Страницы больше пяти сообщений мост не отдаёт: соединение обрывается через
   ~19 с, поэтому набираем пачками по 5 через ?id=<минимальный id − 1>. */
const BRIDGE_TIMEOUT_MS = 25000;
/* Страницы вглубь истории (`id=`) мост отдаёт из кэша: либо быстро (1-3 с),
   либо не отдаёт вовсе, доводя соединение до таймаута. Ждать 25 с на такой
   странице бессмысленно — сбор упрётся в свой бюджет. */
const BRIDGE_DEEP_TIMEOUT_MS = 12000;
const BRIDGE_QUICK_TIMEOUT_MS = 12000;
const BRIDGE_PAGE_SIZE = 5;
const BRIDGE_MAX_PAGES = 8;
/* Появился ли канал — проверяем одним коротким запросом, а не выгрузкой. */
const ADD_CHECK_TIMEOUT_TME_MS = 6000;
const ADD_CHECK_TIMEOUT_BRIDGE_MS = 12000;
const MAX_JSON_BYTES = 8 * 1024 * 1024;

/* Общий троттлер на процесс, по одной очереди на хост: t.me просит не больше
   20 запросов в минуту, мост — 15 на IP (на практике 429 приходит уже на 7-м,
   поэтому интервал моста — 5 с, то есть 12 в минуту). Очередь последовательная:
   следующий запрос уходит не раньше минимального интервала после предыдущего. */
const THROTTLE_WINDOW_MS = 60000;
const TME_MIN_INTERVAL_MS = 3000;
const TME_MAX_PER_WINDOW = 20;
const BRIDGE_MIN_INTERVAL_MS = 5000;
const BRIDGE_MAX_PER_WINDOW = 12;
/* Запрос, прождавший в очереди дольше этого предела, отменяется с понятным
   текстом: лучше честный отказ, чем «крутится» полминуты. */
const QUEUE_WAIT_MAX_MS = 30000;
/* Сколько может длиться один сбор целиком. Дольше держать HTTP-ответ нельзя:
   прокси и браузер отваливаются раньше, поэтому остаток каналов честно
   помечается skipped, а не «пропадает». */
const COLLECT_DEADLINE_MS = 90000;
const BOT_MIN_INTERVAL_MS = 3000;
const BOT_MAX_PER_WINDOW = 20;
/* 429: ждём Retry-After (без заголовка — двадцать секунд) и пробуем один раз. */
const RETRY_AFTER_DEFAULT_MS = 20000;
const RETRY_AFTER_MAX_MS = 90000;

// ---------------------------------------------------------------------------
// Ошибки домена
// ---------------------------------------------------------------------------

function failure(message, status) {
  return Object.assign(new Error(message), { status });
}

const badRequest = (message) => failure(message, 400);
const notFound = (message) => failure(message, 404);
const conflict = (message) => failure(message, 409);
const unavailable = (message) => failure(message, 502);

function messageOf(error) {
  const text = String(error?.message || error || '').trim();
  return text || 'Неизвестная ошибка';
}

/** Убрать из текста секреты (токен бота) — он попадает в URL getMe. */
function cleanMessage(error) {
  const text = messageOf(error);
  const token = String(TELEGRAM.token || '');
  return token ? text.split(token).join('***') : text;
}

// ---------------------------------------------------------------------------
// Файлы состояния
// ---------------------------------------------------------------------------

const channelsFile = () => path.join(TELEGRAM_DIR, 'channels.json');
const postsDir = () => path.join(TELEGRAM_DIR, 'posts');
const postsFile = (username) => path.join(postsDir(), `${username}.jsonl`);
const collectStateFile = () => path.join(TELEGRAM_DIR, 'collect-state.json');
const digestsFile = () => path.join(TELEGRAM_DIR, 'digests.json');
const transportFile = () => path.join(TELEGRAM_DIR, 'transport.json');

/** Каталог постов: TELEGRAM_DIR создаёт ensureDirs(), подкаталог — здесь. */
function ensureStore() {
  fs.mkdirSync(postsDir(), { recursive: true });
}

/** Формат имени канала из контракта: без @, нижний регистр, [a-z0-9_]{4,32}. */
function isChannelName(value) {
  return /^[a-z0-9_]{4,32}$/.test(String(value || ''));
}

function readChannels() {
  const data = readJson(channelsFile(), null);
  const list = Array.isArray(data?.channels) ? data.channels : [];
  const channels = list.filter((channel) => channel && isChannelName(channel.username) && channel.active !== null);
  return { updatedAt: data?.updatedAt || null, channels };
}

function saveChannels(channels) {
  ensureStore();
  writeJson(channelsFile(), { updatedAt: nowIso(), channels });
}

function readCollectState() {
  const data = readJson(collectStateFile(), null);
  return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
}

function saveCollectState(state) {
  ensureStore();
  writeJson(collectStateFile(), state);
}

// ---------------------------------------------------------------------------
// Предохранитель транспортов (правила — в telegram-core.mjs)
// ---------------------------------------------------------------------------

/* Состояние держим в памяти процесса и переживает перезапуск через файл: иначе
   после каждого рестарта контейнера мы снова бьёмся в донора, который нас уже
   ограничил, и платим те самые минуты ожидания. */
let BREAKER = null;

function breakerState() {
  if (!BREAKER) BREAKER = normalizeBreaker(readJson(transportFile(), null));
  return BREAKER;
}

/** Записать новое состояние предохранителя (файл маленький, пишем целиком). */
function saveBreaker(next) {
  BREAKER = next;
  try {
    ensureStore();
    writeJson(transportFile(), next);
  } catch (error) {
    /* Права на запись не должны валить сбор: пауза проживёт в памяти. */
    console.warn(`[tg] состояние предохранителя не сохранилось: ${messageOf(error)}`);
  }
}

/** «4 мин», «40 с», «1 ч 5 мин» — короткий срок ожидания для человека. */
function humanWait(ms) {
  const seconds = Math.max(0, Math.round(Number(ms) / 1000));
  if (seconds < 60) return `${seconds} с`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} мин`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} ч ${rest} мин` : `${hours} ч`;
}

const transportLabel = (kind) => (kind === 'bridge' ? 'мост tg.i-c-a.su' : 't.me');

/**
 * Считать ли отказ канала отказом транспорта. «Канал не найден» (400/404) —
 * свойство канала, а не сети: за такое на паузу не ставим, иначе один опечаткой
 * введённый канал выключал бы транспорт целиком.
 */
function isTransportFailure(error) {
  const status = Number(error?.httpStatus || error?.status) || 0;
  if (status === 400 || status === 404 || status === 409) return false;
  /* 499 — человек сам отменил запрос; это не болезнь транспорта. */
  if (status === 499) return false;
  if (error?.notFound) return false;
  return true;
}

/** Слепок для /api/tg/health и tg_probe: что происходит с транспортами сейчас. */
export function transportStatus() {
  const view = breakerView(breakerState(), Date.now());
  return {
    tme: { ...view.tme, label: transportLabel('tme') },
    bridge: { ...view.bridge, label: transportLabel('bridge') },
    updatedAt: breakerState().updatedAt || null,
  };
}

/** Строки JSONL → посты. Битая строка не роняет ленту: её просто не видно. */
function readPosts(username) {
  if (!isChannelName(username)) return [];
  let raw;
  try {
    raw = fs.readFileSync(postsFile(username), 'utf8');
  } catch {
    return [];
  }
  const posts = [];
  for (const line of raw.split('\n')) {
    const text = line.trim();
    if (!text) continue;
    try {
      const post = JSON.parse(text);
      if (post && post.id !== undefined && post.id !== null) posts.push(post);
    } catch {
      /* строка оборвана — например, контейнер выключили посреди записи */
    }
  }
  return posts;
}

/** Дописать новые посты. Порядок — от старых к новым, чтобы обрезка файла
 *  оставляла свежее: так JSONL остаётся хронологическим. */
function appendPosts(username, posts) {
  if (!posts.length) return;
  ensureStore();
  const lines = posts.map((post) => JSON.stringify(post)).join('\n');
  fs.appendFileSync(postsFile(username), `${lines}\n`, 'utf8');
}

/** Обрезать файл канала до последних MAX_POSTS_PER_CHANNEL строк.
 *  Возвращает фактическое число строк после записи (оно же totalPosts). */
function trimPostsFile(username) {
  const file = postsFile(username);
  let raw = '';
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return 0;
  }
  const lines = raw.split('\n').filter((line) => line.trim());
  if (lines.length > MAX_POSTS_PER_CHANNEL) {
    const kept = lines.slice(lines.length - MAX_POSTS_PER_CHANNEL);
    atomicWrite(file, `${kept.join('\n')}\n`);
    return kept.length;
  }
  return lines.length;
}

/** Все посты нужных каналов. Без списка — всех, что есть в channels.json.
 *  Дедуп по (ch, id): две параллельные сборки не должны дать двойную новость. */
function readAllPosts(usernames = null) {
  const names = Array.isArray(usernames) && usernames.length
    ? usernames
    : readChannels().channels.map((channel) => channel.username);
  const posts = [];
  for (const username of names) {
    if (!isChannelName(username)) continue;
    posts.push(...readPosts(username));
  }
  return dedupePosts(posts);
}

// ---------------------------------------------------------------------------
// Загрузка t.me
// ---------------------------------------------------------------------------

/** Сеть до Telegram — отдельный класс ошибок: только их и имеет смысл повторять. */
function isNetworkProblem(error) {
  if (!error) return false;
  if (error.reason === 'http' || error.reason === 'size') return false;
  if (error.name === 'AbortError' || error.name === 'TimeoutError') return true;
  if (error.name === 'TypeError') return true;
  const code = String(error?.cause?.code || error?.code || '');
  return /ECONN|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|EAI_FAIL|UND_ERR|EPIPE/.test(code);
}

function abortSignal(timeoutMs, signal) {
  const deadline = AbortSignal.timeout(timeoutMs);
  if (!signal) return deadline;
  /* Отмена вызывающим (кнопка «Стоп» у инструмента) плюс собственный таймаут. */
  return typeof AbortSignal.any === 'function' ? AbortSignal.any([signal, deadline]) : deadline;
}

/* Ожидание обязано держать петлю событий: иначе вызов модуля без живого сервера
   («Detected unsettled top-level await») обрывается на середине очереди. */
function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Тело ответа с жёстким пределом: лишнее не дочитываем, поток отменяем. */
async function readLimited(body, limit, username) {
  const tooBig = () => Object.assign(
    unavailable(`Страница канала @${username} больше ${Math.round(limit / (1024 * 1024))} МБ — загрузка остановлена`),
    { reason: 'size' },
  );
  if (!body) return '';
  const reader = body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      try {
        await reader.cancel();
      } catch {
        /* поток уже закрыт — отменять нечего */
      }
      throw tooBig();
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Причина неудачи словами человека, а не кодом платформы. */
function describeFetchFailure(error, username, timeoutMs) {
  if (error?.reason === 'http' || error?.reason === 'size') return error;
  if (error?.name === 'AbortError' || error?.name === 'TimeoutError') {
    return unavailable(
      `t.me не ответил за ${Math.round(timeoutMs / 1000)} с — похоже, сеть до Telegram недоступна. Канал @${username} не загружен`,
    );
  }
  const cause = String(error?.cause?.code || error?.cause?.message || error?.message || error || 'неизвестная ошибка');
  return unavailable(`t.me недоступен (${cause}). Канал @${username} не загружен`);
}

/**
 * Страница публичного превью канала: https://t.me/s/<username>[?before=<id>].
 * Охранники — из search.mjs (публичный адрес + проверка DNS), дальше обычный
 * fetch с браузерным user-agent. Повторы — только на сетевых ошибках: ответ
 * 404/403 повторять бессмысленно.
 * @returns {Promise<{html: string, status: number, url: string}>}
 */
async function loadTmePage(username, options = {}) {
  const before = Number(options.before) > 0 ? Math.trunc(Number(options.before)) : 0;
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : FETCH_TIMEOUT_MS;
  const attempts = Math.max(1, Math.trunc(Number(options.attempts) || NETWORK_ATTEMPTS));
  const signal = options.signal;

  let url;
  try {
    url = assertPublicUrl(`https://t.me/s/${encodeURIComponent(username)}${before ? `?before=${before}` : ''}`);
  } catch (error) {
    throw unavailable(`t.me недоступен: ${messageOf(error)}`);
  }

  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (signal?.aborted) throw failure('Загрузка канала отменена', 499);
    try {
      const response = await tgRequest(url, {
        queue: 'tme',
        headers: {
          accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
          'accept-language': 'ru-RU,ru;q=0.9,en;q=0.8',
        },
        timeoutMs,
        signal,
      });
      if (!response.ok) {
        throw Object.assign(
          unavailable(`t.me ответил ${response.status} на запрос @${username} — канал недоступен`),
          { reason: 'http', httpStatus: response.status },
        );
      }
      const html = await readLimited(response.body, MAX_HTML_BYTES, username);
      return { html, status: response.status, url: url.href };
    } catch (error) {
      lastError = error;
      if (!isNetworkProblem(error) || attempt >= attempts) break;
      await delay(RETRY_DELAY_MS * attempt);
    }
  }
  throw describeFetchFailure(lastError, username, timeoutMs);
}

// ---------------------------------------------------------------------------
// Троттлер исходящих запросов
// ---------------------------------------------------------------------------

/**
 * Последовательная очередь с минимальным интервалом и окном на минуту.
 * Возвращает «выполнить работу, когда можно»; ошибка работы очередь не ломает.
 * Запрос, прождавший больше QUEUE_WAIT_MAX_MS, отменяется с отказом 503.
 */
function createThrottleQueue(name, minIntervalMs, maxPerWindow) {
  const state = { lastAt: 0, stamps: [], chain: Promise.resolve() };
  return function enqueue(work) {
    const queuedAt = Date.now();
    const run = state.chain.then(async () => {
      const waited = Date.now() - queuedAt;
      if (waited > QUEUE_WAIT_MAX_MS) {
        const pauseLeft = Math.max(0, (COOLDOWN[name] || 0) - Date.now());
        const hint = pauseLeft > 0
          ? ` Telegram просит подождать ещё ${Math.ceil(pauseLeft / 1000)} с.`
          : '';
        throw Object.assign(
          new Error(
            `Очередь запросов к Telegram занята: запрос прождал ${Math.round(waited / 1000)} с и отменён.${hint}`,
          ),
          { status: 503 },
        );
      }
      for (;;) {
        const now = Date.now();
        state.stamps = state.stamps.filter((at) => now - at < THROTTLE_WINDOW_MS);
        let wait = Math.max(0, minIntervalMs - (now - state.lastAt));
        if (state.stamps.length >= maxPerWindow) {
          wait = Math.max(wait, state.stamps[0] + THROTTLE_WINDOW_MS - now + 50);
        }
        if (wait <= 0) break;
        await delay(wait);
      }
      state.lastAt = Date.now();
      state.stamps.push(state.lastAt);
      return work();
    });
    state.chain = run.then(() => undefined, () => undefined);
    return run;
  };
}

const THROTTLES = {
  tme: createThrottleQueue('tme', TME_MIN_INTERVAL_MS, TME_MAX_PER_WINDOW),
  bridge: createThrottleQueue('bridge', BRIDGE_MIN_INTERVAL_MS, BRIDGE_MAX_PER_WINDOW),
  bot: createThrottleQueue('bot', BOT_MIN_INTERVAL_MS, BOT_MAX_PER_WINDOW),
};

/**
 * Общая пауза на хост после 429: ждать должны ВСЕ следующие запросы, а не только
 * тот, что получил отказ. Иначе интерфейс долбит мост и продлевает себе бан.
 */
const COOLDOWN = { tme: 0, bridge: 0, bot: 0 };

/** Сколько ждать по Retry-After: секунды или HTTP-дата; без заголовка — 20 с. */
function retryAfterMs(value) {
  const text = String(value || '').trim();
  const seconds = Number(text);
  if (text && Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, RETRY_AFTER_MAX_MS);
  if (text) {
    const at = Date.parse(text);
    if (Number.isFinite(at)) return Math.max(0, Math.min(at - Date.now(), RETRY_AFTER_MAX_MS));
  }
  return RETRY_AFTER_DEFAULT_MS;
}

/**
 * Один запрос к хосту Telegram: охранники адреса, очередь, разбор 429.
 * На 429 ждём Retry-After и повторяем ровно один раз — иначе наш собственный
 * сбор становится источником того самого ограничения.
 */
async function tgRequest(target, options = {}) {
  const kind = options.queue && THROTTLES[options.queue] ? options.queue : 'tme';
  const queue = THROTTLES[kind];
  let url;
  try {
    url = assertPublicUrl(typeof target === 'string' ? target : String(target));
  } catch (error) {
    throw unavailable(`Запрос к Telegram отклонён проверкой адреса: ${messageOf(error)}`);
  }
  const signal = options.signal;
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : FETCH_TIMEOUT_MS;

  for (let attempt = 0; ; attempt += 1) {
    if (signal?.aborted) throw failure('Запрос к Telegram отменён', 499);
    try {
      await assertResolvesPublic(url.hostname);
    } catch (error) {
      throw unavailable(`Не удалось проверить адрес ${url.hostname}: ${messageOf(error)}`);
    }

    const response = await queue(async () => {
      /* Пауза после 429 выдерживается внутри очереди: так её ждут и следующие
         запросы, а не только повтор этого. */
      const wait = (COOLDOWN[kind] || 0) - Date.now();
      if (wait > 0) await delay(wait);
      let result;
      try {
        result = await fetch(url, {
          headers: { 'user-agent': USER_AGENT, ...(options.headers || {}) },
          redirect: 'follow',
          signal: abortSignal(timeoutMs, signal),
        });
      } catch (error) {
        /* Причина видна только в cause: без этой строки в журнале остаётся
           бесполезное «fetch failed». */
        console.warn(`[tg] ${url.hostname}: запрос не удался — ${causeText(error)}`);
        throw error;
      }
      if (result.status === 429) {
        const pause = retryAfterMs(result.headers.get('retry-after'));
        COOLDOWN[kind] = Math.max(COOLDOWN[kind] || 0, Date.now() + pause);
        console.warn(`[tg] ${url.hostname}: 429, пауза ${Math.round(pause / 1000)} с для всех запросов`);
        try {
          await result.body?.cancel();
        } catch {
          /* тело уже закрыто */
        }
      }
      return result;
    });

    if (response.status !== 429 || attempt >= 1) return response;
    /* Повтор уйдёт после паузы, которую выставил сам 429 (её ждёт очередь). */
  }
}

// ---------------------------------------------------------------------------
// Мост Telegram (xtrime-ru/TelegramRSS) — второй транспорт
// ---------------------------------------------------------------------------

function causeText(error) {
  return String(error?.cause?.code || error?.cause?.message || error?.message || error || 'неизвестная ошибка');
}

/** Человеческая причина отказа моста: таймаут и обрыв связи читаются по-разному. */
function describeBridgeFailure(error, timeoutMs = BRIDGE_TIMEOUT_MS) {
  const text = causeText(error);
  if (error?.name === 'TimeoutError' || /abort/i.test(text)) {
    return `мост не ответил за ${Math.round(timeoutMs / 1000)} с`;
  }
  if (/ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|UND_ERR|fetch failed/i.test(text)) {
    return `мост не отвечает (${text})`;
  }
  return text;
}

/** Раскодировать сущности, которые присылает мост в HTML-тексте сообщения. */
function decodeEntities(text) {
  return String(text || '')
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

/**
 * HTML сообщения моста → плоский Post.text.
 * Абзацы и переносы становятся \n, ссылка остаётся видимой подписью с адресом
 * в скобках (так же, как в превью t.me), tg-emoji разворачивается в сам эмодзи.
 */
function bridgeText(html) {
  let text = String(html || '');
  text = text.replace(/<br\s*\/?>/gi, '\n').replace(/<\/p\s*>/gi, '\n');
  text = text.replace(/<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href, label) => {
    const url = decodeEntities(href).trim();
    const caption = decodeEntities(String(label).replace(/<[^>]*>/g, '')).trim();
    if (!caption || caption === url) return url;
    return `${caption} (${url})`;
  });
  text = text.replace(/<tg-emoji\b[^>]*>([\s\S]*?)<\/tg-emoji>/gi, '$1');
  text = text.replace(/<[^>]*>/g, '');
  text = decodeEntities(text);
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Ссылки из HTML сообщения — так же, как их собирает ядро из превью. */
function bridgeLinks(html) {
  const found = new Set();
  const re = /\bhref\s*=\s*["']([^"']+)["']/gi;
  let match;
  while ((match = re.exec(String(html || '')))) {
    const url = decodeEntities(match[1]).trim();
    if (/^https?:\/\//i.test(url)) found.add(url);
  }
  return [...found].slice(0, 20);
}

/** Медиа моста → hasMedia/mediaKind из контракта: photo | video | poll | null. */
function bridgeMedia(media) {
  if (!media || typeof media !== 'object') return { hasMedia: false, mediaKind: null };
  const kind = String(media._ || '');
  if (kind === 'messageMediaPhoto') return { hasMedia: true, mediaKind: 'photo' };
  if (kind === 'messageMediaPoll') return { hasMedia: true, mediaKind: 'poll' };
  /* Превью ссылки — не медиа поста. */
  if (kind === 'messageMediaWebPage') return { hasMedia: false, mediaKind: null };
  if (kind === 'messageMediaDocument') {
    let hint = '';
    try {
      hint = JSON.stringify(media).toLowerCase();
    } catch {
      hint = '';
    }
    return { hasMedia: true, mediaKind: hint.includes('video') ? 'video' : null };
  }
  return { hasMedia: true, mediaKind: null };
}

/** Сообщение TL-JSON → Post. Без id пост бесполезен: дедупликация по (ch, id). */
function bridgePost(message, username) {
  const id = Number(message?.id);
  if (!Number.isFinite(id) || id <= 0) return null;
  const seconds = Number(message?.date);
  const date = Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000).toISOString() : null;
  const views = Number(message?.views);
  const forwards = Number(message?.forwards);
  const html = typeof message?.message === 'string' ? message.message : '';
  const media = bridgeMedia(message?.media);
  return {
    ch: username,
    id: Math.trunc(id),
    date,
    text: bridgeText(html),
    views: Number.isFinite(views) && views >= 0 ? Math.trunc(views) : null,
    forwards: Number.isFinite(forwards) && forwards >= 0 ? Math.trunc(forwards) : null,
    url: `https://t.me/${username}/${Math.trunc(id)}`,
    links: bridgeLinks(html),
    hasMedia: media.hasMedia,
    mediaKind: media.mediaKind,
  };
}

/**
 * Заголовок канала из chats/users. В chats лежит не только сам канал, но и чат
 * комментариев и пересланные каналы, поэтому сначала ищем совпадение по
 * username, и только потом берём первую сущность с непустым title.
 */
function bridgeTitle(data, username) {
  const entities = [
    ...(Array.isArray(data?.chats) ? data.chats : []),
    ...(Array.isArray(data?.users) ? data.users : []),
  ].filter((item) => item && typeof item === 'object');
  const target = String(username || '').toLowerCase();
  const byUsername = entities.find((item) => String(item.username || '').toLowerCase() === target);
  const candidate = byUsername || entities.find((item) => String(item.title || '').trim());
  if (!candidate) return null;
  const raw = candidate.title
    || [candidate.first_name, candidate.last_name].filter(Boolean).join(' ');
  const title = String(raw || '').trim();
  return title || null;
}

/** Есть ли в ответе сущность именно запрошенного канала. */
function bridgeMatchesChannel(data, username) {
  const target = String(username || '').toLowerCase();
  const entities = [
    ...(Array.isArray(data?.chats) ? data.chats : []),
    ...(Array.isArray(data?.users) ? data.users : []),
  ];
  return entities.some((item) => item && String(item.username || '').toLowerCase() === target);
}

/**
 * JSON канала с моста: https://tg.i-c-a.su/json/<username>?limit=5&id=<id>
 *
 * Мост отдаёт не больше пяти сообщений за раз (на больших страницах он рвёт
 * соединение), поэтому набираем нужное количество пачками по пять: параметр
 * `id` — нижняя граница (мост включает её, поэтому берём минимальный id − 1).
 * Первый же сбой страницы останавливает цикл: накопленное возвращается с
 * partial:true, пустой результат остаётся ошибкой. Общий `deadline` сбора
 * обрезает и ожидание, и таймаут каждой страницы.
 */
async function fetchViaBridge(username, options = {}) {
  if (!TELEGRAM_BRIDGE) throw unavailable('Мост Telegram не настроен: DSHOW_TG_BRIDGE пуст');
  const limit = Math.min(BRIDGE_MAX_PAGES * BRIDGE_PAGE_SIZE, Math.max(1, Math.trunc(Number(options.limit) || COLLECT_LIMIT_DEFAULT)));
  const pageCount = Math.min(BRIDGE_MAX_PAGES, Math.ceil(limit / BRIDGE_PAGE_SIZE));
  const timeoutMs = Number(options.bridgeTimeoutMs) > 0 ? Number(options.bridgeTimeoutMs) : BRIDGE_TIMEOUT_MS;

  const found = new Map();
  const deadline = options.deadline || 0;
  let title = null;
  let count = null;
  let matched = false;
  let status = 0;
  let partial = false;
  let pages = 0;
  let nextId = null;

  for (let page = 1; page <= pageCount; page += 1) {
    const left = timeLeft(deadline);
    if (left < 3000) {
      if (!found.size) {
        throw unavailable(`Сбор не уложился в ${Math.round(COLLECT_DEADLINE_MS / 1000)} с — повторите позже`);
      }
      partial = true;
      break;
    }
    const perRequest = budgetTimeout(page === 1 ? timeoutMs : Math.min(timeoutMs, BRIDGE_DEEP_TIMEOUT_MS), deadline);
    const query = new URLSearchParams({ limit: String(BRIDGE_PAGE_SIZE) });
    if (nextId !== null) query.set('id', String(nextId));
    const url = `${TELEGRAM_BRIDGE}/json/${encodeURIComponent(username)}?${query.toString()}`;

    let response;
    try {
      response = await tgRequest(url, {
        queue: 'bridge',
        headers: { accept: 'application/json' },
        timeoutMs: perRequest,
        signal: options.signal,
      });
    } catch (error) {
      if (!found.size) {
        if (error?.status) throw error;
        throw unavailable(`Мост Telegram недоступен (${describeBridgeFailure(error, perRequest)})`);
      }
      partial = true;
      break;
    }
    if (!response.ok) {
      const failure = Object.assign(
        unavailable(`Мост Telegram ответил ${response.status} на запрос @${username}`),
        { reason: 'http', httpStatus: response.status },
      );
      if (!found.size) throw failure;
      partial = true;
      break;
    }

    const raw = await readLimited(response.body, MAX_JSON_BYTES, username);
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      if (!found.size) throw unavailable(`Мост Telegram прислал не JSON (@${username})`);
      partial = true;
      break;
    }

    if (page === 1) {
      title = bridgeTitle(data, username);
      const total = Number(data?.count);
      count = Number.isFinite(total) ? total : null;
      matched = bridgeMatchesChannel(data, username);
      status = response.status;
    }

    const messages = Array.isArray(data?.messages) ? data.messages : [];
    let added = 0;
    for (const message of messages) {
      const post = bridgePost(message, username);
      if (!post || found.has(post.id)) continue;
      found.set(post.id, post);
      added += 1;
    }
    pages = page;
    /* Пустая страница — дальше листать нечего. Повторы на первой странице
       нормальны (новых постов нет), но это не повод останавливаться: мост
       отдаёт окно по `id`, и следующая страница уходит глубже в историю. */
    if (!messages.length) break;
    if (found.size >= limit) break;
    const lowest = Math.min(...found.keys());
    nextId = lowest - 1;
    if (nextId <= 0) break;
  }

  const posts = [...found.values()].sort((a, b) => a.id - b.id).slice(-limit);
  return {
    via: 'bridge',
    username,
    title,
    posts,
    found: null,
    count,
    messages: found.size,
    matched,
    status,
    partial,
    pages,
  };
}

/** Превью t.me: одна или несколько страниц через ?before=<id>. */
async function fetchViaTme(username, options = {}) {
  const limit = Math.min(COLLECT_LIMIT_MAX, Math.max(1, Math.trunc(Number(options.limit) || COLLECT_LIMIT_DEFAULT)));
  const signal = options.signal;
  const timeoutMs = Number(options.tmeTimeoutMs) > 0 ? Number(options.tmeTimeoutMs) : undefined;
  const attempts = Number(options.tmeAttempts) > 0 ? Number(options.tmeAttempts) : undefined;
  const pages = Math.min(MAX_COLLECT_PAGES, Math.max(1, Math.ceil(limit / 20)));
  const found = { wraps: 0, texts: 0, dates: 0 };
  const posts = [];
  const deadline = options.deadline || 0;
  let title = null;
  let htmlBytes = 0;
  let status = 0;
  let before = 0;

  for (let page = 1; page <= pages; page += 1) {
    if (timeLeft(deadline) < 2500) break;
    const perRequest = budgetTimeout(timeoutMs || FETCH_TIMEOUT_MS, deadline);
    const result = await loadTmePage(username, {
      before,
      signal,
      timeoutMs: perRequest,
      attempts: deadline ? 1 : attempts,
    });
    status = result.status;
    htmlBytes += Buffer.byteLength(result.html, 'utf8');
    if (page === 1) title = parseChannelInfo(result.html).title;
    const parsed = parseChannelPage(result.html, username);
    found.wraps += Number(parsed.found?.wraps) || 0;
    found.texts += Number(parsed.found?.texts) || 0;
    found.dates += Number(parsed.found?.dates) || 0;
    if (!parsed.posts.length) break;
    posts.push(...parsed.posts);
    if (posts.length >= limit) break;
    const oldest = parsed.posts.reduce(
      (min, post) => (Number.isFinite(post.id) && (min === null || post.id < min) ? post.id : min),
      null,
    );
    if (oldest === null || (before && oldest >= before)) break;
    before = oldest;
  }

  return {
    via: 'tme',
    username,
    title,
    posts: dedupePosts(posts).slice(0, limit),
    found,
    htmlBytes,
    status,
  };
}

/** Остаток бюджета сбора (0 и меньше — времени не осталось). */
function timeLeft(deadline) {
  if (!deadline) return Infinity;
  return deadline - Date.now();
}

/** Таймаут одного запроса с учётом общего бюджета: не больше остатка. */
function budgetTimeout(baseMs, deadline) {
  const left = timeLeft(deadline);
  if (left === Infinity) return baseMs;
  return Math.max(2500, Math.min(baseMs, left - 500));
}

/**
 * Канал через первый доступный транспорт: по умолчанию t.me, при его отказе
 * (сеть, 403/429, страница без шапки) — мост. `prefer` меняет порядок.
 * Транспорт, который уже дважды подряд не ответил, на паузе: его не пробуют,
 * поэтому один сломанный донор не съедает минуту ожидания (см. предохранитель
 * в telegram-core.mjs). Если на паузе оба — честный отказ со сроком, а не
 * «крутится», и следующий автосбор сделает работу сам.
 *
 * «Канал не найден» (оба транспорта ответили пусто) бросается с флагом
 * notFound: по нему addChannel отвечает 400, а не 502.
 *
 * `deadline` — общий дедлайн сбора: если бюджета осталось меньше двадцати
 * секунд, t.me уже не пробуем (он один может съесть весь остаток), сразу мост.
 */
async function fetchChannel(username, options = {}) {
  const tight = timeLeft(options.deadline) < 20000;
  const base = options.prefer === 'bridge' || tight ? ['bridge', 'tme'] : ['tme', 'bridge'];
  const plan = breakerPlan(base, breakerState(), Date.now());
  if (!plan.order.length) {
    const waiting = plan.waiting.map((item) => `${transportLabel(item.kind)} — ещё ${humanWait(item.retryInMs)}`);
    throw Object.assign(
      unavailable(
        `Транспорты на паузе после сбоев: ${waiting.join(', ')}. ` +
          'Данные обновятся сами, как только связь вернётся; можно повторить сбор позже.',
      ),
      { breakerOpen: true, retryAfterMs: plan.retryInMs },
    );
  }

  const failures = [];

  for (const kind of plan.order) {
    try {
      if (kind === 'tme') {
        const result = await fetchViaTme(username, options);
        if (!result.title && !result.posts.length) {
          failures.push({
            kind,
            notFound: true,
            error: unavailable(`t.me отдал страницу без шапки канала @${username}`),
          });
          continue;
        }
        saveBreaker(breakerSuccess(breakerState(), kind));
        return result;
      }
      const result = await fetchViaBridge(username, options);
      const empty = !result.posts.length && !(Number(result.count) > 0) && !result.matched;
      if (empty) {
        failures.push({ kind, notFound: true, error: unavailable(`мост не нашёл сообщений @${username}`) });
        continue;
      }
      saveBreaker(breakerSuccess(breakerState(), kind));
      return result;
    } catch (error) {
      failures.push({ kind, error });
      /* Отказ сети или донора — считаем; «канал не найден» и отмену человеком нет:
         это в isTransportFailure, чтобы правило было одно на все вызовы. */
      if (isTransportFailure(error)) {
        saveBreaker(breakerFailure(breakerState(), kind, { error: cleanMessage(error) }));
      }
    }
  }

  const notFound = failures.some(
    (item) => item.notFound || item.error?.httpStatus === 404 || item.error?.httpStatus === 400,
  );
  const text = failures
    .map((item) => `${item.kind === 'tme' ? 't.me' : 'мост'}: ${messageOf(item.error)}`)
    .join('; ');
  throw Object.assign(
    unavailable(`Канал @${username} не загружен — ${text}`),
    notFound ? { notFound: true } : {},
  );
}

// ---------------------------------------------------------------------------
// probe — живая проверка транспорта
// ---------------------------------------------------------------------------

/** Короткая улика из страницы: первые 300 знаков без переносов строк. По ней
 *  на живом t.me сразу видно, что пришло — превью канала или заглушка. */
function htmlSnippet(html) {
  return String(html || '').replace(/\s+/g, ' ').trim().slice(0, 300);
}

async function probeTme(username) {
  const started = Date.now();
  try {
    const page = await loadTmePage(username, { timeoutMs: PROBE_TIMEOUT_MS, attempts: 1 });
    const parsed = parseChannelPage(page.html, username);
    return {
      ok: true,
      ms: Date.now() - started,
      status: page.status,
      channel: username,
      htmlBytes: Buffer.byteLength(page.html, 'utf8'),
      postsParsed: parsed.posts.length,
      found: parsed.found,
      snippet: htmlSnippet(page.html),
    };
  } catch (error) {
    return {
      ok: false,
      ms: Date.now() - started,
      channel: username,
      status: error?.httpStatus || undefined,
      error: cleanMessage(error),
    };
  }
}

/** Bot API проверяем только если токен задан; без токена — честно «не настроен». */
async function probeBotApi() {
  if (!TELEGRAM.token) {
    return { ok: false, ms: 0, configured: false, error: 'Токен бота не задан (DSHOW_TG_TOKEN)' };
  }
  const started = Date.now();
  try {
    const response = await tgRequest(`https://api.telegram.org/bot${TELEGRAM.token}/getMe`, {
      queue: 'bot',
      headers: { accept: 'application/json' },
      timeoutMs: PROBE_TIMEOUT_MS,
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || !data?.ok) {
      return {
        ok: false,
        ms: Date.now() - started,
        status: response.status,
        error: cleanMessage(data?.description || `api.telegram.org ответил ${response.status}`),
      };
    }
    return { ok: true, ms: Date.now() - started, status: response.status };
  } catch (error) {
    return { ok: false, ms: Date.now() - started, error: cleanMessage(error) };
  }
}

/** Мост: JSON канала отвечает и там, где t.me закрыт для контейнера. */
async function probeBridge(username) {
  if (!TELEGRAM_BRIDGE) {
    return { ok: false, ms: 0, configured: false, error: 'Мост не настроен (DSHOW_TG_BRIDGE)' };
  }
  const started = Date.now();
  try {
    const response = await tgRequest(`${TELEGRAM_BRIDGE}/json/${encodeURIComponent(username)}?limit=1`, {
      queue: 'bridge',
      headers: { accept: 'application/json' },
      timeoutMs: BRIDGE_QUICK_TIMEOUT_MS,
    });
    if (!response.ok) {
      return {
        ok: false,
        ms: Date.now() - started,
        channel: username,
        status: response.status,
        error: `Мост ответил ${response.status} на запрос @${username}`,
      };
    }
    const raw = await readLimited(response.body, MAX_JSON_BYTES, username);
    let data = null;
    try {
      data = JSON.parse(raw);
    } catch {
      return { ok: false, ms: Date.now() - started, status: response.status, error: 'Мост прислал не JSON' };
    }
    const messages = Array.isArray(data?.messages) ? data.messages : [];
    const count = Number(data?.count);
    return {
      ok: true,
      ms: Date.now() - started,
      channel: username,
      status: response.status,
      title: bridgeTitle(data, username),
      messages: messages.length,
      count: Number.isFinite(count) ? count : null,
      sample: messages[0] ? bridgeText(messages[0].message || '').slice(0, 200) : '',
    };
  } catch (error) {
    return {
      ok: false,
      ms: Date.now() - started,
      channel: username,
      error: cleanMessage(describeBridgeFailure(error, BRIDGE_QUICK_TIMEOUT_MS)),
    };
  }
}

/** Сводка сбора: по каналам и самая свежая дата. */
function collectSummary() {
  const state = readCollectState();
  const collected = {};
  let updatedAt = null;
  for (const [username, entry] of Object.entries(state)) {
    if (!isChannelName(username) || !entry || typeof entry !== 'object') continue;
    collected[username] = Number(entry.totalPosts) || 0;
    if (entry.lastCollectedAt && (!updatedAt || String(entry.lastCollectedAt) > String(updatedAt))) {
      updatedAt = entry.lastCollectedAt;
    }
  }
  return { collected, updatedAt };
}

/**
 * Свежесть данных без сети: когда собирали в последний раз и сколько постов
 * лежит по каналам. Для /api/tg/health и строки «обновлено …» в интерфейсе.
 */
export function freshness() {
  const summary = collectSummary();
  return { updatedAt: summary.updatedAt, collected: summary.collected, active: collectStateErrors() };
}

/** Ошибки последнего сбора по каналам — по ним видно, что именно отстало. */
function collectStateErrors() {
  const state = readCollectState();
  const errors = [];
  for (const [username, entry] of Object.entries(state)) {
    if (!isChannelName(username) || !entry || typeof entry !== 'object') continue;
    if (!entry.lastError) continue;
    errors.push({ username, error: String(entry.lastError).slice(0, 200), at: entry.lastCollectedAt || null });
  }
  return errors;
}

/**
 * Живые проверки транспортов: превью t.me, мост TelegramRSS (если настроен) и
 * Bot API (если задан токен). Канал — первый активный, иначе @durov.
 * Никогда не бросает: отказ каждого транспорта внутри {ok:false,error}.
 */
export async function probe() {  try {
    const { channels, updatedAt } = readChannels();
    const active = channels.find((channel) => channel.active !== false);
    const target = active?.username || PROBE_CHANNEL;
    const [tme, bridge, botapi] = await Promise.all([
      probeTme(target),
      probeBridge(target),
      probeBotApi(),
    ]);
    const summary = collectSummary();
    return {
      ok: Boolean(tme.ok || bridge.ok),
      tme,
      bridge,
      botapi,
      /* Что сейчас с транспортами: пауза после сбоев видна сразу, а не только
         по ошибкам сбора. probe сам паузу не соблюдает — он же диагностика. */
      breaker: transportStatus(),
      channels: channels.length,
      active: channels.filter((channel) => channel.active !== false).length,
      collected: summary.collected,
      updatedAt: summary.updatedAt || updatedAt || null,
    };
  } catch (error) {
    return {
      ok: false,
      tme: { ok: false, ms: 0, error: cleanMessage(error) },
      bridge: { ok: false, ms: 0, error: cleanMessage(error) },
      botapi: { ok: false, ms: 0 },
      collected: {},
      updatedAt: null,
      error: cleanMessage(error),
    };
  }
}

// ---------------------------------------------------------------------------
// Сырая страница — отладка парсера на живом t.me
// ---------------------------------------------------------------------------

/**
 * Начало сырого HTML публичного превью: по нему видно, какую именно разметку
 * отдаёт t.me из облака. Права проверяет server.mjs (только администратор).
 * @returns {Promise<{username: string, status: number, bytes: number, text: string}>}
 */
export async function rawPage(query = {}) {
  const source = query || {};
  const username = normalizeUsername(source.username);
  if (!username) throw badRequest('Имя канала: 4–32 символа, латиница в нижнем регистре, цифры и «_»');
  const limitRaw = source.limit === undefined || source.limit === null || source.limit === ''
    ? 4000
    : Number(source.limit);
  if (!Number.isFinite(limitRaw) || limitRaw < 200 || limitRaw > 200000) {
    throw badRequest('Сколько знаков страницы отдавать: от 200 до 200000');
  }
  const page = await loadTmePage(username);
  return {
    username,
    status: page.status,
    bytes: Buffer.byteLength(page.html, 'utf8'),
    text: page.html.slice(0, Math.trunc(limitRaw)),
  };
}

// ---------------------------------------------------------------------------
// Каналы
// ---------------------------------------------------------------------------

function newestPostDate(posts) {
  let newest = null;
  for (const post of posts) {
    const time = Date.parse(post?.date || '');
    if (!Number.isFinite(time)) continue;
    if (!newest || time > Date.parse(newest)) newest = new Date(time).toISOString();
  }
  return newest;
}

/** Список каналов вместе с накопленной статистикой (её показывает интерфейс). */
export async function listChannels() {
  const { channels, updatedAt } = readChannels();
  const state = readCollectState();
  const out = channels.map((channel) => {
    const posts = readPosts(channel.username);
    const views = posts.map((post) => post.views).filter((value) => Number.isFinite(value));
    const stat = state[channel.username] && typeof state[channel.username] === 'object' ? state[channel.username] : {};
    return {
      ...channel,
      stats: {
        posts: posts.length,
        viewsAvg: views.length ? Math.round(views.reduce((sum, value) => sum + value, 0) / views.length) : null,
        viewsMax: views.length ? Math.max(...views) : null,
        lastPostAt: newestPostDate(posts),
        lastCollectedAt: stat.lastCollectedAt || null,
        lastError: stat.lastError || null,
      },
    };
  });
  return { channels: out, updatedAt };
}

/** Проверка канала живой загрузкой t.me: имя есть в списке — только если канал
 *  действительно существует в публичном превью. */
export async function addChannel(body = {}) {
  const source = body || {};
  const username = normalizeUsername(source.username);
  if (!username) {
    throw badRequest('Имя канала: 4–32 символа, латиница в нижнем регистре, цифры и «_». Например: durov');
  }
  const data = readChannels();
  if (data.channels.some((channel) => channel.username === username)) {
    throw conflict(`Канал @${username} уже добавлен`);
  }

  /* Добавление канала — запись в наш список, а не гарантия связи с Telegram.
     Проверку шапки делаем best effort: «такого канала нет» — это 400, а вот
     сетевой отказ или 429 моста не должны отнимать у человека добавление. */
  let result = null;
  let failureText = '';
  try {
    /* Для проверки существования достаточно одного сообщения и коротких
       таймаутов: добавление не должно ждать полминуты из-за недоступной сети. */
    result = await fetchChannel(username, {
      limit: 1,
      tmeTimeoutMs: ADD_CHECK_TIMEOUT_TME_MS,
      tmeAttempts: 1,
      bridgeTimeoutMs: ADD_CHECK_TIMEOUT_BRIDGE_MS,
    });
  } catch (error) {
    if (error?.notFound) {
      throw badRequest(`Канал @${username} не найден в публичном доступе: проверьте имя или канал закрыт`);
    }
    failureText = cleanMessage(error);
  }

  /* Ответ получен, но шапки нет — канал закрыт или имени не существует. */
  const title = String(result?.title || '').trim();
  if (result && !title) {
    throw badRequest(`Канал @${username} не найден в публичном доступе: у канала нет заголовка`);
  }

  const channel = {
    username,
    title: (title || username).slice(0, 200),
    addedAt: nowIso(),
    active: true,
    note: String(source.note || '').slice(0, 200),
  };
  saveChannels([...data.channels, channel]);

  if (result) return { channel: { ...channel, verified: true } };
  return {
    channel: { ...channel, verified: false, lastError: failureText },
    warning: `Канал добавлен, но проверить его не удалось: ${failureText}`,
  };
}

/** Убрать канал из списка. Файл постов не удаляем: история принадлежит человеку,
 *  а вернуть канал можно одной кнопкой. */
export async function removeChannel(username = '') {
  const target = normalizeUsername(username);
  if (!target) throw badRequest('Не указано имя канала');
  const data = readChannels();
  const next = data.channels.filter((channel) => channel.username !== target);
  if (next.length === data.channels.length) throw notFound(`Канала @${target} нет в списке`);
  saveChannels(next);
  return { ok: true };
}

function toBoolean(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'boolean') return value;
  const text = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'on', 'да'].includes(text)) return true;
  if (['false', '0', 'no', 'off', 'нет'].includes(text)) return false;
  return null;
}

/** Включить/выключить сбор по каналу. Без active — переключить текущее значение. */
export async function toggleChannel(body = {}) {
  const source = body || {};
  const target = normalizeUsername(source.username);
  if (!target) throw badRequest('Имя канала: 4–32 символа, латиница в нижнем регистре, цифры и «_»');
  const data = readChannels();
  const index = data.channels.findIndex((channel) => channel.username === target);
  if (index < 0) throw notFound(`Канала @${target} нет в списке`);

  const asked = toBoolean(source.active);
  if (source.active !== undefined && asked === null) {
    throw badRequest('Новое состояние канала: active=true или active=false');
  }
  const channel = data.channels[index];
  const next = { ...channel, active: asked === null ? channel.active === false : asked };
  const channels = data.channels.slice();
  channels[index] = next;
  saveChannels(channels);
  return { channel: next };
}

// ---------------------------------------------------------------------------
// Сбор
// ---------------------------------------------------------------------------

/** "a,b" | ["a","b"] | undefined → список имён или null («все активные»). */
function requestedList(value) {
  if (value === null || value === undefined || value === '') return null;
  const items = Array.isArray(value) ? value : String(value).split(',');
  const list = items.map((item) => String(item ?? '').trim()).filter(Boolean);
  return list.length ? list : null;
}

/** Один канал: транспорт (t.me с откатом на мост), новые посты, append, обрезка. */
async function collectChannel(channel, { limit, signal, prefer, deadline }) {
  const username = channel.username;
  const existing = readPosts(username);
  const known = new Set(existing.map((post) => String(post.id)));
  const result = await fetchChannel(username, { limit, signal, prefer, deadline });

  const fresh = [];
  for (const post of result.posts) {
    const id = String(post.id);
    if (known.has(id)) continue;
    known.add(id);
    fresh.push({ ...post, ch: post.ch || username, collectedAt: nowIso() });
  }
  const ordered = fresh.sort((a, b) => Number(a.id) - Number(b.id)).slice(-limit);
  appendPosts(username, ordered);
  const totalPosts = trimPostsFile(username);

  let titleChanged = false;
  const title = String(result.title || '').trim();
  if (title && title !== channel.title) {
    channel.title = title.slice(0, 200);
    titleChanged = true;
  }

  const ids = [...existing, ...ordered]
    .map((post) => Number(post.id))
    .filter((id) => Number.isFinite(id) && id > 0);
  if (ids.length) channel.lastMessageId = ids.reduce((max, id) => Math.max(max, id), 0);
  return {
    added: ordered.length,
    total: totalPosts,
    found: result.found,
    via: result.via,
    partial: result.partial === true,
    pages: Number(result.pages) || null,
    titleChanged,
    lastMessageId: channel.lastMessageId ?? null,
  };
}

/**
 * Собрать новые посты (только активные каналы или явно указанные).
 * Ошибка одного канала не валит остальные: она возвращается в errors.
 *
 * Второй одновременный вызов не запускает второй сбор, а получает результат
 * уже идущего: иначе кнопка «Собрать сейчас» и фоновый автосбор вместе бьют по
 * одному донору и сами же получают 429.
 */
export function collect(body = {}) {
  if (COLLECTING) return COLLECTING;
  const tracked = runCollect(body).finally(() => {
    if (COLLECTING === tracked) COLLECTING = null;
  });
  COLLECTING = tracked;
  return tracked;
}

/** Признак «сбор идёт прямо сейчас» — для журнала и автосбора. */
export function collecting() {
  return Boolean(COLLECTING);
}

let COLLECTING = null;

async function runCollect(body = {}) {
  const source = body || {};
  const limitRaw = source.limit === undefined || source.limit === null || source.limit === ''
    ? COLLECT_LIMIT_DEFAULT
    : Number(source.limit);
  const limit = Number.isFinite(limitRaw) ? Math.trunc(limitRaw) : COLLECT_LIMIT_DEFAULT;
  if (limit < 1 || limit > COLLECT_LIMIT_MAX) {
    throw badRequest(`Сколько постов собирать: от 1 до ${COLLECT_LIMIT_MAX}`);
  }

  const { channels } = readChannels();
  const requested = requestedList(source.usernames);
  const errors = [];
  const targets = [];

  if (requested) {
    for (const raw of requested) {
      const username = normalizeUsername(raw);
      const channel = username ? channels.find((item) => item.username === username) : null;
      if (!channel) {
        errors.push({ username: String(raw || '').slice(0, 64), error: 'Канал не добавлен в список' });
        continue;
      }
      targets.push(channel);
    }
    if (!targets.length) throw badRequest('Ни один из указанных каналов не добавлен в список');
  } else {
    targets.push(...channels.filter((channel) => channel.active !== false));
    if (!targets.length) throw badRequest('Нет активных каналов: добавьте канал или включите сбор');
  }

  const collected = {};
  const details = [];
  const state = readCollectState();
  const startedAt = nowIso();
  const deadline = Date.now() + COLLECT_DEADLINE_MS;
  const prefer = source.prefer === 'bridge' ? 'bridge' : 'tme';
  let channelsChanged = false;

  for (const channel of targets) {
    const username = channel.username;
    const prev = state[username] && typeof state[username] === 'object' ? state[username] : {};
    /* Бюджет кончился — канал не молча пропадает, а приходит в details со
       skipped:true: клиент покажет «не успели», человек повторит сбор. */
    if (timeLeft(deadline) < 3000) {
      const message = `Не успели собрать за ${Math.round(COLLECT_DEADLINE_MS / 1000)} с — повторите сбор позже`;
      collected[username] = 0;
      details.push({
        username,
        via: null,
        added: 0,
        total: Number(prev.totalPosts) || 0,
        found: null,
        partial: false,
        pages: null,
        skipped: true,
        error: message,
      });
      errors.push({ username, error: message });
      state[username] = {
        lastCollectedAt: startedAt,
        lastError: message,
        totalPosts: Number(prev.totalPosts) || 0,
      };
      saveCollectState(state);
      continue;
    }
    try {
      const result = await collectChannel(channel, { limit, signal: source.signal, prefer, deadline });
      collected[username] = result.added;
      details.push({
        username,
        via: result.via,
        added: result.added,
        total: result.total,
        found: result.found,
        partial: result.partial,
        pages: result.pages,
      });
      console.log(
        `[tg] @${username} через ${result.via}: +${result.added}, в файле ${result.total}`,
      );
      state[username] = {
        lastCollectedAt: nowIso(),
        lastError: null,
        totalPosts: result.total,
      };
      if (result.lastMessageId !== null || result.titleChanged) channelsChanged = true;
    } catch (error) {
      const message = cleanMessage(error);
      collected[username] = 0;
      details.push({
        username,
        via: null,
        added: 0,
        total: Number(prev.totalPosts) || 0,
        found: null,
        partial: false,
        pages: null,
        error: message,
      });
      state[username] = {
        lastCollectedAt: startedAt,
        lastError: message,
        totalPosts: Number(prev.totalPosts) || 0,
      };
      errors.push({ username, error: message });
    }
    saveCollectState(state);
  }

  if (channelsChanged) saveChannels(channels);
  return { collected, details, errors };
}

// ---------------------------------------------------------------------------
// Чтение: лента, статистика, экспорт
// ---------------------------------------------------------------------------

/** Лента постов: каналы, поиск, период, курсор. */
export async function feed(query = {}) {
  const source = query || {};
  const limitRaw = source.limit === undefined || source.limit === null || source.limit === ''
    ? FEED_LIMIT_DEFAULT
    : Number(source.limit);
  const limit = Number.isFinite(limitRaw)
    ? Math.min(FEED_LIMIT_MAX, Math.max(1, Math.trunc(limitRaw)))
    : FEED_LIMIT_DEFAULT;

  const channels = requestedList(source.channels);
  const posts = readAllPosts(channels ? channels.map((item) => normalizeUsername(item)).filter(Boolean) : null);
  const filtered = filterPosts(posts, {
    channels: channels || undefined,
    q: source.q,
    hours: source.hours,
    before: source.before,
  });
  return { posts: filtered.slice(0, limit), total: filtered.length };
}

/** Агрегаты за период: каналы, слова, ссылки, повторы. */
export async function stats(query = {}) {
  const source = query || {};
  const hoursRaw = source.hours === undefined || source.hours === null || source.hours === ''
    ? DEFAULT_STATS_HOURS
    : Number(source.hours);
  const hours = Number.isFinite(hoursRaw) && hoursRaw > 0 ? hoursRaw : DEFAULT_STATS_HOURS;

  const { channels } = readChannels();
  const titles = new Map(channels.map((channel) => [channel.username, channel.title || channel.username]));
  const posts = readAllPosts(channels.map((channel) => channel.username)).map((post) => ({
    ...post,
    title: titles.get(String(post.ch)) || null,
  }));
  const result = aggregateStats(posts, { hours });
  return { hours, ...result };
}

/** Markdown-экспорт постов за период (для отчётов и вложений). */
export async function exportMarkdown(query = {}) {
  const source = query || {};
  const hoursRaw = source.hours === undefined || source.hours === null || source.hours === ''
    ? DEFAULT_STATS_HOURS
    : Number(source.hours);
  const hours = Number.isFinite(hoursRaw) && hoursRaw > 0 ? hoursRaw : DEFAULT_STATS_HOURS;

  const channels = requestedList(source.channels);
  const names = channels ? channels.map((item) => normalizeUsername(item)).filter(Boolean) : null;
  const posts = filterPosts(readAllPosts(names), {
    channels: channels || undefined,
    q: source.q,
    hours,
    before: source.before,
  });
  return renderExportMarkdown(posts, { hours, generatedAt: nowIso() });
}

// ---------------------------------------------------------------------------
// Дайджест
// ---------------------------------------------------------------------------

/** "dg-20261109-071500" — идентификатор по времени создания (UTC, как все даты). */
function digestStamp(iso) {
  const date = new Date(iso);
  const pad = (value) => String(value).padStart(2, '0');
  const day = `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}`;
  const time = `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`;
  return `dg-${day}-${time}`;
}

const DIGEST_LINK_RE = /https?:\/\/t\.me\/[A-Za-z0-9_]+\/\d+/g;

/** Темы дайджеста — из markdown-заголовков модели и ссылок на посты под ними.
 *  Ничего не досочиняем: нет заголовков — тем нет. */
function extractTopics(markdown) {
  const topics = [];
  let current = null;
  for (const line of String(markdown || '').split('\n')) {
    const heading = /^\s{0,3}(#{2,4})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      current = { title: heading[2].trim().slice(0, 200), posts: 0, note: '' };
      topics.push(current);
      continue;
    }
    if (!current) continue;
    const links = line.match(DIGEST_LINK_RE);
    if (links) current.posts += new Set(links).size;
  }
  return topics.slice(0, 20);
}

/** Уникальные каналы набора постов — в порядке появления. */
function postChannels(posts) {
  const seen = new Set();
  for (const post of posts) {
    const username = String(post.ch || '');
    if (username) seen.add(username);
  }
  return [...seen];
}

/**
 * Дайджест за период одним вызовом модели. Пустая строка от simpleCompletion —
 * это «нет ключа/модели», поэтому 503, а не пустой дайджест.
 */
export async function digest(body = {}) {
  const source = body || {};
  const hoursRaw = source.hours === undefined || source.hours === null || source.hours === ''
    ? DEFAULT_DIGEST_HOURS
    : Number(source.hours);
  if (!Number.isFinite(hoursRaw) || hoursRaw <= 0 || hoursRaw > 24 * 90) {
    throw badRequest('Период дайджеста: от 1 часа до 90 суток');
  }
  const hours = hoursRaw;
  const focus = String(source.focus || '').slice(0, 2000);
  const channels = requestedList(source.channels);

  const posts = filterPosts(readAllPosts(), { channels: channels || undefined, hours });
  if (!posts.length) {
    return {
      digest: {
        id: '',
        createdAt: nowIso(),
        hours,
        channels: channels || [],
        posts: 0,
        text: 'За выбранный период новых постов нет.',
        topics: [],
        model: null,
      },
    };
  }

  const prompt = buildDigestPrompt(posts, { hours, focus });
  const modelText = await simpleCompletion(
    [
      { role: 'system', content: prompt.system },
      { role: 'user', content: prompt.user },
    ],
    { maxTokens: 4000 },
  );
  if (!modelText) throw failure('Модель недоступна, дайджест не собран', 503);

  /* Темы — по ответу модели (до склейки), «Источники» — всегда код: на ссылки
     в ответе модели рассчитывать нельзя, их может не быть вовсе. */
  const topics = extractTopics(modelText);
  const { block, sources } = renderDigestSources(posts, modelText);
  const text = block ? `${modelText.trimEnd()}\n\n${block}` : modelText;

  const createdAt = nowIso();
  const data = readJson(digestsFile(), null);
  const stored = Array.isArray(data?.digests) ? data.digests : [];
  const taken = new Set(stored.map((item) => item?.id));
  const base = digestStamp(createdAt);
  let id = base;
  let suffix = 1;
  while (taken.has(id)) {
    suffix += 1;
    id = `${base}-${suffix}`;
  }

  const record = {
    id,
    createdAt,
    hours,
    channels: postChannels(posts),
    posts: posts.length,
    text,
    sources,
    topics,
    model: MODEL.name,
  };
  ensureStore();
  writeJson(digestsFile(), { digests: [record, ...stored].slice(0, DIGEST_KEEP) });
  return { digest: record };
}

/** Последние дайджесты (по умолчанию десять). */
export async function listDigests(query = {}) {
  const source = query || {};
  const limitRaw = source.limit === undefined || source.limit === null || source.limit === '' ? 10 : Number(source.limit);
  const limit = Number.isFinite(limitRaw) ? Math.min(DIGEST_KEEP, Math.max(1, Math.trunc(limitRaw))) : 10;
  const data = readJson(digestsFile(), null);
  const list = Array.isArray(data?.digests) ? data.digests.filter(Boolean) : [];
  return { digests: list.slice(0, limit), total: list.length };
}
