import { CAPACITY } from './config.mjs';

/* Пределы одновременной работы сервиса.
 *
 * Задачи: не дать толпе пользователей выесть память, честно сказать «занято»
 * вместо тихого падения и показать загрузку в /api/health.
 *
 * Как устроено. У нас два счётчика — общий (весь процесс) и на аккаунт.
 * Первый защищает контейнер: в нём живут Chromium, Python и истории диалогов,
 * поэтому одновременных прогонов агента не может быть сколько угодно.
 * Второй не даёт одному человеку с десятком вкладок занять все места.
 *
 * Когда мест нет, запрос не падает сразу: он встаёт в короткую очередь
 * ожидания (по умолчанию 60 секунд). Это лучше 429 «попробуйте позже» для
 * обычного вечернего наплыва: большинство задач длятся меньше минуты, и
 * человек дождётся ответа, не нажимая «отправить» заново. Ждать дольше
 * бессмысленно — тогда честная ошибка с указанием, через сколько секунд
 * попробовать.
 *
 * Все величины задаются переменными окружения, потому что размер контейнера
 * на хостинге меняется без изменения кода (см. docs/capacity.md).
 */

/* Прочим модулям удобно брать пределы отсюда же — не тянуть config напрямую. */
export { CAPACITY };
export class BusyError extends Error {
  constructor(message, { retryAfterMs = 0, reason = 'busy' } = {}) {
    super(message);
    this.name = 'BusyError';
    this.code = 'busy';
    this.reason = reason;
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * Счётчик одновременных задач с очередью ожидания.
 *
 * limit = 0 — предела нет (счётчик всё равно ведётся ради статистики).
 * waitMs = 0 — очередь выключена, при занятости сразу ошибка.
 */
export function createGate({ limit = 0, waitMs = 0, maxWaiting = 0 } = {}) {
  let active = 0;
  let rejected = 0;
  let waited = 0;
  const waiting = [];

  function makeRelease() {
    let done = false;
    return function release() {
      if (done) return;
      done = true;
      active -= 1;
      const next = waiting.shift();
      if (next) {
        /* Место передаём напрямую, без промежуточного «освободилось»: иначе
           между release и следующим захватом успевает влезть третий. */
        clearTimeout(next.timer);
        if (next.signal) next.signal.removeEventListener('abort', next.onAbort);
        active += 1;
        next.resolve(makeRelease());
      }
    };
  }

  function stats() {
    return { active, waiting: waiting.length, limit, waitMs, maxWaiting, rejected, waited };
  }

  function acquire({ signal, waitMs: waitOverride = null } = {}) {
    const wait = waitOverride === null ? waitMs : waitOverride;
    if (limit > 0 && active >= limit) {
      if (!wait || waiting.length >= maxWaiting) {
        rejected += 1;
        return Promise.reject(
          new BusyError('Сервис занят: одновременно идёт предел ответов', {
            reason: 'full',
            retryAfterMs: Math.max(2000, Math.round((wait || waitMs || 4000) / 2)),
          }),
        );
      }
      return new Promise((resolve, reject) => {
        const entry = { resolve, reject, timer: null, signal: null, onAbort: null };
        entry.timer = setTimeout(() => {
          const index = waiting.indexOf(entry);
          if (index >= 0) waiting.splice(index, 1);
          rejected += 1;
          reject(
            new BusyError('Сервис занят: очередь переполнена', {
              reason: 'timeout',
              retryAfterMs: Math.max(3000, Math.round(wait / 2)),
            }),
          );
        }, wait);
        entry.timer.unref?.();
        if (signal) {
          const onAbort = () => {
            const index = waiting.indexOf(entry);
            if (index >= 0) waiting.splice(index, 1);
            clearTimeout(entry.timer);
            reject(new BusyError('Ожидание места отменено', { reason: 'aborted' }));
          };
          if (signal.aborted) {
            onAbort();
            return;
          }
          entry.signal = signal;
          entry.onAbort = onAbort;
          signal.addEventListener('abort', onAbort, { once: true });
        }
        waiting.push(entry);
        waited += 1;
      });
    }
    active += 1;
    return Promise.resolve(makeRelease());
  }

  /* Немедленный захват без очереди: нужен там, где вызывающий код синхронный
     (подъём прерванных задач при старте). Если кто-то уже ждёт в очереди, место
     не отдаём — иначе синхронный захват обгонял бы ожидающих. */
  function reserve() {
    if (limit > 0 && (active >= limit || waiting.length > 0)) return null;
    active += 1;
    return makeRelease();
  }

  return { acquire, reserve, stats };
}

/** Наблюдение за очередью событий: если она стоит, сервис не отвечает быстро,
 *  даже когда память ещё есть. Значение читает /api/health. */
export function createLoopMonitor({ intervalMs = 1000 } = {}) {
  let last = Date.now();
  let worstMs = 0;
  const timer = setInterval(() => {
    const now = Date.now();
    const drift = now - last - intervalMs;
    last = now;
    if (drift < 0) return;
    /* Сглаживаем: одиночный сборщик мусора не должен выглядеть как отказ. */
    worstMs = Math.max(worstMs * 0.92, drift);
  }, intervalMs);
  timer.unref?.();
  return {
    stats() {
      return { loopLagMs: Math.round(worstMs) };
    },
    stop() {
      clearInterval(timer);
    },
  };
}

/** Память процесса в мегабайтах — без внешних зависимостей. */
export function memoryStats() {
  const usage = process.memoryUsage();
  const mb = (bytes) => Math.round((bytes / (1024 * 1024)) * 10) / 10;
  return { rssMb: mb(usage.rss), heapUsedMb: mb(usage.heapUsed), externalMb: mb(usage.external) };
}

/* Тяжёлые инструменты: Chromium, движок анти-бота, Python, распаковка архивов.
   Каждый такой запуск берёт сотни мегабайт и десятки секунд процессора. Пока
   они не ограничены, десяток одновременных запросов упирается в память
   контейнера, и сервис убивают целиком — вместе с чужими диалогами.

   Очередь общая на процесс и на все инструменты сразу: предел не «сколько
   браузеров», а «сколько тяжёлых работ». Ждать разрешено недолго (30 секунд):
   дольше человек всё равно не ждёт и жмёт кнопку снова. */
export const heavyGate = createGate({
  limit: CAPACITY.heavyTools,
  waitMs: 30000,
  maxWaiting: Math.max(10, CAPACITY.heavyTools * 6),
});

/** Выполняет тяжёлую работу под общим счётчиком; при переполнении — понятная ошибка. */
export async function withHeavySlot(fn, { waitMs = null, signal } = {}) {
  let release;
  try {
    release = await heavyGate.acquire({ signal, waitMs });
  } catch (error) {
    const retrySeconds = Math.max(20, Math.round((error?.retryAfterMs || 30000) / 1000));
    throw new Error(
      `Сейчас занято: одновременно выполняется максимум тяжёлых задач (${CAPACITY.heavyTools}). ` +
        `Это браузер, Python или распаковка архива. Повтори через ${retrySeconds} секунд или упрости запрос.`,
    );
  }
  try {
    return await fn();
  } finally {
    release();
  }
}
