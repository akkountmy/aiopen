/**
 * Тесты разметки вызовов инструментов в истории диалога.
 *
 * Повод: диалог в службе перестал отвечать — на каждый вопрос «Не удалось
 * получить ответ». В журнале было `upstream 400: Messages with role 'tool'
 * must be a response to a preceding message with 'tool_calls'`. Значит, в
 * сохранённой истории остался ответ инструмента без своего вызова (или два
 * ответа на один вызов), и каждый следующий запрос отвергался по формату.
 * Здесь проверяем, что такая история чинится до допустимого вида и что
 * правильная история не меняется.
 *
 * Запуск: node test/history.mjs
 */
import assert from 'node:assert/strict';

const { LOST_TOOL_RESULT, normalizeHistory, repairHistoryInPlace } = await import('../src/history.mjs');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const call = (id, name = 'read_file', args = '{"path":"a.csv"}') => ({
  id,
  type: 'function',
  function: { name, arguments: args },
});
const assistantCall = (...ids) => ({ role: 'assistant', content: null, tool_calls: ids.map((id) => call(id)) });
const toolMsg = (id, content = 'результат') => ({ role: 'tool', tool_call_id: id, content });

/* Проверка главного инварианта: у каждого `tool` есть вызов, и на каждый вызов
   ровно один ответ. Провайдер модели проверяет именно это. */
function assertProtocol(messages) {
  let open = null;
  for (const message of messages) {
    if (message.role === 'tool') {
      assert.ok(open, 'ответ инструмента без предшествующего вызова');
      assert.ok(open.declared.has(message.tool_call_id), `неизвестный вызов ${message.tool_call_id}`);
      assert.ok(!open.answered.has(message.tool_call_id), `повторный ответ на ${message.tool_call_id}`);
      open.answered.add(message.tool_call_id);
      continue;
    }
    if (open) {
      for (const id of open.declared) assert.ok(open.answered.has(id), `вызов ${id} остался без ответа`);
    }
    open = null;
    if (message.role === 'assistant') {
      const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
      for (const item of calls) assert.ok(item?.id, 'вызов без идентификатора');
      if (calls.length) open = { declared: new Set(calls.map((item) => item.id)), answered: new Set() };
    }
  }
  if (open) {
    for (const id of open.declared) assert.ok(open.answered.has(id), `вызов ${id} остался без ответа`);
  }
}

test('правильная история не меняется', () => {
  const history = [
    { role: 'user', content: 'прочитай a.csv' },
    assistantCall('c1'),
    toolMsg('c1'),
    { role: 'assistant', content: 'готово' },
  ];
  const before = [...history];
  const result = normalizeHistory(history);
  assert.equal(result.changed, false);
  assert.equal(result.messages.length, history.length);
  /* Те же объекты: закреплённую задачу узнают по ссылке. */
  result.messages.forEach((message, index) => assert.equal(message, before[index]));
  assertProtocol(result.messages);
});

test('ответ инструмента без своего вызова убирается', () => {
  /* Ровно то, что пришло из службы: пара потерялась, ответ остался. */
  const history = [
    { role: 'user', content: 'добавь в книгу примеры' },
    toolMsg('c1', 'содержимое файла'),
    { role: 'assistant', content: 'готово' },
  ];
  const result = normalizeHistory(history);
  assert.equal(result.changed, true);
  assert.equal(result.removed, 1);
  assert.equal(result.messages.length, 2);
  assertProtocol(result.messages);
});

test('два ответа на один вызов: остаётся один', () => {
  /* Второй ответ — та самая форма, на которой провайдер отвечает
     «must be a response to a preceding message with tool_calls». */
  const history = [
    { role: 'user', content: 'прочитай a.csv' },
    assistantCall('c1'),
    toolMsg('c1', 'первый результат'),
    toolMsg('c1', 'второй результат'),
    { role: 'assistant', content: 'готово' },
  ];
  const result = normalizeHistory(history);
  assert.equal(result.removed, 1);
  assert.equal(result.messages.filter((item) => item.role === 'tool').length, 1);
  assert.equal(result.messages.find((item) => item.role === 'tool').content, 'первый результат');
  assertProtocol(result.messages);
});

