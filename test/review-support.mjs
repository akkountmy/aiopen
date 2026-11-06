/**
 * Ревью: откуда берутся опорные числа и файлы.
 *
 * Проверяем именно то, что давало ложные находки: число из условия задачи,
 * число, посчитанное из имеющихся, число без всякого происхождения, а также
 * файл, созданный в прошлом ходу.
 *
 * Запуск: node test/review-support.mjs
 */
import assert from 'node:assert/strict';

const { buildSupport, checkAnswer, derivedSeen, numericPool, needsReview } = await import('../src/review.mjs');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

/* Типичный ответ на задачу с условиями пользователя: инструментов много,
   но чисел пользователя в их результатах нет — раньше это давало «high». */
const USER_QUESTION = 'Посчитай смету на забор: 42 метра, цена 1 250 рублей за метр, ворота 18 000. Бюджет 90 000.';
const DIGEST = 'calculate: {"expression":"42 * 1250 + 18000","result":70500}';
const ANSWER = `Смета по вашим данным: 42 м забора по 1 250 ₽ — 52 500 ₽, ворота 18 000 ₽, итого 70 500 ₽ из бюджета 90 000 ₽. Остаток 19 500 ₽.`;

test('условия пользователя — опора, а не выдумка', () => {
  const support = buildSupport({ userQuestion: USER_QUESTION, history: [] });
  assert.ok(support.includes('1 250'), 'числа из запроса должны попасть в опору');
  assert.ok(support.includes('90 000'), 'бюджет из запроса должен попасть в опору');
});

test('ответ по условиям пользователя не даёт находок «числа без опоры»', () => {
  const support = buildSupport({ userQuestion: USER_QUESTION, history: [{ role: 'user', content: USER_QUESTION }] });
  const issues = checkAnswer({ answer: ANSWER, toolDigest: DIGEST, createdFiles: [], projectFiles: [], supportedText: support });
  assert.deepEqual(issues, [], `лишние находки: ${JSON.stringify(issues)}`);
});

test('без опоры пользователя то же число — находка (проверка не ослаблена)', () => {
  const issues = checkAnswer({ answer: ANSWER, toolDigest: 'calculate: {"result":1}', createdFiles: [], projectFiles: [], supportedText: '' });
  const figures = issues.filter((issue) => issue.kind === 'figure');
  assert.ok(figures.length > 0, 'выдуманные числа должны остаться находкой');
});

test('посчитанное из имеющихся чисел выдумкой не считается', () => {
  const pool = numericPool('доход 1 200 000, расход 800 000');
  assert.ok(derivedSeen(400000, pool), 'разница должна опознаваться как расчёт');
  assert.ok(derivedSeen(2000000, pool), 'сумма должна опознаваться как расчёт');
  const percentPool = numericPool('выручка 1 200 000, ставка 15%');
  assert.ok(derivedSeen(180000, percentPool), 'процент от величины должен опознаваться как расчёт');
  assert.equal(derivedSeen(731234, pool), false, 'чужое число расчётом быть не должно');
});

test('файл из прошлого хода не считается обещанием несуществующего', () => {
  const answer = 'Отчёт обновлён: docs/смета-забор.xlsx — можно открывать.';
  const strict = checkAnswer({ answer, toolDigest: 'read_file: ok', createdFiles: [], projectFiles: [] });
  assert.ok(strict.some((issue) => issue.kind === 'file'), 'без списка проекта файл должен быть находкой');
  const withProject = checkAnswer({
    answer,
    toolDigest: 'read_file: ok',
    createdFiles: [],
    projectFiles: ['docs/смета-забор.xlsx', 'README.md'],
  });
  assert.deepEqual(withProject.filter((issue) => issue.kind === 'file'), [], 'существующий файл — не находка');
});

test('пустой ответ и ответ без инструментов ревью не требуют', () => {
  assert.equal(needsReview({ answer: 'коротко', tools: [{ name: 'read_file', status: 'ok' }] }), false);
  assert.equal(needsReview({ answer: 'а'.repeat(900), tools: [] }), false);
  assert.equal(needsReview({ answer: 'а'.repeat(900), tools: [{ name: 'read_file', status: 'ok' }] }), true);
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
