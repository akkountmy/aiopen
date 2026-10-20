/**
 * Тесты анализа данных (analyze_data): потоковый разбор CSV, чтение XLSX,
 * профилирование колонок, фильтры, группировка, метрики и вывод для модели.
 * Запуск: node test/analysis.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-analysis-'));
process.env.DSH_DATA_DIR = tmpRoot;

const { analyzeData, formatAnalysis, toNumber, toDate } = await import('../src/analysis.mjs');
const { executeTool } = await import('../src/tools.mjs');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const workspace = path.join(tmpRoot, 'project');
fs.mkdirSync(workspace, { recursive: true });
const ctx = { workspace };
const file = (name) => path.join(workspace, name);

// CSV: «;», десятичная запятая, тысячи пробелом, кавычки с переводом строки.
const salesRows = ['Дата;Регион;Выручка;Менеджер;Комментарий'];
const regions = ['Москва', 'Казань', 'Сочи'];
const managers = ['Иванов', 'Петров'];
for (let i = 0; i < 1200; i++) {
  const day = String((i % 28) + 1).padStart(2, '0');
  const month = String((i % 12) + 1).padStart(2, '0');
  const amount = `${1000 + (i % 400)},50`;
  const comment = i % 97 === 0 ? '"сделка,\nповторная"' : '"обычная"';
  salesRows.push(`${day}.${month}.2025;${regions[i % 3]};${amount};${managers[i % 2]};${comment}`);
}
fs.writeFileSync(file('sales.csv'), salesRows.join('\r\n'), 'utf8');

test('toNumber понимает русские числа, проценты и валюту', () => {
  assert.equal(toNumber('1 234 567,89'), 1234567.89);
  assert.equal(toNumber('12,5%'), 0.125);
  assert.equal(toNumber('$1,200.50'), 1200.5);
  assert.equal(toNumber('—'), null);
  assert.equal(toNumber('Клиент 7'), null);
});

test('toDate не принимает произвольный текст за дату', () => {
  assert.equal(toDate('Клиент 0'), null);
  assert.equal(toDate('31.12.2025').toISOString().slice(0, 10), '2025-12-31');
  assert.equal(toDate('2025-03-05T10:00:00Z').toISOString().slice(0, 10), '2025-03-05');
  /* Дата из exceljs (местная полночь) и дата из кода (полночь UTC) должны давать
     один и тот же календарный день — независимо от часового пояса машины. */
  assert.equal(toDate(new Date(2025, 0, 1)).toISOString().slice(0, 10), '2025-01-01');
  assert.equal(toDate(new Date(Date.UTC(2025, 0, 1))).toISOString().slice(0, 10), '2025-01-01');
});

test('profile: строки, типы, пропуски, медиана и частые значения', async () => {
  const result = await analyzeData({ filePath: file('sales.csv'), mode: 'profile' });
  assert.equal(result.mode, 'profile');
  assert.equal(result.scanned, 1200);
  assert.equal(result.delimiter, ';');
  assert.deepEqual(result.profiles.map((item) => item.column), ['Дата', 'Регион', 'Выручка', 'Менеджер', 'Комментарий']);
  const revenue = result.profiles.find((item) => item.column === 'Выручка');
  assert.equal(revenue.kind, 'число');
  assert.equal(revenue.filled, 1200);
  assert.equal(revenue.empty, 0);
  assert.ok(revenue.mean > 1000 && revenue.mean < 1400, `среднее ${revenue.mean}`);
  assert.ok(revenue.median != null && revenue.p95 >= revenue.median, 'median и p95 посчитаны');
  const region = result.profiles.find((item) => item.column === 'Регион');
  assert.equal(region.kind, 'текст');
  assert.equal(region.distinct, 3);
  assert.equal(region.top[0].count, 400);
  const date = result.profiles.find((item) => item.column === 'Дата');
  assert.equal(date.kind, 'дата');
  const text = formatAnalysis(result);
  assert.match(text, /колонка \| тип/);
  assert.match(text, /Выручка \| число/);
});