test('незакрытый вызов закрывается пометкой, а не выбрасывается', () => {
  /* Сбой посреди шага: объявлены два вызова, ответ пришёл на один. */
  const history = [
    { role: 'user', content: 'собери отчёт' },
    assistantCall('c1', 'c2'),
    toolMsg('c1'),
    { role: 'assistant', content: 'продолжаю' },
  ];
  const result = normalizeHistory(history);
  assert.equal(result.filled, 1);
  assertProtocol(result.messages);
  const closed = result.messages.find((item) => item.role === 'tool' && item.tool_call_id === 'c2');
  assert.ok(closed, 'вызов c2 должен получить ответ');
  assert.equal(closed.content, LOST_TOOL_RESULT);
  /* Пометка стоит до следующего сообщения, а не в конце истории. */
  const index = result.messages.indexOf(closed);
  assert.equal(result.messages[index + 1].content, 'продолжаю');
});

test('вызов в конце истории закрывается тоже', () => {
  const history = [
    { role: 'user', content: 'запусти сборку' },
    assistantCall('c1', 'c2'),
    toolMsg('c1'),
  ];
  const result = normalizeHistory(history);
  assert.equal(result.filled, 1);
  assert.equal(result.messages.length, 4);
  assertProtocol(result.messages);
});

test('вызов без идентификатора не объявляется, ответ на него убирается', () => {
  const history = [
    { role: 'user', content: 'что-то' },
    { role: 'assistant', content: null, tool_calls: [{ type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
    toolMsg('call_0'),
  ];
  const result = normalizeHistory(history);
  assertProtocol(result.messages);
  assert.equal(result.messages.length, 2);
});

test('пустой список вызовов не остаётся в истории', () => {
  const history = [
    { role: 'user', content: 'привет' },
    { role: 'assistant', content: 'здравствуйте', tool_calls: [] },
  ];
  const result = normalizeHistory(history);
  assert.equal(result.changed, true);
  assert.ok(!('tool_calls' in result.messages[1]));
});

test('починка на месте возвращает исходный массив и счётчики', () => {
  const history = [
    { role: 'user', content: 'вопрос' },
    toolMsg('c9'),
    assistantCall('c1'),
    toolMsg('c1'),
    { role: 'assistant', content: 'ответ' },
  ];
  const target = history;
  const healed = repairHistoryInPlace(target);
  assert.equal(healed.changed, true);
  assert.equal(healed.removed, 1);
  assert.equal(healed.filled, 0);
  assert.equal(target, history, 'массив подменять нельзя: на него ссылаются вызывающие');
  assertProtocol(target);
  /* Второй проход ничего не находит — починка идемпотентна. */
  assert.equal(repairHistoryInPlace(target).changed, false);
});

test('починка не портит длинный рабочий диалог', () => {
  const history = [];
  for (let index = 0; index < 40; index++) {
    history.push({ role: 'user', content: `вопрос ${index}` });
    history.push(assistantCall(`a${index}`, `b${index}`));
    history.push(toolMsg(`a${index}`, `данные ${index}`));
    history.push(toolMsg(`b${index}`, `данные ${index}-b`));
    history.push({ role: 'assistant', content: `ответ ${index}` });
  }
  const copy = JSON.parse(JSON.stringify(history));
  assert.equal(repairHistoryInPlace(history).changed, false);
  assert.deepEqual(history, copy);
});

test('сообщения не-объекты и без роли выбрасываются', () => {
  const history = [null, 'строка', { content: 'без роли' }, { role: 'user', content: 'вопрос' }];
  const result = normalizeHistory(history);
  assert.equal(result.removed, 3);
  assert.equal(result.messages.length, 1);
});

let failed = 0;
for (const item of tests) {
  try {
    await item.fn();
    console.log(`ok   ${item.name}`);
  } catch (error) {
    failed++;
    console.log(`FAIL ${item.name}: ${error?.message || error}`);
  }
}
console.log(`\n${tests.length - failed}/${tests.length} тестов прошло`);
process.exit(failed ? 1 : 0);
