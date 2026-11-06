/**
 * Сторож зависшего сервиса: строка [beat] на живом сервисе и перезапуск,
 * когда очередь событий встала надолго.
 *
 * Проверяем то, ради чего сторож и заведён: пока процесс жив, в журнал идут
 * удары; когда очередь стоит дольше порога, вызывается обработчик; выключенный
 * сторож не мешает ничему и не держит процесс.
 *
 * Запуск: node test/watchdog.mjs
 */
import assert from 'node:assert/strict';

const { startWatchdog } = await import('../src/watchdog.mjs');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Держим очередь занятой заданное время — так же, как это делает тяжёлый
 *  синхронный код в проде. */
function blockLoop(ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    /* намеренная занятость */
  }
}

test('на живом сервисе сторож пишет удары, а не падает', async () => {
  const beats = [];
  const hangs = [];
  const watchdog = startWatchdog({
    intervalMs: 20,
    hangMs: 2000,
    beatMs: 40,
    onBeat: (info) => beats.push(info),
    onHang: (info) => hangs.push(info),
  });
  try {
    await sleep(150);
    assert.ok(beats.length >= 1, 'ожидался хотя бы один удар');
    assert.equal(hangs.length, 0, 'на живой очереди перезапуска быть не должно');
    assert.match(String(beats[0].at), /^\d{4}-\d{2}-\d{2}T/, 'в ударе должна быть отметка времени');
  } finally {
    watchdog.stop();
  }
});

test('долгая остановка очереди вызывает перезапуск с длительностью', async () => {
  const hangs = [];
  const watchdog = startWatchdog({
    intervalMs: 20,
    hangMs: 60,
    beatMs: 0,
    onHang: (info) => hangs.push(info),
  });
  try {
    await sleep(60);
    blockLoop(160);
    await sleep(80);
    assert.ok(hangs.length >= 1, 'долгая остановка должна вызывать перезапуск');
    assert.ok(hangs[0].blockedMs >= 60, `в записи ${hangs[0].blockedMs} мс, ожидалось не меньше 60`);
    assert.equal(watchdog.stats().enabled, true);
  } finally {
    watchdog.stop();
  }
});

test('нулевой порог выключает сторожа', async () => {
  const hangs = [];
  const watchdog = startWatchdog({
    intervalMs: 20,
    hangMs: 0,
    onHang: (info) => hangs.push(info),
  });
  try {
    blockLoop(120);
    await sleep(80);
    assert.equal(hangs.length, 0, 'выключенный сторож не должен вмешиваться');
    assert.equal(watchdog.stats().enabled, false);
  } finally {
    watchdog.stop();
  }
});

test('сбой обработчика не ломает сторожа', async () => {
  const watchdog = startWatchdog({
    intervalMs: 20,
    hangMs: 60,
    beatMs: 30,
    onBeat: () => {
      throw new Error('журнал сломан');
    },
    onHang: () => {
      throw new Error('перезапуск сломан');
    },
  });
  try {
    blockLoop(120);
    await sleep(80);
    assert.equal(watchdog.stats().blockedMs > 0, true, 'сторож должен был заметить остановку');
  } finally {
    watchdog.stop();
  }
});

test('после stop() ударов и перезапусков нет', async () => {
  const beats = [];
  const hangs = [];
  const watchdog = startWatchdog({
    intervalMs: 20,
    hangMs: 60,
    beatMs: 20,
    onBeat: () => beats.push(1),
    onHang: () => hangs.push(1),
  });
  watchdog.stop();
  const before = beats.length;
  blockLoop(120);
  await sleep(80);
  assert.equal(beats.length, before, 'после остановки ударов быть не должно');
  assert.equal(hangs.length, 0, 'после остановки перезапусков быть не должно');
});

let failed = 0;
for (const item of tests) {
  try {
    await item.fn();
    console.log(`ok   ${item.name}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL ${item.name}: ${error?.message || error}`);
  }
}
console.log(failed ? `\n${failed} из ${tests.length} не прошли` : `\nвсе ${tests.length} прошли`);
process.exit(failed ? 1 : 0);
