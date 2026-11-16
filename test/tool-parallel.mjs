import assert from 'node:assert/strict';
import { describeToolStep, groupToolCalls, isParallelSafe, savedByParallel } from '../src/toolplan.mjs';

const call = (name, id = name) => ({ id, function: { name, arguments: '{}' } });

/* Чистые вызовы подряд — один параллельный батч, порядок сохранён. */
{
  const batches = groupToolCalls([call('read_file', 'a'), call('fetch_url', 'b'), call('list_files', 'c')]);
  assert.equal(batches.length, 1);
  assert.equal(batches[0].parallel, true);
  assert.deepEqual(
    batches[0].calls.map((one) => one.id),
    ['a', 'b', 'c'],
  );
}

/* Всё, что пишет или меняет аккаунт, идёт отдельным батчем из одного вызова,
   а порядок батчей остаётся исходным. */
{
  const batches = groupToolCalls([
    call('read_file', 'a'),
    call('read_file', 'b'),
    call('write_file', 'c'),
    call('read_file', 'd'),
    call('spawn_agent', 'e'),
  ]);
  assert.deepEqual(
    batches.map((batch) => ({ parallel: batch.parallel, ids: batch.calls.map((one) => one.id) })),
    [
      { parallel: true, ids: ['a', 'b'] },
      { parallel: false, ids: ['c'] },
      { parallel: true, ids: ['d'] },
      { parallel: false, ids: ['e'] },
    ],
  );
}

/* Лимит режет длинный батч, но не меняет порядок. */
{
  const batches = groupToolCalls(
    ['a', 'b', 'c', 'd', 'e'].map((id) => call('read_file', id)),
    { limit: 2 },
  );
  assert.deepEqual(
    batches.map((batch) => batch.calls.map((one) => one.id)),
    [['a', 'b'], ['c', 'd'], ['e']],
  );
}

/* Выключенная параллельность — ровно по одному вызову, как раньше. */
{
  const batches = groupToolCalls([call('read_file', 'a'), call('read_file', 'b')], { parallel: false });
  assert.equal(batches.length, 2);
  assert.equal(batches.every((batch) => batch.parallel === false), true);
}

/* Пустой шаг и мусор не ломают план. */
{
  assert.deepEqual(groupToolCalls([]), []);
  assert.deepEqual(groupToolCalls(null), []);
  assert.deepEqual(groupToolCalls([{ id: 'x' }]).length, 1);
}

assert.equal(isParallelSafe('read_file'), true);
assert.equal(isParallelSafe('read_file '), true);
assert.equal(isParallelSafe('write_file'), false);
assert.equal(isParallelSafe(''), false);

/* Экономия — сумма времён минус самый долгий вызов батча. */
{
  const saved = savedByParallel([
    { parallel: true, calls: [{ ms: 700 }, { ms: 750 }, { ms: 720 }] },
    { parallel: false, calls: [{ ms: 5000 }] },
    { parallel: true, calls: [{ ms: 900 }] },
  ]);
  assert.equal(saved, 700 + 750 + 720 - 750);
}

assert.match(
  describeToolStep({ calls: 4, wallMs: 1200, savedMs: 3200 }),
  /4 вызовов за 1\.2 с вместо 4\.4 с .*экономия 3\.2 с/,
);
assert.equal(describeToolStep({ calls: 2, wallMs: 1500 }), '2 вызовов за 1.5 с');
assert.equal(describeToolStep({ calls: 0, wallMs: 900 }), '');

console.log('tool-parallel: ok');
