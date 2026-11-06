/**
 * Запас прочности: потолок памяти и честный отказ вместо OOM.
 *
 * Проверяем то, что нельзя увидеть глазами в проде: при памяти ниже потолка
 * задача идёт, при памяти выше — сервис отвечает «занято», а не падает.
 *
 * Запуск: node test/capacity-memory.mjs
 */
import assert from 'node:assert/strict';

const { memoryPressure, memoryStats, withHeavySlot, heavyGate, createLoopMonitor, CAPACITY } = await import('../src/capacity.mjs');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('память процесса читается и выглядит правдоподобно', () => {
  const stats = memoryStats();
  assert.ok(stats.rssMb > 20, `rss ${stats.rssMb} MB — подозрительно мало`);
  assert.ok(stats.rssMb < 20000, `rss ${stats.rssMb} MB — подозрительно много`);
  assert.ok(stats.heapUsedMb <= stats.rssMb, 'heap больше rss быть не может');
});

test('потолок памяти задан и попадает в отчёт', () => {
  assert.ok(CAPACITY.maxRssMb >= 0, 'потолок должен быть числом');
  const pressure = memoryPressure();
  assert.equal(pressure.limitMb, CAPACITY.maxRssMb);
  assert.equal(typeof pressure.over, 'boolean');
});

test('ниже потолка давления нет, выше — есть', () => {
  const { rssMb } = memoryStats();
  assert.equal(memoryPressure({ limitMb: rssMb + 500 }).over, false, 'запас есть — давление не должно считаться');
  assert.equal(memoryPressure({ limitMb: Math.max(1, rssMb - 50) }).over, true, 'память выше потолка — давление должно быть');
});

test('потолок 0 выключает проверку', () => {
  const pressure = memoryPressure({ limitMb: 0 });
  assert.equal(pressure.over, false, 'нулевой потолок означает «без предела»');
  assert.equal(pressure.limitMb, 0);
});

test('тяжёлый инструмент при переполненной памяти не запускается и объясняет причину', async () => {
  const previous = CAPACITY.maxRssMb;
  let ran = false;
  try {
    /* Ставим потолок заведомо ниже реального: память уже «на пределе». */
    CAPACITY.maxRssMb = Math.max(1, Math.round(memoryStats().rssMb) - 50);
    await assert.rejects(
      () => withHeavySlot(async () => {
        ran = true;
      }),
      /память сервиса на пределе/,
    );
    assert.equal(ran, false, 'тяжёлая работа не должна была начаться');
  } finally {
    CAPACITY.maxRssMb = previous;
  }
  /* Место в счётчике не должно утечь после отказа. */
  const used = heavyGate.stats().active;
  assert.equal(used, 0, `после отказа занято ${used} мест из ${CAPACITY.heavyTools}`);
});

test('обычный запуск при нормальной памяти работает и освобождает место', async () => {
  const before = heavyGate.stats().active;
  const value = await withHeavySlot(async () => 'готово');
  assert.equal(value, 'готово');
  assert.equal(heavyGate.stats().active, before, 'место должно вернуться');
});

test('остановка очереди событий попадает в журнал, короткая — нет', async () => {
  const seen = [];
  /* Порог ставим низко: иначе ждать настоящего зависания в тесте нечем. */
  const monitor = createLoopMonitor({ intervalMs: 20, stallMs: 30, onStall: (info) => seen.push(info) });
  try {
    await new Promise((resolve) => setTimeout(resolve, 90));
    assert.equal(seen.length, 0, 'на спокойной очереди записей быть не должно');
    /* Блокируем очередь заведомо дольше порога. */
    const until = Date.now() + 120;
    while (Date.now() < until) {
      /* намеренная задержка */
    }
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.ok(seen.length >= 1, 'долгая остановка должна быть в журнале');
    assert.ok(seen[0].lagMs >= 30, `в записи ${seen[0].lagMs} мс`);
    assert.match(String(seen[0].at), /^\d{4}-\d{2}-\d{2}T/, 'в записи должна быть отметка времени');
  } finally {
    monitor.stop();
  }
});

test('сбой обработчика журнала не ломает наблюдение', async () => {
  const monitor = createLoopMonitor({
    intervalMs: 20,
    stallMs: 10,
    onStall: () => {
      throw new Error('журнал сломан');
    },
  });
  try {
    const until = Date.now() + 80;
    while (Date.now() < until) {
      /* держим очередь */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.ok(Number.isFinite(monitor.stats().loopLagMs), 'наблюдение должно продолжать работать');
  } finally {
    monitor.stop();
  }
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
