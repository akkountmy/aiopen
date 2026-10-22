/**
 * Тесты обрезки результатов и автосжатия истории — порт поведения dsh-trim
 * в сервис: детерминированное сжатие, выжимка с выгрузкой полного текста,
 * срез истории со сводкой и счётчики экономии.
 * Запуск: node test/trim.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-trim-'));
process.env.DSH_DATA_DIR = tmpRoot;

const {
  boundPreview,
  collapseBlankRuns,
  collapseDiffContext,
  compactText,
  compressHistory,
  createTrimStats,
  describeTrim,
  dropHistory,
  foldRepeatedLines,
  historyTokens,
  mergeTrim,
  messageCost,
  noteTrim,
  resolveTrimConfig,
  spillText,
  stripEscapes,
  trimToolResult,
} = await import('../src/trim.mjs');
const { executeTool } = await import('../src/tools.mjs');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const workspace = path.join(tmpRoot, 'project');
fs.mkdirSync(workspace, { recursive: true });
const config = resolveTrimConfig({ adaptive: true });

/* ------------------------------- сжатие ------------------------------- */

test('управляющие последовательности убираются', () => {
  const source = '\u001b[31mошибка\u001b[0m собрана\u001b]0;заголовок\u0007\nдальше';
  assert.equal(stripEscapes(source), 'ошибка собрана\nдальше');
});

test('пустые строки схлопываются до двух', () => {
  assert.equal(collapseBlankRuns('a\n\n\n\n\nb'), 'a\n\nb');
  assert.equal(collapseBlankRuns('a\n \n\t\n\nb'), 'a\n\nb');
  /* Два перевода строки — законный абзац, его не трогаем. */
  assert.equal(collapseBlankRuns('a\n\nb'), 'a\n\nb');
});

test('повторы строк сворачиваются счётчиком', () => {
  const line = 'предупреждение: поле «сумма» пустое';
  const folded = foldRepeatedLines([line, line, line, line, 'конец'].join('\n'));
  assert.equal(folded, `${line} (×4)\nконец`);
});

test('короткие строки и строки таблиц не сворачиваются', () => {
  assert.equal(foldRepeatedLines('ok\nok\nok\nok'), 'ok\nok\nok\nok');
  const row = '2025-01-01,Москва,1200,50';
  assert.equal(foldRepeatedLines([row, row, row, row].join('\n')), [row, row, row, row].join('\n'));
  const table = '| a | b |';
  assert.equal(foldRepeatedLines([table, table, table, table].join('\n')), [table, table, table, table].join('\n'));
});

test('длинные куски неизменённых строк в diff сворачиваются', () => {
  const lines = ['@@ -1,30 +1,30 @@', ...Array(20).fill(' контекст без изменений'), '+новая строка', ...Array(12).fill(' ещё контекст')];
  const result = collapseDiffContext(lines.join('\n'), { keep: 2 });
  assert.ok(result.length < lines.join('\n').length);
  assert.match(result, /строк без изменений/);
  assert.match(result, /\+новая строка/);
  assert.ok(result.startsWith('@@ -1,30 +1,30 @@'));
});

test('compactText детерминирован и никогда не растёт', () => {
  const source = ['Блок 1', '\u001b[1mжирный\u001b[0m', '', '', '', 'Блок 2', '', '', 'Блок 3'].join('\n');
  const once = compactText(source, config);
  const twice = compactText(once, config);
  assert.equal(once, twice, 'повторное сжатие должно возвращать тот же текст');
  assert.ok(once.length <= source.length);
  assert.equal(compactText(once, config), compactText(source, config));
});

/* --------------------------- результат инструмента --------------------------- */

test('малый ответ инструмента не меняется ни на байт', () => {
  const text = 'готово: 3 файла, 12 строк';
  const result = trimToolResult({ name: 'write_file', text, workspace, config });
  assert.equal(result.text, text);
  assert.equal(result.applied, 'none');
  assert.equal(result.spill, null);
});

test('осознанное чтение проходит дословно', () => {
  const text = 'x'.repeat(30000);
  for (const name of ['read_file', 'read_document', 'use_skill']) {
    const result = trimToolResult({ name, text, workspace, config });
    assert.equal(result.text, text, `${name} не должен сокращаться`);
    assert.equal(result.spill, null);
  }
});

