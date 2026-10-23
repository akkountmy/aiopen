/**
 * Проверка страницы: инструмент остаётся доступным всегда, без браузера работает
 * по коду, с браузером — открывает страницу на 390/768/1440 px и оставляет снимки.
 *
 * Запуск: node test/browser.mjs
 * С Chromium (Docker-образ): PLAYWRIGHT=1 node test/browser.mjs — тогда вдобавок
 * открывается живая страница на локальном сервере.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-browser-'));
process.env.DSH_DATA_DIR = tmpRoot;

const { TOOL_DEFS, availableToolDefs, executeTool } = await import('../src/tools.mjs');
const { checkPage, describePage, normalizeWidths, browserAvailable } = await import('../src/browser.mjs');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const ctx = { workspace: path.join(tmpRoot, 'project') };
fs.mkdirSync(ctx.workspace, { recursive: true });

const hasBrowser = await browserAvailable();

const page = `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Проверка</title></head>
<body><h1>Привет</h1><p>Текст</p>
<div style="width:1200px">Широкий блок</div>
<img src="нет.png">
<script>console.error('нарочно');</script>
</body></html>`;

test('описание check_page: набор ширин по умолчанию и снимок в проект', () => {
  const tool = TOOL_DEFS.find((item) => item.function.name === 'check_page');
  assert.ok(tool, 'нет описания check_page');
  assert.deepEqual(tool.function.parameters.required, ['url']);
  for (const key of ['widths', 'width', 'height', 'full_page', 'screenshot', 'wait_ms', 'timeout_ms']) {
    assert.ok(tool.function.parameters.properties[key], `нет поля ${key}`);
  }
  assert.match(tool.function.description, /390\/768\/1440/);
});

test('описание page_template есть в общем списке', () => {
  const tool = TOOL_DEFS.find((item) => item.function.name === 'page_template');
  assert.ok(tool, 'нет описания page_template');
  assert.deepEqual(tool.function.parameters.properties || {}, {});
});

test('check_page и page_template не исчезают из набора без браузера', async () => {
  const names = (await availableToolDefs()).map((item) => item.function.name);
  assert.ok(names.includes('check_page'), 'проверка страницы должна быть всегда');
  assert.ok(names.includes('page_template'), 'шаблон страницы должен быть всегда');
});

test('page_template отдаёт готовый каркас с h1 и плашкой ошибок', async () => {
  const result = await executeTool('page_template', {}, ctx);
  assert.match(result.text, /<!doctype html>/i);
  assert.match(result.text, /<h1>/);
  assert.match(result.text, /addEventListener\('error'/);
  assert.doesNotMatch(result.text, /https?:\/\//, 'в каркасе не должно быть внешних адресов');
});

test('ширины: по умолчанию 390, 768 и 1440, явные значения сохраняются', () => {
  assert.deepEqual(normalizeWidths(undefined), [390, 768, 1440]);
  assert.deepEqual(normalizeWidths(''), [390, 768, 1440]);
  assert.deepEqual(normalizeWidths('768, 390'), [390, 768]);
  assert.deepEqual(normalizeWidths('9000, 100'), [390, 768, 1440], 'мусор заменяется набором по умолчанию');
});

test('файл вне проекта не открывается', async () => {
  await assert.rejects(() => checkPage('../../etc/passwd', { root: ctx.workspace }), /внутри проекта/);
  await assert.rejects(() => checkPage('/etc/hosts', { root: ctx.workspace }), /внутри проекта/);
});

test('ссылка file:// отклоняется: только путь или http(s)', async () => {
  await assert.rejects(() => checkPage('file:///etc/passwd', { root: ctx.workspace }), /файл путём внутри проекта/);
});

test('без браузера файл проверяется по коду, а не падает', async () => {
  const file = path.join(ctx.workspace, 'Страница.html');
  fs.writeFileSync(file, page, 'utf8');
  const result = await checkPage('Страница.html', { root: ctx.workspace });
  if (hasBrowser) {
    assert.equal(result.mode, 'browser');
    return;
  }
  assert.equal(result.mode, 'static');
  assert.equal(result.static.h1, 'Привет');
  const text = describePage(result);
  assert.match(text, /Режим: по коду/);
  assert.match(text, /нужен браузер/);
});

test('адрес в интернете без браузера объясняет причину', async () => {
  if (hasBrowser) return;
  await assert.rejects(() => checkPage('https://example.com', { root: ctx.workspace }), /Без браузера/);
});

test('разбор результата: итоги по коду и замечания', () => {
  const text = describePage({
    mode: 'static',
    local: true,
    url: 'file:///tmp/index.html',
    requested: 'file:///tmp/index.html',
    title: 'Лендинг',
    widths: [390, 768, 1440],
    variants: [],
    static: {
      h1: '',
      chars: 120,
      title: 'Лендинг',
      lang: 'ru',
      doctype: true,
      charset: true,
      viewport: true,
      headings: [],
      images: { total: 1, withoutAlt: 1, examples: ['нет.png'] },
      external: ['https://cdn.example.com/a.js'],
      externalCount: 1,
      missingLocal: ['нет.png — файла нет в проекте'],
      fixedWidths: ['.hero — width: 1200px без max-width'],
      unclosedTags: ['div'],
      mismatchedTags: [],
      quoteIssues: [],
      hasErrorPlaque: false,
    },
  });
  assert.match(text, /«Лендинг»/);
  assert.match(text, /h1 отсутствует/);
  assert.match(text, /картинки без alt/);
  assert.match(text, /внешние запросы/);
  assert.match(text, /width: 1200px/);
  assert.match(text, /нужен браузер/);
});

test('живая страница: три ширины, снимки и машинный отчёт', async () => {
  if (!hasBrowser) {
    assert.ok(true);
    return;
  }
  const http = await import('node:http');
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(page);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  process.env.DSHOW_ALLOW_PRIVATE_FETCH = '1';
  try {
    const result = await checkPage(`http://127.0.0.1:${port}/`, { root: ctx.workspace });
    assert.equal(result.mode, 'browser');
    assert.deepEqual(result.widths, [390, 768, 1440]);
    assert.equal(result.variants.length, 3);
    for (const variant of result.variants) {
      assert.ok(fs.existsSync(path.join(ctx.workspace, variant.screenshot)), `нет снимка ${variant.screenshot}`);
    }
    const phone = result.variants[0];
    assert.equal(phone.overflow, true, 'широкий блок должен дать прокрутку на 390 px');
    assert.ok(phone.consoleErrors.length >= 1, 'console.error должен попасть в отчёт');
    assert.equal(phone.imagesWithoutAlt.length, 1, 'картинка без alt должна найтись');
    assert.match(decodeURIComponent(phone.imagesWithoutAlt[0]), /нет\.png$/, 'в отчёте должен быть адрес картинки');
    const wide = result.variants[2];
    assert.equal(wide.overflow, false, 'на 1440 px прокрутки быть не должно');
    const text = describePage(result);
    assert.match(text, /Снимки: screens\/page-390\.png, screens\/page-768\.png, screens\/page-1440\.png/);
    assert.match(text, /горизонтальная прокрутка на 390 px/);
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
