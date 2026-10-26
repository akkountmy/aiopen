/**
 * Лестница браузеров: чем именно открывается страница и что видно в /api/health.
 *
 * Каждый сценарий — отдельный процесс, потому что выбор движка запоминается на
 * процесс: переключать переменные окружения на ходу бессмысленно.
 *
 * Запуск: node test/browser-engines.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-engines-'));
const workspace = path.join(tmpRoot, 'project');
fs.mkdirSync(workspace, { recursive: true });
fs.writeFileSync(
  path.join(workspace, 'Страница.html'),
  `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Движок</title></head>
<body><h1>Проверка движка</h1><p>Текст</p><div style="width:1200px">Широкий блок</div></body></html>`,
  'utf8',
);

const browserModule = pathToFileURL(path.resolve('src/browser.mjs')).href;
const probeFile = path.join(tmpRoot, 'probe.mjs');
fs.writeFileSync(
  probeFile,
  `const [moduleUrl, root] = process.argv.slice(2);
const { checkPage, browserStatus } = await import(moduleUrl);
const status = await browserStatus();
const deep = await browserStatus({ probe: true });
const result = await checkPage('Страница.html', { root, widths: '390' });
console.log('@@' + JSON.stringify({
  status,
  deep,
  mode: result.mode,
  engine: result.engine || null,
  reason: result.reason || '',
  shots: (result.variants || []).map((variant) => variant.screenshot),
  widths: result.widths,
}));
`,
  'utf8',
);

/** Проба в чистом процессе: свои переменные окружения, свой выбор движка. */
function runProbe(overrides = {}) {
  const env = { ...process.env };
  for (const key of ['DSHOW_BROWSER', 'DSHOW_BROWSER_DRIVER', 'DSHOW_CHROME_PATH', 'DSHOW_NO_BROWSER', 'DSHOW_BROWSER_MIN_MB', 'DSHOW_BROWSER_QUEUE_MS']) {
    delete env[key];
  }
  const result = spawnSync(process.execPath, [probeFile, browserModule, workspace], {
    env: { ...env, ...overrides },
    encoding: 'utf8',
    timeout: 180000,
  });
  const line = String(result.stdout || '')
    .split(/\r?\n/)
    .filter((item) => item.startsWith('@@'))
    .pop();
  if (!line) {
    throw new Error(`проба не ответила (код ${result.status}): ${String(result.stderr || result.error?.message || '').slice(-700)}`);
  }
  return JSON.parse(line.slice(2));
}

const systemChrome = [
  path.join(process.env.PROGRAMFILES || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  path.join(process.env['PROGRAMFILES(X86)'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  path.join(process.env.PROGRAMFILES || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].find((item) => item && fs.existsSync(item));

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('DSHOW_BROWSER=off: честный разбор по коду и пустой движок в /api/health', () => {
  const probe = runProbe({ DSHOW_BROWSER: 'off' });
  assert.equal(probe.status.engine, null, 'выключенный браузер не должен объявлять движок');
  assert.match(probe.status.reason, /выключен/);
  assert.equal(probe.deep.available, false, 'глубокая проверка здоровья не должна врать');
  assert.equal(probe.mode, 'static');
  assert.match(probe.reason, /выключен/);
  assert.deepEqual(probe.shots, []);
});

test('несуществующий DSHOW_CHROME_PATH объясняется, а не молчит', () => {
  const probe = runProbe({ DSHOW_CHROME_PATH: path.join(tmpRoot, 'нет-такого-chrome.exe') });
  assert.match(probe.status.reason, /DSHOW_CHROME_PATH/);
  assert.equal(probe.deep.available, false);
  assert.equal(probe.mode, 'static');
  assert.match(probe.reason, /DSHOW_CHROME_PATH/);
});

test('битый путь к Chrome: перебор движков и честная причина', () => {
  const fake = path.join(tmpRoot, 'не-браузер.exe');
  fs.writeFileSync(fake, 'это не Chrome', 'utf8');
  const probe = runProbe({ DSHOW_CHROME_PATH: fake });
  assert.equal(probe.deep.available, false);
  assert.match(probe.deep.reason, /не запустился/);
  assert.equal(probe.mode, 'static');
  assert.match(probe.reason, /не запустился/);
});

test('движок по умолчанию: режим отчёта совпадает с доступностью', () => {
  const probe = runProbe();
  if (probe.deep.available === true) {
    assert.equal(probe.mode, 'browser');
    assert.ok(probe.engine, 'у живой проверки должен быть назван движок');
    assert.equal(probe.shots.length, 1);
    assert.equal(probe.shots[0], 'screens/page.png');
  } else {
    assert.equal(probe.mode, 'static');
    assert.ok(probe.deep.reason, 'у недоступного браузера должна быть причина');
  }
});

test('puppeteer + системный Chrome: путь облачной сборки работает', () => {
  if (!systemChrome) {
    console.log('   (пропущено: системного Chrome на машине нет)');
    assert.ok(true);
    return;
  }
  const probe = runProbe({ DSHOW_BROWSER_DRIVER: 'puppeteer', DSHOW_CHROME_PATH: systemChrome });
  assert.equal(probe.deep.engine, 'Chrome по DSHOW_CHROME_PATH');
  assert.equal(probe.deep.available, true);
  assert.equal(probe.mode, 'browser');
  assert.equal(probe.engine, 'Chrome по DSHOW_CHROME_PATH');
  assert.deepEqual(probe.widths, [390]);
  assert.ok(fs.existsSync(path.join(workspace, 'screens', 'page.png')), 'снимок должен появиться в проекте');
});

test('playwright с явным путём тоже поднимается', () => {
  if (!systemChrome) {
    assert.ok(true);
    return;
  }
  const probe = runProbe({ DSHOW_BROWSER_DRIVER: 'playwright', DSHOW_CHROME_PATH: systemChrome });
  if (probe.deep.available !== true) {
    /* Playwright может отказаться от чужой сборки Chrome — это не наша ошибка,
       важно, что отчёт остался честным и не упал. */
    assert.equal(probe.mode, 'static');
    assert.ok(probe.reason);
    return;
  }
  assert.equal(probe.mode, 'browser');
  assert.equal(probe.engine, 'Chrome по DSHOW_CHROME_PATH');
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
console.log(`\nдвижки: пройдено ${passed} из ${tests.length}`);
