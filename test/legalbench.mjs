/**
 * Тесты юридического полигона Harvey LAB без сети и без git:
 * разбор id, фильтры каталога, разбор вердикта судьи, сборка отчёта,
 * правило «всё-или-ничего» и чтение деливераблов.
 * Запуск: node --test test/legalbench.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-legalbench-'));
process.env.DSHOW_LEGALBENCH_DIR = path.join(tmpRoot, 'legalbench');

const {
  resolveTaskId,
  filterTasks,
  parseVerdict,
  buildJudgePrompt,
  collectDeliverableText,
  renderReport,
  scoreRun,
  judgeRoute,
  labStatus,
  readCatalog,
  NUDGE,
} = await import('../src/legalbench.mjs');

/** Вердикт без служебного флага ok — для сравнения целиком. */
const pick = (verdict) => ({ pass: verdict.pass, reason: verdict.reason });

test('id задания нормализуется и не выводит за пределы tasks/', () => {
  assert.equal(resolveTaskId('tasks/real-estate/deal/scenario-01/'), 'real-estate/deal/scenario-01');
  assert.equal(resolveTaskId('  real-estate\\deal\\scenario-01 '), 'real-estate/deal/scenario-01');
  assert.throws(() => resolveTaskId('real-estate/../secrets'), /Некорректный id/);
  assert.throws(() => resolveTaskId('/etc/passwd'), /Некорректный id/);
  assert.throws(() => resolveTaskId(''), /Нужен id задания/);
});

test('фильтры каталога: практика, тип работы, слова, размер рубрики и страницы', () => {
  const catalog = [
    { id: 'real-estate/a', area: 'real-estate', title: 'Договор купли-продажи', workType: 'draft', criteria: 12, tags: ['psa'] },
    { id: 'real-estate/b', area: 'real-estate', title: 'Проверка отчёта', workType: 'review', criteria: 40, tags: [] },
    { id: 'contracts/c', area: 'contracts', title: 'NDA', workType: 'draft', criteria: 9, tags: ['nda'] },
  ];
  assert.equal(filterTasks(catalog, {}).total, 3);
  assert.deepEqual(filterTasks(catalog, { area: 'real-estate' }).items.map((item) => item.id), ['real-estate/a', 'real-estate/b']);
  assert.deepEqual(filterTasks(catalog, { workType: 'draft' }).items.map((item) => item.id), ['real-estate/a', 'contracts/c']);
  assert.deepEqual(filterTasks(catalog, { q: 'nda' }).items.map((item) => item.id), ['contracts/c']);
  assert.deepEqual(filterTasks(catalog, { maxCriteria: 12 }).items.map((item) => item.id), ['real-estate/a', 'contracts/c']);
  assert.deepEqual(filterTasks(catalog, { minCriteria: 20 }).items.map((item) => item.id), ['real-estate/b']);
  const page = filterTasks(catalog, { limit: 1, offset: 1 });
  assert.equal(page.total, 3);
  assert.deepEqual(page.items.map((item) => item.id), ['real-estate/b']);
});

test('вердикт судьи разбирается из JSON, из JSON в тексте и по словам', () => {
  assert.deepEqual(pick(parseVerdict('{"verdict":"PASS","reason":"пункт есть"}')), {
    pass: true,
    reason: 'пункт есть',
  });
  assert.deepEqual(pick(parseVerdict('Вот результат:\n```json\n{"verdict": "FAIL", "reason": "цифры нет"}\n```')), {
    pass: false,
    reason: 'цифры нет',
  });
  assert.equal(parseVerdict('{"pass":true}').pass, true);
  assert.equal(parseVerdict('FAIL — в меморандуме нет порога 50 человек').pass, false);
  assert.equal(parseVerdict('PASS, всё найдено').pass, true);
  const broken = parseVerdict('модель промолчала');
  assert.equal(broken.pass, false, 'неразборчивый ответ не должен засчитываться');
  assert.equal(broken.ok, false, 'неразборчивый ответ помечается для повтора');
  assert.match(broken.reason, /не вернул разборчивый вердикт/);
});

test('судья отвечает своими полями, и это не считается мусором', () => {
  // Именно так отвечает deepseek-v4-pro: result булевым, reason в поле reasoning.
  assert.deepEqual(pick(parseVerdict('{"criterion_id":"C-021","result":true,"reasoning":"срок 60 дней есть"}')), {
    pass: true,
    reason: 'срок 60 дней есть',
  });
  assert.equal(parseVerdict('{"status":"pass","reason":"есть"}').pass, true);
  assert.equal(parseVerdict('{"status":"fail","reason":"нет"}').pass, false);
  assert.equal(parseVerdict('{"verdict":"НЕ ВЫПОЛНЕН","reason":"нет цифры"}').pass, false);
  assert.equal(parseVerdict('{"verdict":"выполнен","reason":"цифра есть"}').pass, true);
  assert.equal(parseVerdict('{"met":false,"explanation":"нет раздела"}').pass, false);
  assert.equal(parseVerdict('{"met":true}').pass, true);
  assert.equal(parseVerdict('{"verdict":"MAYBE"}').pass, false, 'неоднозначный ответ не засчитывается');
  assert.equal(parseVerdict('{"verdict":"MAYBE"}').ok, false);
});

