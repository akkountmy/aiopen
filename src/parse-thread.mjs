/**
 * Разбор тяжёлых страниц в отдельном потоке.
 *
 * Зачем: jsdom + Readability + Turndown — синхронный код на секунды и десятки
 * секунд работы. В одном потоке с HTTP-сервером он останавливает всё: пока
 * страница разбирается, не отвечает /api/health, не идут таймеры сторожевого
 * таймера, не журналируется прогресс. 16.11.2026 страница книги на 1–1.5 МБ
 * так задержала очередь событий на 229 с: внешний health-guard не дождался
 * ответа, а мягкий сторож перезапустил сервис с сообщением «завис на задаче».
 *
 * Теперь тяжёлый разбор идёт в worker_threads: главный поток свободен, ответы
 * идут, а поток можно остановить по времени (terminate) — синхронный код в
 * главном потоке остановить нельзя. Память потока ограничена, поэтому «страница
 * на 4 МБ» убивает разборщик, а не сервис.
 *
 * Поток один и живёт переиспользуемым: повторный запуск дешевле (jsdom уже
 * загружен), а последовательность важнее параллельности — на тарифе 0.25 ядра
 * два разбора одновременно только мешают друг другу.
 */
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';

const WORKER_FILE = fileURLToPath(new URL('./parse-worker.mjs', import.meta.url));

/* Пределы подобраны под контейнер 500 МБ / 0.25 ядра: heap потока 224 МБ —
   это уже много, но главный поток при этом остаётся живым и отвечает. */
const MAX_OLD_MB = envNumber('DSHOW_PARSE_THREAD_HEAP_MB', 224);
const MAX_YOUNG_MB = 32;
const IDLE_EXIT_MS = 45000;
const QUEUE_LIMIT = 3;
const DEFAULT_TIMEOUT_MS = 45000;

function envNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/* Выключатель на случай разбора причины: DSHOW_PARSE_THREAD=off возвращает
   прежнее поведение (разбор в главном потоке) без отката кода. */
export function parseThreadEnabled() {
  const flag = String(process.env.DSHOW_PARSE_THREAD || '').toLowerCase();
  return !['off', '0', 'false', 'no'].includes(flag);
}

const stats = { tasks: 0, ok: 0, failed: 0, timeouts: 0, lastMs: 0, maxMs: 0, busyNow: false };
const pending = [];
let slot = null;
let seq = 0;

function spawn() {
  const worker = new Worker(WORKER_FILE, {
    resourceLimits: { maxOldGenerationSizeMb: MAX_OLD_MB, maxYoungGenerationSizeMb: MAX_YOUNG_MB },
  });
  const state = { worker, current: null, idleTimer: null, dead: false, reason: '' };
  /* Простаивающий разборщик не должен держать процесс при остановке сервиса. */
  worker.unref();
  worker.on('message', (message) => onMessage(state, message));
  worker.on('error', (error) => {
    state.reason = memoryReason(error);
    settle(state, null, Object.assign(new Error(state.reason), { name: 'ParseThreadError' }));
    state.dead = true;
    if (slot === state) slot = null;
  });
  worker.on('exit', () => {
    state.dead = true;
    if (slot === state) slot = null;
    settle(
      state,
      null,
      Object.assign(new Error(state.reason || 'поток разбора завершился'), { name: 'ParseThreadError' }),
    );
  });
  return state;
}

function memoryReason(error) {
  const text = String(error?.message || error || '');
  if (/out of memory|ERR_WORKER_OUT_OF_MEMORY|heap/i.test(text)) {
    return `разбор не поместился в память потока (${MAX_OLD_MB} МБ)`;
  }
  return `поток разбора упал: ${text.slice(0, 200)}`;
}

function onMessage(state, message) {
  const item = state.current;
  if (!item || !message || message.id !== item.id) return;
  if (message.ok) settle(state, message.result, null);
  else {
    stats.failed += 1;
    settle(state, null, Object.assign(new Error(message.error || 'разбор не удался'), { name: 'ParseThreadError' }));
  }
}

/* Закрыть текущую задачу и подготовить поток к следующей. */
function settle(state, result, error) {
  const item = state?.current;
  if (!item) return;
  state.current = null;
  if (item.timer) clearTimeout(item.timer);
  item.timer = null;
  const elapsed = Date.now() - item.startedAt;
  stats.lastMs = elapsed;
  stats.maxMs = Math.max(stats.maxMs, elapsed);
  stats.busyNow = false;
  if (error) item.reject(error);
  else {
    stats.ok += 1;
    item.resolve(result);
  }
  if (state && !state.dead) {
    state.worker.unref();
    state.idleTimer = setTimeout(() => {
      state.idleTimer = null;
      state.dead = true;
      if (slot === state) slot = null;
      state.worker.terminate().catch(() => {});
    }, IDLE_EXIT_MS);
    state.idleTimer.unref?.();
  }
  pump();
}

function pump() {
  if (!pending.length) return;
  let state = slot;
  if (!state || state.dead || state.current) return;
  const item = pending.shift();
  if (state.idleTimer) {
    clearTimeout(state.idleTimer);
    state.idleTimer = null;
  }
  item.id = ++seq;
  item.startedAt = Date.now();
  state.current = item;
  stats.busyNow = true;
  state.worker.ref();
  item.timer = setTimeout(() => {
    /* Не уложился — поток останавливаем: иначе он продолжит занимать ядро и
       память, а результата не будет. Внешний код получит ошибку и свой
       дешёвый разбор. */
    stats.timeouts += 1;
    state.reason = `разбор не уложился в ${Math.round(item.timeoutMs / 1000)} с и был остановлен`;
    console.warn(`[parse] ${state.reason}`);
    state.dead = true;
    if (slot === state) slot = null;
    state.worker.terminate().catch(() => {});
    settle(state, null, Object.assign(new Error(state.reason), { name: 'ParseTimeoutError' }));
  }, item.timeoutMs);
  item.timer.unref?.();
  try {
    state.worker.postMessage({ id: item.id, task: item.task }, item.transfer || []);
  } catch (error) {
    settle(state, null, Object.assign(new Error(String(error?.message || error)), { name: 'ParseThreadError' }));
  }
}

/**
 * Разобрать задачу в отдельном потоке.
 * task: { kind: 'readable' | 'document', ... }
 * Возвращает промис с результатом разбора; ошибки — обычные Error с понятным
 * русским текстом (время, память, падение потока).
 */
export function parseOffThread(task, { timeoutMs = DEFAULT_TIMEOUT_MS, transfer = [] } = {}) {
  if (!parseThreadEnabled()) {
    return Promise.reject(Object.assign(new Error('разбор в потоке выключен'), { name: 'ParseThreadOffError' }));
  }
  if (pending.length >= QUEUE_LIMIT) {
    return Promise.reject(
      Object.assign(new Error('разборщик занят: слишком много страниц сразу'), { name: 'ParseBusyError' }),
    );
  }
  stats.tasks += 1;
  return new Promise((resolve, reject) => {
    pending.push({ task, timeoutMs, transfer, resolve, reject });
    if (!slot || slot.dead) slot = spawn();
    pump();
  });
}

/** Состояние разборщика для /api/health и журнала. */
export function parseThreadStats() {
  return {
    enabled: parseThreadEnabled(),
    alive: Boolean(slot && !slot.dead),
    busy: Boolean(slot?.current),
    queued: pending.length,
    maxHeapMb: MAX_OLD_MB,
    idleExitSeconds: Math.round(IDLE_EXIT_MS / 1000),
    ...stats,
  };
}
