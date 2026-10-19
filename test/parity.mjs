/**
 * Тесты паритета P1: постоянная память, навыки, проверка документов.
 * Запуск: node test/parity.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-parity-'));
process.env.DSHOW_DATA_DIR = tmpRoot;
process.env.DSH_DATA_DIR = tmpRoot;
process.env.DSH_HOME = tmpRoot;

const { MEMORY_LIMITS, memoryPromptText, memoryToolReply, normalizeFact } = await import('../src/memory.mjs');
const { listSkills, skillBody, skillsPromptText } = await import('../src/skills.mjs');
const { checkDocument, formatCheckReport } = await import('../src/doccheck.mjs');
const { TOOL_DEFS, executeTool } = await import('../src/tools.mjs');
const { systemPrompt } = await import('../src/prompt.mjs');
const { store } = await import('../src/store.mjs');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const ctx = { workspace: path.join(tmpRoot, 'project') };
fs.mkdirSync(ctx.workspace, { recursive: true });

/* ------------------------------ навыки ------------------------------ */

test('навыки: каталог читается с диска', () => {
  const skills = listSkills();
  const ids = skills.map((skill) => skill.id);
  for (const id of ['office-docx', 'office-xlsx', 'office-pptx', 'pdf-report', 'three-js', 'web-page']) {
    assert.ok(ids.includes(id), `нет навыка ${id}`);
  }
  for (const skill of skills) {
    assert.ok(skill.description.length > 10, `у навыка ${skill.id} пустое описание`);
    assert.ok(skill.chars > 200, `тело навыка ${skill.id} слишком короткое`);
  }
});

test('навыки: тело отдаётся, неизвестный id объясняется', () => {
  const body = skillBody('office-xlsx');
  assert.equal(body.ok, true);
  assert.match(body.text, /create_excel/);
  const missing = skillBody('нет-такого');
  assert.equal(missing.ok, false);
  assert.match(missing.text, /не найден/);
  assert.match(missing.text, /office-docx/);
});

test('навыки: каталог в промпте короткий и перечисляет навыки', () => {
  const text = skillsPromptText();
  assert.match(text, /office-docx/);
  assert.match(text, /use_skill/);
  assert.ok(text.length < 2500, 'каталог навыков раздулся');
});

/* ------------------------------ память ------------------------------ */

test('память: нормализация и дубли', () => {
  assert.equal(normalizeFact('  — Документы называет коротко.  '), 'Документы называет коротко.');
  assert.equal(normalizeFact('x'.repeat(1000)).length, MEMORY_LIMITS.maxFactChars);
});

test('память: пустая память не попадает в промпт', () => {
  assert.equal(memoryPromptText([]), '');
  assert.equal(memoryPromptText(null), '');
});

test('память: факты попадают в промпт с правилами записи', () => {
  const text = memoryPromptText([
    { id: 'm1', text: 'Документы называет коротко и с расширением' },
    { id: 'm2', text: 'Общается по-русски' },
  ]);
  assert.match(text, /Документы называет коротко/);
  assert.match(text, /remember/);
});

test('память: бюджет промпта соблюдается', () => {
  const facts = Array.from({ length: 40 }, (_, index) => ({ id: `m${index}`, text: `Факт номер ${index} `.padEnd(200, 'я') }));
  const text = memoryPromptText(facts);
  assert.ok(text.length < MEMORY_LIMITS.promptChars + 900, `память в промпте ${text.length} символов`);
  assert.match(text, /показаны не все/);
});

test('память: store пишет, заменяет, удаляет и переживает перезагрузку', () => {
  store.init({ adminUsername: 'admin', adminPassword: 'пароль-для-теста' });
  const user = store.createUser({ username: 'tester', password: 'пароль-для-теста-2' });

  const first = store.addMemoryFact(user.id, 'Документы называет коротко и с расширением');
  assert.equal(first.added, 'Документы называет коротко и с расширением');
  assert.equal(first.total, 1);

  const duplicate = store.addMemoryFact(user.id, 'документы называет коротко и с расширением');
  assert.equal(duplicate.added, '');
  assert.match(duplicate.reason, /уже записано/);

  const refined = store.addMemoryFact(user.id, 'Документы называет коротко, с расширением и по-русски');
  assert.equal(refined.replaced, true);
  assert.equal(refined.total, 1, 'уточнение должно заменять старый факт, а не копиться');

  store.addMemoryFact(user.id, 'Общается по-русски');
  assert.equal(store.memoryFacts(user.id).length, 2);

  /* Перезагрузка состояния из index.json: факты должны остаться. */
  store.init({ adminUsername: 'admin', adminPassword: 'пароль-для-теста' });
  assert.equal(store.memoryFacts(user.id).length, 2);

  const facts = store.memoryFacts(user.id);
  const removed = store.removeMemoryFact(user.id, facts[0].id);
  assert.equal(removed.removed, true);
  assert.equal(store.memoryFacts(user.id).length, 1);

  store.clearMemory(user.id);
  assert.deepEqual(store.memoryFacts(user.id), []);
});

test('память: количество фактов ограничено', () => {
  const user = store.getUserByUsername('tester');
  for (let index = 0; index < MEMORY_LIMITS.maxFacts + 8; index++) {
    /* У каждого факта своя лексика: похожие формулировки по правилам памяти
       заменяют друг друга, и проверка лимита была бы бессмысленной. */
    store.addMemoryFact(user.id, `per${index}only`);
  }
  assert.equal(store.memoryFacts(user.id).length, MEMORY_LIMITS.maxFacts);
});

