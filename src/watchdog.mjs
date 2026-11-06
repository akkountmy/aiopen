/**
 * Сторож зависшего сервиса.
 *
 * Четвёртого ноября сервис один раз перестал отвечать на всё: контейнер был
 * жив, статус RUNNING, а /api/health не отвечал ни через пятнадцать секунд, ни
 * через двадцать минут — и в журнале не было ни строки об отказе. Причина
 * такого зависания остаётся в процессе, к которому уже не достучаться: чтобы
 * разбираться, нужен след.
 *
 * Сторож делает две вещи:
 *  - раз в минуту пишет строку [beat] с прогонами, памятью и задержкой
 *    очереди, пока сервис жив. Последняя строка перед тишиной показывает,
 *    когда именно всё встало;
 *  - если очередь событий не двигалась дольше hangMs, завершает процесс с
 *    понятной строкой, а платформа поднимает его заново. Зависший сервис хуже
 *    перезапуска: он держит соединения и не отвечает, а перезапуск занимает
 *    секунды.
 *
 * Таймер задуман с запасом: законная синхронная работа (сборка PDF, чтение
 * большого файла) занимает секунды, а не три минуты.
 */

import { Worker } from 'node:worker_threads';

export function startWatchdog({
  intervalMs = 5000,
  hangMs = 180_000,
  beatMs = 60_000,
  onHang = null,
  onBeat = null,
  now = () => Date.now(),
} = {}) {
  if (!(hangMs > 0)) {
    return { stop() {}, stats: () => ({ enabled: false, blockedMs: 0 }) };
  }
  let last = now();
  let lastBeat = last;
  let blockedMs = 0;
  const timer = setInterval(() => {
    const current = now();
    const drift = current - last - intervalMs;
    last = current;
    if (drift < 0) return;
    /* Настоящая остановка очереди: сторож просыпается позже, чем должен был. */
    if (drift >= hangMs) {
      blockedMs = Math.round(drift);
      try {
        onHang?.({ blockedMs, at: new Date(current).toISOString() });
      } catch {
        /* сбой обработчика не должен мешать перезапуску */
      }
      return;
    }
    if (beatMs > 0 && current - lastBeat >= beatMs) {
      lastBeat = current;
      try {
        onBeat?.({ at: new Date(current).toISOString() });
      } catch {
        /* журнал не должен ломать наблюдение */
      }
    }
  }, intervalMs);
  timer.unref?.();
  return {
    stats() {
      return { enabled: true, blockedMs, intervalMs, hangMs, beatMs };
    },
    stop() {
      clearInterval(timer);
    },
  };
}

/**
 * Жёсткий сторож: отдельный поток, который замечает, что главный поток встал.
 *
 * Мягкий сторож (startWatchdog) живёт таймером в том же потоке, поэтому против
 * синхронной блокировки бессилен: если очередь событий встала навсегда, его
 * таймер не сработает никогда. Четвёртого ноября сервис именно так и умирал
 * трижды: последняя строка [beat], потом двадцать минут тишины при статусе
 * RUNNING — платформа не считает это падением и не перезапускает.
 *
 * Поток-сторож имеет свой цикл событий, поэтому продолжает работать, даже когда
 * главный поток занят целиком. Главный поток раз в checkMs пишет метку времени
 * в общую память (Atomics.store — без выделений и блокировок); сторож читает её
 * и, если метка не двигалась дольше stallSec, сам пишет строку в stderr —
 * из потока это работает, хотя бы сам процесс и не отвечал.
 *
 * Убивать себя процесс не должен: проверено в облаке 4 ноября — платформа НЕ
 * поднимает контейнер после SIGKILL (журнал молчит, статус остаётся RUNNING,
 * /api/health не отвечает, пока не перезапустят руками). Поэтому убийство
 * превратило бы зависание в такую же аварию, только без строки в журнале.
 * Лечение — внешний сторож (scripts/health-guard.mjs): он видит молчание
 * и перезапускает проект. Здесь остаётся след и, если очень нужно,
 * включаемый явно режим action: 'kill'.
 */
export function startHardWatchdog({
  stallSec = 240,
  checkMs = 2000,
  action = 'log',
  onAlarm = null,
  onKill = null,
  now = () => Date.now(),
} = {}) {
  if (!(stallSec > 0)) {
    return { stats: () => ({ enabled: false, stallSec: 0 }), stop() {} };
  }
  let worker = null;
  let timer = null;
  let shared = null;
  try {
    shared = new SharedArrayBuffer(4);
    const beat = new Int32Array(shared);
    /* Метка — секунды эпохи в общей памяти: Atomics работает только с целыми
       массивами, поэтому миллисекунды здесь не нужны, хватает секунды. */
    Atomics.store(beat, 0, Math.floor(now() / 1000));
    /* Код сторожа — строка, а не отдельный файл: он должен ехать вместе с
       модулем и не зависеть от того, что попало в образ. Строку в stderr поток
       пишет сам: главный поток в этот момент занят и ничего не обработает. */
    const source = `
      const { parentPort, workerData } = require('node:worker_threads');
      const beat = new Int32Array(workerData.shared);
      const limit = workerData.stallSec;
      let fired = false;
      setInterval(() => {
        if (fired) return;
        const last = Atomics.load(beat, 0);
        const silent = Math.floor(Date.now() / 1000) - last;
        if (silent < limit) return;
        fired = true;
        const line = '[watchdog] главный поток молчит ' + silent + ' с — сервис не отвечает, нужен внешний перезапуск\\n';
        /* Пишем синхронно в дескриптор 2: буферизованный process.stderr из
           потока теряется, если главный поток так и не освободится. */
        try { require('node:fs').writeSync(2, line); } catch (e) {
          try { process.stderr.write(line); } catch (e2) { /* журнал недоступен */ }
        }
        if (workerData.action === 'kill') {
          try { require('node:process').kill(workerData.pid, 'SIGKILL'); } catch (e) {}
        }
        parentPort.postMessage({ silent });
      }, workerData.checkMs);
    `;
    worker = new Worker(source, {
      eval: true,
      workerData: { shared, stallSec, checkMs, pid: process.pid, action },
    });
    worker.on('message', ({ silent }) => {
      /* Сообщение доходит, только если главный поток всё-таки жив. */
      const alarm = { silentMs: silent * 1000, at: new Date(now()).toISOString() };
      try {
        onAlarm?.(alarm);
        if (action === 'kill') onKill?.(alarm);
      } catch {
        /* журнал не должен мешать */
      }
    });
    worker.on('error', () => {
      /* Поток сторожа упал — остаётся мягкий сторож в главном потоке. */
    });
    worker.unref?.();
    timer = setInterval(() => {
      Atomics.store(beat, 0, Math.floor(now() / 1000));
    }, checkMs);
    timer.unref?.();
  } catch (error) {
    /* Нет worker_threads или запрещён SharedArrayBuffer — остаётся мягкий сторож. */
    return {
      stats: () => ({ enabled: false, stallSec, error: String(error?.message || error) }),
      stop() {},
    };
  }
  return {
    stats() {
      return { enabled: true, stallSec, checkMs, action };
    },
    stop() {
      clearInterval(timer);
      try {
        return worker?.terminate();
      } catch {
        return undefined;
      }
    },
  };
}