test('query: фильтр + группировка + метрики + сортировка', async () => {
  const result = await analyzeData({
    filePath: file('sales.csv'),
    mode: 'query',
    filters: [{ column: 'Регион', op: 'in', value: ['Москва', 'Казань'] }],
    groupBy: ['Регион'],
    metrics: [
      { agg: 'count' },
      { agg: 'sum', column: 'Выручка', as: 'Выручка' },
      { agg: 'avg', column: 'Выручка', as: 'Средний чек' },
      { agg: 'countDistinct', column: 'Менеджер', as: 'Менеджеров' },
      { agg: 'median', column: 'Выручка', as: 'Медиана' },
    ],
    sort: { column: 'Выручка', desc: true },
    limit: 10,
  });
  assert.equal(result.matched, 800);
  assert.equal(result.totalGroups, 2);
  assert.deepEqual(result.columns, ['Регион', 'count', 'Выручка', 'Средний чек', 'Менеджеров', 'Медиана']);
  assert.equal(result.rows.length, 2);
  assert.ok(result.rows[0].Выручка >= result.rows[1].Выручка, 'отсортировано по убыванию');
  assert.equal(result.rows[0].count, 400);
  assert.equal(result.rows[0].Менеджеров, 2);
  assert.ok(Math.abs(result.rows[0].Выручка / result.rows[0].count - result.rows[0]['Средний чек']) < 0.01, 'среднее согласовано с суммой');
  const text = formatAnalysis(result);
  assert.match(text, /под фильтры попало 800/);
  assert.match(text, /Регион \| count \| Выручка/);
});

test('query: группировка по кварталу и фильтр по числу', async () => {
  const result = await analyzeData({
    filePath: file('sales.csv'),
    mode: 'query',
    filters: [{ column: 'Выручка', op: 'gte', value: 1200 }],
    groupBy: [{ column: 'Дата', part: 'quarter', as: 'Квартал' }],
    metrics: [{ agg: 'count' }, { agg: 'max', column: 'Выручка' }],
    limit: 10,
  });
  assert.deepEqual(result.rows.map((row) => row.Квартал), ['2025-Q1', '2025-Q2', '2025-Q3', '2025-Q4']);
  assert.ok(result.matched > 0 && result.matched < 1200);
  for (const row of result.rows) assert.ok(row['max_Выручка'] >= 1200);
});

test('query: limit и truncated, пустой результат не ломает вывод', async () => {
  const result = await analyzeData({
    filePath: file('sales.csv'),
    mode: 'query',
    groupBy: ['Регион', 'Менеджер'],
    metrics: [{ agg: 'count' }],
    limit: 2,
  });
  assert.equal(result.rows.length, 2);
  assert.equal(result.totalGroups, 6);
  assert.equal(result.truncated, true);
  const empty = await analyzeData({
    filePath: file('sales.csv'),
    mode: 'query',
    filters: [{ column: 'Регион', op: 'eq', value: 'Владивосток' }],
    metrics: [{ agg: 'count' }],
  });
  assert.equal(empty.matched, 0);
  assert.match(formatAnalysis(empty), /пусто/);
});

test('XLSX: листы, выбор листа, числа и даты из книги', async () => {
  const ExcelJS = (await import('exceljs')).default;
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Продажи');
  sheet.addRow(['Дата', 'Менеджер', 'Выручка']);
  /* Локальная полночь, а не UTC: Excel хранит дату без часового пояса, и
     Date.UTC в поясе UTC+3 уезжает на предыдущий день — тогда месяцев в
     группировке становится 11 вместо 10. */
  for (let i = 0; i < 300; i++) {
    sheet.addRow([new Date(2025, 0, 1 + i), managers[i % 2], 1000 + i]);
  }
  sheet.addRow(['Итого', null, { formula: 'SUM(C2:C301)', result: 343950 }]);
  const reference = workbook.addWorksheet('Справочник');
  reference.addRow(['Код', 'Название']);
  reference.addRow([1, 'Тест']);
  await workbook.xlsx.writeFile(file('book.xlsx'));

  const sheets = await analyzeData({ filePath: file('book.xlsx'), mode: 'sheets' });
  assert.deepEqual(sheets.sheets.map((item) => item.name), ['Продажи', 'Справочник']);
  assert.deepEqual(sheets.sheets[0].header, ['Дата', 'Менеджер', 'Выручка']);

  const profile = await analyzeData({ filePath: file('book.xlsx'), mode: 'profile' });
  assert.equal(profile.scanned, 301);
  assert.equal(profile.profiles.find((item) => item.column === 'Менеджер').distinct, 2);

  const second = await analyzeData({ filePath: file('book.xlsx'), mode: 'profile', sheet: 'Справочник' });
  assert.equal(second.scanned, 1);
  assert.deepEqual(second.profiles.map((item) => item.column), ['Код', 'Название']);

  const query = await analyzeData({
    filePath: file('book.xlsx'),
    mode: 'query',
    sheet: 'Продажи',
    // строка «Итого» без менеджера — отсекаем её фильтром
    filters: [{ column: 'Менеджер', op: 'notEmpty' }],
    groupBy: [{ column: 'Дата', part: 'month', as: 'Месяц' }],
    metrics: [{ agg: 'sum', column: 'Выручка', as: 'Выручка' }],
    limit: 24,
  });
  assert.equal(query.rows.length, 10);
  assert.match(formatAnalysis(query), /Месяц \| Выручка/);
});