test('память: ответ инструмента помнит и объясняет отказ', () => {
  assert.match(memoryToolReply({ added: 'Факт', replaced: false, total: 3 }), /Запомнил: «Факт»/);
  assert.match(memoryToolReply({ added: '', reason: 'это уже записано', total: 3 }), /уже записано/);
});

/* ------------------------- проверка документов ------------------------- */

test('инструменты remember/use_skill/check_document объявлены', () => {
  const names = TOOL_DEFS.map((tool) => tool.function.name);
  for (const name of ['remember', 'use_skill', 'check_document']) assert.ok(names.includes(name), `нет инструмента ${name}`);
});

test('промпт содержит память и навыки', () => {
  const text = systemPrompt({
    projectName: 'Тест',
    userName: 'Иван',
    memory: 'старая сводка',
    question: 'сделай отчёт',
    facts: [{ id: 'm1', text: 'Документы называет коротко' }],
    skillsText: skillsPromptText(),
  });
  assert.match(text, /Документы называет коротко/);
  assert.match(text, /office-docx/);
  assert.match(text, /Проверка файла/);
});

test('проверка: свежий Word проходит без ошибок', async () => {
  const result = await executeTool(
    'create_word',
    {
      path: 'Отчёт.docx',
      title: 'Отчёт по рынку',
      sections: [
        { heading: 'Резюме', paragraphs: ['Объём рынка вырос на 12 % за год.'], bullets: ['Спрос устойчив'] },
        { heading: 'Финансы', table: { headers: ['Год', 'Выручка'], rows: [['2025', '120'], ['2026', '134']] } },
      ],
    },
    ctx,
  );
  assert.match(result.text, /Word создан/);
  assert.match(result.text, /Проверка файла: OK/);
  assert.equal(result.meta.check.ok, true);
});

test('проверка: Excel со формулами и диаграммой проходит', async () => {
  const result = await executeTool(
    'create_excel',
    {
      path: 'Смета.xlsx',
      sheets: [
        {
          name: 'Расчёт',
          columns: [{ header: 'Статья' }, { header: 'Сумма', numFmt: '#,##0', numeric: true }],
          rows: [['Материалы', 1200], ['Работы', 3400], ['Итого', '=SUM(B2:B3)']],
          totalRow: true,
          chart: { type: 'bar', categoriesColumn: 1, valueColumns: [2] },
        },
      ],
    },
    ctx,
  );
  assert.match(result.text, /Проверка файла: OK/);
  assert.match(result.text, /диаграмм: 1/);
});

test('проверка: презентация и PDF проходят', async () => {
  const pptx = await executeTool(
    'create_pptx',
    {
      path: 'Дек.pptx',
      title: 'Питч-дек',
      slides: [
        { title: 'Рынок растёт', bullets: ['Объём 128 млрд ₸', 'Рост 40 % в год'] },
        { title: 'Экономика', kpi: [{ value: '+40 %', label: 'рост выручки' }, { value: '18 мес', label: 'окупаемость' }] },
      ],
    },
    ctx,
  );
  assert.match(pptx.text, /Проверка файла: OK/);

  const pdf = await executeTool(
    'create_pdf',
    {
      path: 'Отчёт.pdf',
      title: 'Отчёт по рынку',
      sections: [{ heading: 'Резюме', paragraphs: ['Краткий вывод по рынку за год.'], bullets: ['Спрос устойчив', 'Маржа растёт'] }],
    },
    ctx,
  );
  assert.match(pdf.text, /Проверка файла: OK/);
  assert.match(pdf.text, /шрифт|страниц/);
});

test('проверка: испорченный файл даёт ошибку, а не молчание', async () => {
  const broken = path.join(ctx.workspace, 'Битый.docx');
  const source = path.join(ctx.workspace, 'Отчёт.docx');
  fs.writeFileSync(broken, fs.readFileSync(source).subarray(0, 300));
  const check = await checkDocument(broken);
  assert.equal(check.ok, false);
  assert.ok(check.errors.length > 0);
  const report = formatCheckReport(check);
  assert.match(report, /ОШИБКИ/);
  assert.match(report, /нельзя/);
});

test('проверка: check_document работает как отдельный инструмент', async () => {
  const result = await executeTool('check_document', { path: 'Смета.xlsx' }, ctx);
  assert.match(result.text, /Проверка файла/);
  assert.equal(result.meta.ok, true);
});

test('remember без памяти не притворяется, что записал', async () => {
  const result = await executeTool('remember', { text: 'Правило' }, ctx);
  assert.match(result.text, /недоступна/);
});

test('remember через контекст пишет факт', async () => {
  const user = store.getUserByUsername('tester');
  const result = await executeTool('remember', { text: 'Презентации делает на 10 слайдов' }, { ...ctx, remember: (text) => store.addMemoryFact(user.id, text) });
  assert.match(result.text, /Запомнил/);
  assert.ok(store.memoryFacts(user.id).some((fact) => /Презентации делает/.test(fact.text)));
});

/* ------------------------------- запуск ------------------------------- */

let failed = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (error) {
    failed++;
    console.log(`FAIL ${name}`);
    console.log(`     ${error.message}`);
  }
}
fs.rmSync(tmpRoot, { recursive: true, force: true });
console.log(`\nИтог: ${tests.length - failed} из ${tests.length}`);
if (failed) process.exit(1);
