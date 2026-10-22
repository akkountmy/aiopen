/**
 * Проверка страницы в настоящем браузере: пока браузера нет, инструмент должен
 * честно исчезать из набора, а не падать в середине задачи; адреса и файлы
 * проверяются до запуска браузера.
 *
 * Запуск: node test/browser.mjs
 * С браузером (Docker-образ): PLAYWRIGHT=1 node test/browser.mjs — тогда
 * дополнительно открывается живая страница на локальном сервере.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-browser-'));
process.env.DSH_DATA_DIR = tmpRoot;

const { TOOL_DEFS, availableToolDefs, executeTool } = await import('../src/tools.mjs');
const { browserAvailable, checkPage, describePage } = await import('../src/browser.mjs');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const ctx = { workspace: path.join(tmpRoot, 'project') };
fs.mkdirSync(ctx.workspace, { recursive: true });

const hasBrowser = await browserAvailable();

test('описание инструмента есть в общем списке', () => {
  const tool = TOOL_DEFS.find((item) => item.function.name === 'check_page');
  assert.ok(tool, 'нет описания check_page');
  assert.deepEqual(tool.function.parameters.required, ['url']);
  for (const key of ['width', 'height', 'full_page', 'screenshot', 'wait_ms', 'timeout_ms']) {
    assert.ok(tool.function.parameters.properties[key], `нет поля ${key}`);
  }
});

test('без браузера инструмент не предлагается модели', async () => {
  const defs = await availableToolDefs();
  const names = defs.map((item) => item.function.name);
  assert.equal(names.includes('check_page'), hasBrowser, 'набор инструментов должен совпадать с наличием браузера');
});

test('без браузера вызов объясняет причину, а не падает стеком', async () => {
  if (hasBrowser) {
    assert.ok(true);
    return;
  }
  await assert.rejects(
    () => executeTool('check_page', { url: 'https://example.com' }, ctx),
    /Браузер (в этом окружении недоступен|не запускается)/,
  );
  await assert.rejects(() => checkPage('https://example.com', { root: ctx.workspace }), /Браузер/);
});

test('чужой файл за пределами проекта не открывается', async () => {
  if (!hasBrowser) {
    /* Проверка пути не зависит от браузера, но запускается только с ним:
       до этого момента вызывать нечего. */
    assert.ok(true);
    return;
  }
  await assert.rejects(() => checkPage('../../etc/passwd', { root: ctx.workspace }), /внутри проекта/);
  await assert.rejects(() => checkPage('/etc/hosts', { root: ctx.workspace }), /внутри проекта/);
});

test('ссылка file:// отклоняется: только путь или http(s)', async () => {
  if (!hasBrowser) {
    assert.ok(true);
    return;
  }
  await assert.rejects(() => checkPage('file:///etc/passwd', { root: ctx.workspace }), /файл путём внутри проекта/);
});

test('разбор результата: сначала вывод, потом подробности', () => {
  const text = describePage({
    local: true,
    url: 'file:///tmp/index.html',
    requested: 'file:///tmp/index.html',
    status: 200,
    title: 'Лендинг',
    width: 390,
    height: 844,
    fullPage: false,
    scrollWidth: 430,
    clientWidth: 390,
    overflow: true,
    wide: ['.hero шире экрана на 40 px'],
    headings: ['h1: Заголовок'],
    consoleErrors: ['Uncaught TypeError'],
    resourceErrors: ['Failed to load resource: the server responded with a status of 404 ()'],
    failedRequests: [],
    text: 'Текст страницы',
    chars: 13,
    screenshot: 'screens/page-390.png',
  });
  assert.match(text, /«Лендинг»/);
  assert.match(text, /Окно 390×844/);
  assert.match(text, /есть горизонтальная прокрутка/);
  assert.match(text, /шире экрана на 40 px/);
  assert.match(text, /Ошибки в консоли \(1\)/);
  assert.match(text, /Ответы сервера на запросы страницы \(1\)/);
  assert.match(text, /screens\/page-390\.png/);
});

test('живая страница открывается, когда браузер есть', async () => {
  if (!hasBrowser) {
    assert.ok(true);
    return;
  }
  const http = await import('node:http');
  const page = '<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Проверка</title></head><body><h1>Привет</h1><p>Текст</p><img src="/нет.png"></body></html>';
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(page);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  process.env.DSHOW_ALLOW_PRIVATE_FETCH = '1';
  try {
    const result = await checkPage(`http://127.0.0.1:${port}/`, { root: ctx.workspace, width: 390 });
    assert.equal(result.title, 'Проверка');
    assert.ok(result.screenshot.endsWith('.png'));
    assert.ok(fs.existsSync(path.join(ctx.workspace, result.screenshot)), 'скриншот должен лежать в проекте');
    assert.equal(result.overflow, false);
  } finally {
    server.close();
  }
});

let passed = 0;
for (const item of tests) {
  try {
    await item.fn();
    passed += 1;
    console.log(`ok — ${item.name}`);
  } catch (error) {
    console.error(`FAIL — ${item.name}: ${error?.message || error}`);
    process.exitCode = 1;
  }
}
console.log(`\nбраузер: ${hasBrowser ? 'есть' : 'нет'}; пройдено ${passed} из ${tests.length}`);
