import test from 'node:test';
import assert from 'node:assert/strict';
import { createReasoningGate, looksRussian } from '../src/reasoning.mjs';

test('русские рассуждения идут в ленту сразу', () => {
  const events = [];
  const gate = createReasoningGate({ emit: (text) => events.push(text), translate: async () => 'НЕ ДОЛЖНО ВЫЗЫВАТЬСЯ' });
  gate.push('Нужно посчитать 17 на 23. ');
  gate.push('Сначала умножим, потом сложим.');
  assert.equal(events.join(''), 'Нужно посчитать 17 на 23. Сначала умножим, потом сложим.');
});

test('английские рассуждения не показываются и переводятся к концу шага', async () => {
  const events = [];
  let asked = '';
  const gate = createReasoningGate({
    emit: (text) => events.push(text),
    translate: async (text) => {
      asked = text;
      return 'Нужно посчитать произведение.';
    },
  });
  gate.push('We need to ');
  gate.push('calculate 17*23. Let me check the numbers.');
  assert.deepEqual(events, [], 'английский не должен попасть в интерфейс');
  const shown = await gate.finish();
  assert.equal(shown, 'Нужно посчитать произведение.');
  assert.deepEqual(events, ['Нужно посчитать произведение.']);
  assert.match(asked, /We need to calculate/);
});

test('если перевод не удался, английский не показывается вообще', async () => {
  const events = [];
  const gate = createReasoningGate({
    emit: (text) => events.push(text),
    translate: async () => {
      throw new Error('сеть недоступна');
    },
  });
  gate.push('We need to calculate 17*23 and explain it.');
  const shown = await gate.finish();
  assert.equal(shown, '');
  assert.deepEqual(events, []);
});

test('определение русского текста', () => {
  assert.equal(looksRussian('Нужно посчитать 17 на 23 и проверить результат'), true);
  assert.equal(looksRussian('We need to calculate 17*23 and check the result'), false);
  assert.equal(looksRussian('17*23 = 391'), false);
});
