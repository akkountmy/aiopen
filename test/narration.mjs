/**
 * Начало реплики шага не должно становиться первой строкой ответа.
 *
 * Проверяем то, что видит пользователь в ленте: английская служебная фраза
 * перед инструментами выбрасывается целиком, русский ответ идёт сразу, а то,
 * что уже показано, попадает и в сохранённый текст.
 *
 * Запуск: node test/narration.mjs
 */
import assert from 'node:assert/strict';
import { createNarrationGate } from '../src/narration.mjs';

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`ok   ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`ПРОВАЛ ${name} — ${error.message}`);
  }
}

function collector() {
  const chunks = [];
  return { chunks, emit: (text) => chunks.push(String(text)), get text() { return chunks.join(''); } };
}

test('английское вступление перед инструментами в ленту не попадает', () => {
  const sink = collector();
  const gate = createNarrationGate({ emit: sink.emit });
  gate.push("I'll do all three tasks in parallel.");
  const answer = gate.finish(true);
  assert.equal(sink.text, '', 'в поток ничего не ушло');
  assert.equal(answer, '', 'в сохранённый ответ тоже');
  assert.deepEqual(sink.chunks, []);
});

test('короткое английское вступление ждёт конца шага, а не уходит сразу', () => {
  const sink = collector();
  const gate = createNarrationGate({ emit: sink.emit });
  gate.push('Let me read the file first.');
  assert.equal(sink.text, '', 'пока шаг не закончился — молчим');
  gate.finish(true);
  assert.equal(sink.text, '');
});

test('русский ответ идёт в поток сразу, без задержки первого слова', () => {
  const sink = collector();
  const gate = createNarrationGate({ emit: sink.emit });
  gate.push('Готово: ');
  assert.equal(sink.text, 'Готово: ', 'первый кусок отдан немедленно');
  gate.push('распакован 1 файл.');
  const answer = gate.finish(false);
  assert.equal(sink.text, 'Готово: распакован 1 файл.');
  assert.equal(answer, 'Готово: распакован 1 файл.', 'сохранённый текст совпал с потоком');
});

test('ответ, начатый цифрой или markdown, тоже не тормозит', () => {
  const sink = collector();
  const gate = createNarrationGate({ emit: sink.emit });
  gate.push('1. Первый пункт');
  gate.push('\n2. Второй пункт');
  const answer = gate.finish(false);
  assert.equal(answer, '1. Первый пункт\n2. Второй пункт');
  assert.equal(sink.text, '1. Первый пункт\n2. Второй пункт');
});

test('длинный ответ на английском начинает идти в поток сам и не повторяется', () => {
  const sink = collector();
  const gate = createNarrationGate({ emit: sink.emit, hold: 20 });
  gate.push('Here is the summary');
  assert.equal(sink.text, '', 'пока коротко — копим');
  gate.push(' of the work:');
  assert.match(sink.text, /Here is the summary/, 'перерос буфер — пошло в поток');
  gate.push(' done.');
  const answer = gate.finish(false);
  assert.equal(answer, 'Here is the summary of the work: done.', 'в итог попал весь текст');
  assert.equal(sink.text, 'Here is the summary of the work: done.', 'в потоке нет повторов');
});

test('короткий английский ответ без инструментов доходит целиком в конце шага', () => {
  const sink = collector();
  const gate = createNarrationGate({ emit: sink.emit });
  gate.push('Done.');
  assert.equal(sink.text, '');
  const answer = gate.finish(false);
  assert.equal(sink.text, 'Done.');
  assert.equal(answer, 'Done.');
});

test('что уже видел пользователь, остаётся в ответе при вызове инструментов', () => {
  const sink = collector();
  const gate = createNarrationGate({ emit: sink.emit, hold: 20 });
  gate.push('Длинное рассуждение о плане работы, которое переросло буфер.');
  assert.match(sink.text, /Длинное рассуждение/, 'длинная реплика не тормозит поток');
  assert.match(gate.finish(true), /Длинное рассуждение/, 'показанное не пропадает после перезагрузки');
});

test('пустые куски и пустой шаг не дают мусора в ленте', () => {
  const sink = collector();
  const gate = createNarrationGate({ emit: sink.emit });
  gate.push('');
  gate.push(null);
  gate.push(undefined);
  assert.equal(gate.finish(false), '');
  assert.equal(sink.text, '');
});

test('без emit инструмент честно падает, а не молчит', () => {
  assert.throws(() => createNarrationGate({}), /нужен emit/);
});

console.log(`\n${failed ? `Провалов: ${failed}` : `все ${passed} прошли`}`);
if (failed) process.exitCode = 1;
