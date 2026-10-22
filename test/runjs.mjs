/**
 * Тесты вычислительного слоя run_js: песочница без Python, разбор CSV,
 * файловые хелперы, защита от выхода за проект и от зависания.
 * Запуск: node test/runjs.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-runjs-'));
process.env.DSH_DATA_DIR = tmpRoot;

const { runJavascript } = await import('../src/jsruntime.mjs');
const { executeTool, TOOL_DEFS } = await import('../src/tools.mjs');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const workspace = path.join(tmpRoot, 'project');
fs.mkdirSync(workspace, { recursive: true });
const run = (code, options = {}) => runJavascript({ code, root: workspace, ...options });

test('инструмент run_js объявлен для модели', () => {
  const def = TOOL_DEFS.find((tool) => tool.function.name === 'run_js');
  assert.ok(def, 'run_js отсутствует в TOOL_DEFS');
  assert.ok(def.function.parameters.required.includes('code'));
});

test('считает, печатает и возвращает значение', async () => {
  const result = await run('print("выручка", 1200 * 1.2); return round(1440 / 3, 2);');
  assert.equal(result.output, 'выручка 1440');
  assert.equal(result.value, '480');
});

test('агрегаты и медиана считаются без библиотек', async () => {
  const result = await run(
    ['var rows = [3, 9, 1, 7, 5];', 'print(sum(rows), avg(rows), median(rows), min(rows), max(rows), pct(rows, 90), round(stdev(rows), 2));'].join('\n'),
  );
  assert.equal(result.output, '25 5 5 1 9 9 3.16');
});

test('разбирает CSV с кавычками и русским разделителем', async () => {
  fs.writeFileSync(
    path.join(workspace, 'sales.csv'),
    'Дата;Регион;Выручка\n01.01.2025;Москва;"1 200,50"\n02.01.2025;Казань;"800,25"\n01.01.2025;Москва;"100,00"\n',
    'utf8',
  );
  const result = await run(
    [
      'var rows = parseCsv(read("sales.csv"));',
      'var byRegion = {};',
      'Object.keys(groupBy(rows, "Регион")).forEach(function (name) {',
      '  var list = groupBy(rows, "Регион")[name];',
      '  byRegion[name] = list.length;',
      '});',
      'print(rows.length, JSON.stringify(byRegion));',
      'var out = Object.keys(byRegion).map(function (name) { return { region: name, deals: byRegion[name] }; });',
      'write("summary.csv", toCsv(out));',
    ].join('\n'),
  );
  assert.equal(result.output, '3 {"Москва":2,"Казань":1}');
  assert.deepEqual(result.files, ['summary.csv']);
  const written = fs.readFileSync(path.join(workspace, 'summary.csv'), 'utf8');
  assert.match(written, /^region,deals\nМосква,2\nКазань,1$/);
});

test('файловые хелперы: write, append, read, ls, exists', async () => {
  const result = await run(
    [
      'write("note.md", "# Отчёт");',
      'append("note.md", "\\nстрока");',
      'var entries = ls(".").map(function (item) { return item.name; }).sort();',
      'print(read("note.md").split("\\n").length, exists("note.md"), exists("nope.md"), entries.indexOf("note.md") >= 0);',
    ].join('\n'),
  );
  assert.equal(result.output, '2 true false true');
});

test('вызов инструмента пишет файл и возвращает текст', async () => {
  const executed = await executeTool(
    'run_js',
    { code: 'write("chart-data.json", { points: [1, 2, 3] }); print("готово");' },
    { workspace },
  );
  assert.match(executed.text, /готово/);
  assert.match(executed.text, /chart-data\.json/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(workspace, 'chart-data.json'), 'utf8')), { points: [1, 2, 3] });
});

test('песочница: нет process, require и escape через constructor', async () => {
  const result = await run('print(typeof process, typeof require, typeof fetch, typeof Buffer);');
  assert.equal(result.output, 'undefined undefined undefined undefined');
  /* print — функция самой песочницы: даже её constructor создаёт код внутри
     контекста, поэтому дотянуться до process нельзя. */
  const escaped = await run('print(print.constructor("return typeof process")());');
  assert.equal(escaped.output, 'undefined');
  /* Мост хоста — функции без прототипа: ни constructor, ни call, ни proto. */
  const bridge = await run('print(Object.getPrototypeOf(__read), typeof __read.constructor, typeof __read.call, typeof __read.proto);');
  assert.equal(bridge.output, 'null undefined undefined undefined');
});

test('выход за пределы проекта запрещён', async () => {
  await assert.rejects(run('print(read("../../etc/passwd"));'), /за пределы проекта/);
  await assert.rejects(run('write("C:/Windows/evil.txt", "x");'), /относительно проекта/);
});

test('зависание останавливается по таймауту', async () => {
  await assert.rejects(run('while (true) {}', { timeoutMs: 600 }), /остановлен/);
});

test('ошибка в коде приходит с понятным текстом', async () => {
  await assert.rejects(run('print(missingValue);'), /ReferenceError/);
});

test('вывод выше предела обрезается, но код не падает', async () => {
  const result = await run('for (var i = 0; i < 5000; i++) print("строка " + i);');
  assert.ok(result.output.length <= 22000, `слишком большой вывод: ${result.output.length}`);
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