test('ошибки: нет колонки, неизвестный режим, нет листа, неподдерживаемый файл', async () => {
  await assert.rejects(
    () => analyzeData({ filePath: file('sales.csv'), mode: 'query', groupBy: ['Нет такой'] }),
    /Нет колонки «Нет такой»/,
  );
  await assert.rejects(
    () => analyzeData({ filePath: file('sales.csv'), mode: 'pivot' }),
    /Неизвестный режим/,
  );
  await assert.rejects(
    () => analyzeData({ filePath: file('book.xlsx'), mode: 'profile', sheet: 'Нет такого' }),
    /Лист «Нет такого» не найден/,
  );
  fs.writeFileSync(file('notes.parquet'), 'x');
  await assert.rejects(
    () => analyzeData({ filePath: file('notes.parquet'), mode: 'profile' }),
    /Поддерживаются \.csv и \.xlsx/,
  );
  await assert.rejects(
    () => analyzeData({ filePath: file('sales.csv'), mode: 'query', filters: [{ column: 'Регион', op: 'like', value: 'Мос' }] }),
    /Неизвестное условие/,
  );
});

test('инструмент analyze_data доступен модели и отдаёт отчёт', async () => {
  const { TOOL_DEFS, TOOL_LABELS, toolSummary } = await import('../src/tools.mjs');
  const def = TOOL_DEFS.find((item) => item.function.name === 'analyze_data');
  assert.ok(def, 'analyze_data есть в TOOL_DEFS');
  assert.match(def.function.description, /profile/);
  assert.equal(TOOL_LABELS.analyze_data, 'Анализ данных');
  assert.equal(toolSummary('analyze_data', { path: 'sales.csv', mode: 'query' }), 'sales.csv · query');

  const profile = await executeTool('analyze_data', { path: 'sales.csv', mode: 'profile' }, ctx);
  assert.match(profile.text, /Профиль «sales\.csv»: строк 1200/);
  assert.equal(profile.meta.rows, 1200);

  const query = await executeTool(
    'analyze_data',
    { path: 'sales.csv', mode: 'query', groupBy: ['Регион'], metrics: [{ agg: 'count' }, { agg: 'sum', column: 'Выручка' }], sort: { column: 'count', desc: true } },
    ctx,
  );
  assert.match(query.text, /групп 3/);
  assert.equal(query.meta.mode, 'query');
  await assert.rejects(() => executeTool('analyze_data', { path: '../secret.csv' }, ctx), /за пределы/);
});

test('большой CSV: 120 000 строк читаются потоком и считаются точно', async () => {
  const big = file('big.csv');
  const stream = fs.createWriteStream(big);
  stream.write('id;group;amount\n');
  for (let i = 0; i < 120000; i++) {
    stream.write(`${i};g${i % 10};${(i % 1000) / 10}\n`);
  }
  await new Promise((resolve, reject) => {
    stream.end(resolve);
    stream.on('error', reject);
  });
  const started = Date.now();
  const result = await analyzeData({
    filePath: big,
    mode: 'query',
    groupBy: ['group'],
    metrics: [{ agg: 'count' }, { agg: 'sum', column: 'amount' }],
    sort: { column: 'group', desc: false },
    limit: 20,
  });
  const elapsed = Date.now() - started;
  assert.equal(result.scanned, 120000);
  assert.equal(result.matched, 120000);
  assert.equal(result.rows.length, 10);
  assert.equal(result.rows.reduce((sum, row) => sum + row.count, 0), 120000);
  assert.ok(elapsed < 20000, `120k строк за ${elapsed} мс`);
  fs.rmSync(big, { force: true });
});

let failed = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    console.log(`ok — ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL — ${name}`);
    console.error(`   ${error?.message || error}`);
  }
}
fs.rmSync(tmpRoot, { recursive: true, force: true });
console.log(failed ? `\n${failed} из ${tests.length} тестов не прошли` : `\nвсе ${tests.length} тестов прошли`);
process.exit(failed ? 1 : 0);