test('свежий контекст: средний ответ не трогаем', () => {
  const text = `${'строка данных\n'.repeat(400)}`;
  const result = trimToolResult({ name: 'fetch_url', text, workspace, pressure: 1000, config });
  assert.equal(result.applied, 'none');
  assert.equal(result.text, text);
});

test('под давлением средний ответ сжимается без выгрузки', () => {
  const text = `${'повтор\n\n\n'.repeat(600)}итог`;
  const result = trimToolResult({ name: 'fetch_url', text, workspace, pressure: 90000, config });
  assert.equal(result.applied, 'compacted');
  assert.ok(result.text.length < text.length);
  assert.equal(result.spill, null);
  assert.equal(result.savedChars, text.length - result.text.length);
});

test('огромный ответ: выжимка, выгрузка и ссылка на полный текст', async () => {
  const body = Array.from({ length: 3000 }, (_, index) => `строка ${index}: значение ${index * 3}`).join('\n');
  const text = `${body}\n[exit code: 1]`;
  const result = trimToolResult({ name: 'read_page', text, workspace, pressure: 200000, config });

  assert.equal(result.applied, 'preview');
  assert.ok(result.text.length <= config.maxInlineChars + 400, `выжимка слишком большая: ${result.text.length}`);
  assert.match(result.text, /Результат сокращён/);
  assert.ok(result.spill, 'полный текст должен быть выгружен');
  assert.match(result.text, /\.trims\//);
  /* Служебная пометка о коде выхода остаётся в конце. */
  assert.ok(result.text.trimEnd().endsWith('[exit code: 1]'), 'пометка кода выхода должна сохраняться');

  /* Полный текст лежит в проекте и читается обычным чтением файла — модель
     может дотянуться до любой строки по offset. */
  const full = fs.readFileSync(path.join(workspace, result.spill), 'utf8');
  assert.equal(full, text);
  const read = await executeTool(
    'read_file',
    { path: result.spill, offset: 2995, limit: 10 },
    { workspace, signal: new AbortController().signal },
  );
  assert.match(String(read.text), /значение 8997/);
});

test('выжимка не теряет начало и конец', () => {
  const text = Array.from({ length: 2000 }, (_, index) => `#${index} строка текста для проверки выжимки`).join('\n');
  const preview = boundPreview(text, { head: 500, tail: 300 });
  assert.ok(preview.includes('#0 '));
  assert.ok(preview.includes('#1999 '));
  /* Начало + конец + одна строка-метка, без раздувания. */
  assert.ok(preview.length <= 900, `выжимка слишком большая: ${preview.length}`);
  assert.match(preview, /сокращено/);
});

test('выгрузка ограничена по количеству файлов', () => {
  const limit = 5;
  for (let index = 0; index < 12; index++) {
    spillText({ workspace, label: `test${index}`, text: `текст ${index}`, config: { ...config, maxSpillFiles: limit } });
  }
  const files = fs.readdirSync(path.join(workspace, '.trims'));
  assert.ok(files.length <= limit, `файлов больше предела: ${files.length}`);
});

test('обрезка не падает на странном входе', () => {
  for (const text of ['', null, undefined, 0, 'a'.repeat(20000)]) {
    const result = trimToolResult({ name: 'web_search', text, workspace, config });
    assert.equal(typeof result.text, 'string');
  }
  /* Нет рабочей папки — выгрузка недоступна, но ответ остаётся рабочим. */
  const huge = 'строка\n'.repeat(4000);
  const result = trimToolResult({ name: 'fetch_url', text: huge, workspace: null, pressure: 200000, config });
  assert.ok(result.text.length > 0);
});

/* ---------------------------- история разговора ---------------------------- */

function makeHistory(count) {
  const history = [];
  for (let index = 0; index < count; index++) {
    history.push({ role: 'user', content: `Вопрос ${index}: ${'подробности '.repeat(120)}` });
    history.push({
      role: 'assistant',
      content: null,
      tool_calls: [{ id: `c${index}`, type: 'function', function: { name: 'read_file', arguments: '{"path":"a.csv"}' } }],
    });
    history.push({ role: 'tool', tool_call_id: `c${index}`, content: `Ответ ${index}: ${'данные '.repeat(400)}` });
    history.push({ role: 'assistant', content: `Короткий ответ ${index}` });
  }
  return history;
}

test('бюджет истории оценивается по сообщениям', () => {
  assert.ok(messageCost({ role: 'user', content: 'привет' }) > 0);
  const history = makeHistory(3);
  assert.ok(historyTokens(history) > 0);
  assert.ok(historyTokens(history) >= history.length * 4);
});

test('срез истории идёт с начала и не разрывает пары вызов-ответ', () => {
  const history = makeHistory(12);
  const first = history[0];
  const removed = dropHistory(history, { budget: 3000, keepRecent: 8 });
  assert.ok(removed.length > 0);
  assert.equal(removed[0], first, 'срезается самое старое сообщение');
  assert.ok(history.length >= 8, 'последние сообщения остаются');
  /* Каждый ответ инструмента остался вместе со своим вызовом. */
  for (let index = 0; index < history.length; index++) {
    const message = history[index];
    if (message.role !== 'tool') continue;
    const previous = history.slice(0, index).reverse().find((item) => item.role === 'assistant' && Array.isArray(item.tool_calls));
    assert.ok(previous?.tool_calls.some((call) => call.id === message.tool_call_id), 'ответ инструмента без вызова');
  }
});

test('закреплённая задача не срезается и не меняет порядок', () => {
  const history = makeHistory(10);
  /* Задача стоит в середине: до неё — прошлые реплики, после — её шаги. */
  const task = { role: 'user', content: 'Текущая задача: собери отчёт по выручке' };
  const step = { role: 'assistant', content: 'Начинаю с файла' };
  history.push(task, step);

  dropHistory(history, { budget: 2000, keepRecent: 6, pinned: task });

  assert.ok(history.includes(task), 'закреплённое сообщение потеряно');
  const index = history.indexOf(task);
  assert.equal(history[index + 1], step, 'шаг задачи должен остаться сразу за задачей');
  /* Всё, что стояло после задачи, осталось после неё — порядок не перепутан. */
  assert.ok(history.indexOf(step) > index);
});

test('автосжатие: сводка в памяти и полный текст в файле', async () => {
  const history = makeHistory(14);
  const chat = { history, memory: null };
  const stats = createTrimStats();
  let asked = '';
  const result = await compressHistory({
    chat,
    workspace,
    budget: 1500,
    keepRecent: 6,
    summarize: async (text) => {
      asked = text;
      return 'Ранее обсуждали загрузку CSV и подсчёт выручки.';
    },
    config,
    stats,
  });

  assert.ok(result.removed > 0);
  assert.ok(asked.length > 0, 'модель должна получить срезанный текст');
  assert.match(chat.memory, /CSV/);
  assert.ok(result.spill, 'срезанная часть должна быть выгружена');
  assert.match(result.spill, /^\.history\//, 'срез разговора лежит в отдельной папке');
  assert.match(chat.memory, /\.history\//);
  const full = fs.readFileSync(path.join(workspace, result.spill), 'utf8');
  assert.match(full, /Вопрос 0/);
  assert.equal(stats.historySummaries, 1);
  assert.equal(stats.historyFallbacks, 0);
});

test('автосжатие без модели: детерминированная выжимка вместо потери', async () => {
  const chat = { history: makeHistory(10), memory: null };
  const stats = createTrimStats();
  const result = await compressHistory({
    chat,
    workspace,
    budget: 1200,
    keepRecent: 5,
    summarize: async () => {
      throw new Error('модель недоступна');
    },
    config,
    stats,
  });
  assert.equal(result.fallback, true);
  assert.match(chat.memory, /Ранее в разговоре/);
  assert.equal(stats.historyFallbacks, 1);
});

test('память чата не растёт без предела', async () => {
  const chat = { history: makeHistory(20), memory: 'старая память' };
  await compressHistory({
    chat,
    workspace,
    budget: 1200,
    keepRecent: 5,
    memoryChars: 600,
    summarize: async () => 'короткая сводка',
    config,
  });
  assert.ok(chat.memory.length <= 620, `память слишком большая: ${chat.memory.length}`);
});

test('при переполнении памяти новая сводка и ссылка на файл остаются', async () => {
  /* Раньше память обрезалась с конца — то есть первыми пропадали свежая сводка
     и ссылка на полный текст среза, а оставалось самое старое. */
  const previous = `старая память: ${'детали прошлых шагов '.repeat(60)}`;
  const chat = { history: makeHistory(20), memory: previous };
  const result = await compressHistory({
    chat,
    workspace,
    budget: 1200,
    keepRecent: 5,
    memoryChars: 600,
    summarize: async () => 'НОВАЯ СВОДКА про бюджет',
    config,
  });
  assert.match(chat.memory, /НОВАЯ СВОДКА/, 'свежая сводка потерялась');
  assert.match(chat.memory, /\.history\//, 'ссылка на полный текст потерялась');
  assert.ok(chat.memory.length <= 600, `память выросла сверх бюджета: ${chat.memory.length}`);
  assert.ok(!chat.memory.includes('…[сокращено]'), 'старая обрезка с хвоста вернулась');
  /* Старая память не выброшена: она целиком лежит в файле, ссылка на него есть. */
  assert.ok(result.memoryFile, 'нет файла с прежней памятью');
  const archived = fs.readFileSync(path.join(workspace, result.memoryFile), 'utf8');
  assert.match(archived, /детали прошлых шагов/);
  assert.match(archived, /НОВАЯ СВОДКА/);
});

test('пока память влезает, прошлое и новое хранятся вместе', async () => {
  const chat = { history: makeHistory(20), memory: 'прошлая договорённость: бренд «Ромашка»' };
  await compressHistory({
    chat,
    workspace,
    budget: 1200,
    keepRecent: 5,
    memoryChars: 4000,
    summarize: async () => 'новая договорённость: бюджет 200 000 ₽',
    config,
  });
  assert.match(chat.memory, /Ромашка/);
  assert.match(chat.memory, /200 000/);
  assert.ok(chat.memory.indexOf('Ромашка') < chat.memory.indexOf('200 000'), 'порядок «старое → новое» нарушен');
});

test('чистка выгрузок инструментов не удаляет срезы истории', async () => {
  const localWs = path.join(tmpRoot, 'ws-history');
  fs.mkdirSync(localWs, { recursive: true });
  const chat = { history: makeHistory(10), memory: null };
  const saved = await compressHistory({
    chat,
    workspace: localWs,
    budget: 1500,
    keepRecent: 6,
    summarize: async () => 'сводка',
    config,
  });
  assert.match(saved.spill, /^\.history\//);
  /* Много коротких выгрузок инструментов с крошечным лимитом: чистится только .trims. */
  for (let index = 0; index < 5; index++) {
    spillText({ workspace: localWs, label: `test${index}`, text: `текст ${index}`, config: { ...config, maxSpillFiles: 2 } });
  }
  const historyFiles = fs.readdirSync(path.join(localWs, '.history'));
  assert.ok(historyFiles.length >= 1, 'срез истории удалён вместе с выгрузками инструментов');
  assert.ok(fs.existsSync(path.join(localWs, saved.spill)), 'файл среза истории пропал');
});

test('счётчики считают экономию и описываются словами', () => {
  const stats = createTrimStats();
  noteTrim(stats, { applied: 'compacted', spill: null, savedChars: 800 });
  noteTrim(stats, { applied: 'preview', spill: '.trims/a.txt', savedChars: 12000 });
  noteTrim(stats, { applied: 'none', spill: null, savedChars: 0 });
  stats.historyDrops = 1;
  assert.equal(stats.toolResults, 3);
  assert.equal(stats.compacted, 1);
  assert.equal(stats.previews, 1);
  assert.equal(stats.spills, 1);
  assert.equal(stats.savedChars, 12800);
  const line = describeTrim(stats);
  assert.match(line, /12800/);
  assert.match(line, /\.trims/);
  assert.equal(describeTrim(createTrimStats()), '');
});

test('счётчики субагента складываются в общие', () => {
  const total = createTrimStats();
  const child = createTrimStats();
  noteTrim(total, { applied: 'compacted', savedChars: 100 });
  noteTrim(child, { applied: 'preview', spill: '.trims/x.txt', savedChars: 900 });
  child.historyDrops = 1;
  mergeTrim(total, child);
  assert.equal(total.toolResults, 2);
  assert.equal(total.previews, 1);
  assert.equal(total.spills, 1);
  assert.equal(total.savedChars, 1000);
  assert.equal(total.historyDrops, 1);
  /* Пустые значения не ломают слияние. */
  mergeTrim(total, null);
  assert.equal(total.toolResults, 2);
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
fs.rmSync(tmpRoot, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