test('повторный запрос к судье требует ровно два поля', () => {
  const prompt = buildJudgePrompt({
    taskTitle: 'WARN Act opposition memo',
    criterion: { id: 'C-021', title: 'Срок 60 дней', match: 'PASS if the memo states 60 days.' },
    names: ['memo.docx'],
    text: '60 days required.',
  });
  const nudge = NUDGE(prompt);
  assert.match(nudge, /\{"verdict":"PASS","reason":"…"\}/);
  assert.match(nudge, /ПРЕДЫДУЩИЙ ОТВЕТ БЫЛ НЕ В ФОРМАТЕ/);
});

test('промпт судьи содержит критерий, стандарт проверки и текст работы', () => {
  const prompt = buildJudgePrompt({
    taskTitle: 'WARN Act opposition memo',
    criterion: { id: 'C-003', title: 'Порог массового увольнения', match: 'PASS if the memo notes 37 < 50.' },
    names: ['issue-identification-memo.docx'],
    text: 'Huntsville: 37 из 143.',
  });
  assert.match(prompt, /ЗАДАНИЕ: WARN Act opposition memo/);
  assert.match(prompt, /КРИТЕРИЙ C-003: Порог массового увольнения/);
  assert.match(prompt, /СТАНДАРТ ПРОВЕРКИ: PASS if the memo notes 37 < 50\./);
  assert.match(prompt, /issue-identification-memo\.docx/);
  assert.match(prompt, /Huntsville: 37 из 143\./);

  const empty = buildJudgePrompt({
    taskTitle: 't',
    criterion: { id: 'C-1', title: 'x', match: 'y' },
    names: [],
    text: '',
  });
  assert.match(empty, /\(файл отсутствует или пуст\)/);
});

test('текст деливерабла собирается из output, отсутствующие файлы отмечаются', () => {
  const dir = path.join(tmpRoot, 'output');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'memo.md'), '# Меморандум\n\nПорог 50 человек не достигнут: 37 уволенных.', 'utf8');
  const good = collectDeliverableText(dir, ['memo.md']);
  assert.match(good.text, /=== memo\.md ===/);
  assert.match(good.text, /37 уволенных/);
  assert.deepEqual(good.missing, []);

  const partial = collectDeliverableText(dir, ['memo.md', 'term-sheet.docx']);
  assert.deepEqual(partial.missing, ['term-sheet.docx']);
  const none = collectDeliverableText(dir, ['нет-такого.docx']);
  assert.equal(none.text, '');
  assert.deepEqual(none.missing, ['нет-такого.docx']);

  const long = 'а'.repeat(500);
  fs.writeFileSync(path.join(dir, 'long.md'), long, 'utf8');
  const clipped = collectDeliverableText(dir, ['long.md'], { maxChars: 100 });
  assert.equal(clipped.text.length < 200, true);
  assert.match(clipped.text, /текст обрезан по бюджету проверки/);
});

test('оценка «всё-или-ничего»: единица только при полном прохождении рубрики', () => {
  assert.deepEqual(scoreRun([]), { passedCount: 0, total: 0, score: 0 });
  assert.deepEqual(scoreRun([{ pass: true }, { pass: true }]), { passedCount: 2, total: 2, score: 1 });
  assert.equal(scoreRun([{ pass: true }, { pass: false }]).score, 0);
  assert.equal(scoreRun([{ pass: false }]).passedCount, 0);
});

test('модель судьи: pro и flash берутся из настроек, явное имя идёт как есть', () => {
  assert.equal(judgeRoute('pro').key, 'pro');
  assert.equal(judgeRoute('flash').key, 'flash');
  const explicit = judgeRoute('deepseek-chat');
  assert.equal(explicit.model, 'deepseek-chat');
});

test('отчёт показывает балл, вердикты и экранирует текст рубрики', () => {
  const html = renderReport({
    taskId: 'employment-labor/x',
    title: 'Меморандум <тест>',
    score: 0,
    passedCount: 1,
    total: 2,
    rubricTotal: 2,
    model: 'deepseek-v4-pro',
    usage: { in: 100, out: 20 },
    finishedAt: '2026-11-03T10:00:00.000Z',
    criteria: [
      { id: 'C-001', title: 'Порог 37 < 50', pass: true, reason: 'указано' },
      { id: 'C-002', title: 'Ошибка арифметики', pass: false, reason: 'разница < 6 676 $ не названа' },
    ],
  });
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /Меморандум &lt;тест&gt;/);
  assert.match(html, /0\.0/);
  assert.match(html, /пройдено 1 из 2 критериев \(50%\)/);
  assert.match(html, /class="pass"/);
  assert.match(html, /class="fail"/);
  assert.match(html, /разница &lt; 6 676 \$ не названа/);
  assert.match(html, /всё-или-ничего/);
});

test('без скачанного каталога полигон честно сообщает, что он пуст', () => {
  const status = labStatus();
  assert.equal(status.ready, false);
  assert.equal(status.tasks, 0);
  assert.deepEqual(readCatalog({ strict: false }), []);
  assert.throws(() => readCatalog(), /Каталог заданий не собран/);
});
