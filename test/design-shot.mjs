/**
 * Визуализация: PNG снимает тот же движок, что и проверка страниц.
 *
 * Проверяем две ступени:
 *   1) обычный запуск — Playwright Chromium (у разработчика);
 *   2) принудительно puppeteer + системный Chrome — так в облаке работает
 *      @sparticuz/chromium, которого нет в локальном кэше Playwright.
 *
 * Сцена ставит data-ready сама, как настоящий scene.mjs. Если ожидание
 * готовности сломается, тест увидит ready=false, даже когда PNG получился.
 *
 * Запуск: node test/design-shot.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const shot = path.join(root, 'skills', 'interior-drawings', 'scripts', 'shot.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-design-shot-'));
const html = path.join(tmp, 'scene.html');
const png = path.join(tmp, 'render.png');

fs.writeFileSync(
  html,
  `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Сцена</title>
<style>html,body{margin:0;height:100%;background:#17202b}canvas{display:block;width:100%;height:100%}</style>
</head><body><canvas id="view" width="800" height="600"></canvas>
<script>
const canvas = document.getElementById('view');
const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
if (gl) {
  gl.clearColor(0.78, 0.16, 0.12, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
}
requestAnimationFrame(function () {
  requestAnimationFrame(function () {
    document.body.dataset.ready = '1';
    window.__designReady = true;
    document.title = 'DESIGN_OK';
  });
});
</script></body></html>`,
  'utf8',
);

const systemChrome = [
  path.join(process.env.PROGRAMFILES || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  path.join(process.env['PROGRAMFILES(X86)'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  path.join(process.env.PROGRAMFILES || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  path.join(process.env['PROGRAMFILES(X86)'] || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].find((item) => item && fs.existsSync(item));

function cleanEnv() {
  const env = { ...process.env };
  for (const key of [
    'DSHOW_BROWSER',
    'DSHOW_BROWSER_DRIVER',
    'DSHOW_CHROME_PATH',
    'DSHOW_NO_BROWSER',
    'DSHOW_SHOT_DEBUG',
    'PLAYWRIGHT_BROWSERS_PATH',
  ]) {
    delete env[key];
  }
  return env;
}

function runShot(envAdd, out = png) {
  fs.rmSync(out, { force: true });
  const result = spawnSync(
    process.execPath,
    [shot, html, out, '--width', '800', '--height', '600', '--dpi', '1'],
    { cwd: root, env: { ...cleanEnv(), ...envAdd }, encoding: 'utf8', timeout: 120000 },
  );
  const text = `${result.stdout || ''}\n${result.stderr || ''}`;
  const start = text.lastIndexOf('{');
  const end = text.lastIndexOf('}');
  let data = null;
  if (start >= 0 && end > start) {
    try {
      data = JSON.parse(text.slice(start, end + 1));
    } catch {
      /* ниже покажем хвост вывода */
    }
  }
  assert.equal(result.status, 0, `shot.mjs упал (${result.status}): ${text.slice(-900)}`);
  assert.ok(data, `shot.mjs не напечатал JSON: ${text.slice(-900)}`);
  assert.ok(fs.existsSync(out), 'PNG не появился');
  const bytes = fs.readFileSync(out);
  assert.equal(bytes.subarray(1, 4).toString('latin1'), 'PNG', 'на выходе не PNG');
  assert.equal(bytes.readUInt32BE(16), 800, 'ширина PNG не совпала');
  assert.equal(bytes.readUInt32BE(20), 600, 'высота PNG не совпала');
  assert.ok(bytes.length > 2000, `PNG слишком маленький: ${bytes.length} байт`);
  return data;
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('локальный Playwright: кадр и data-ready', () => {
  const data = runShot({});
  assert.equal(data.ready, true, `готовность сцены не дождались: ${JSON.stringify(data.errors)}`);
  assert.match(String(data.engine || ''), /Playwright|Chrome|Chromium/i);
});

test('puppeteer + системный Chrome: путь облачной сборки', () => {
  if (!systemChrome) {
    console.log('   (пропущено: системного Chrome/Edge на машине нет)');
    return;
  }
  const empty = path.join(tmp, 'no-playwright');
  fs.mkdirSync(empty, { recursive: true });
  const data = runShot(
    {
      DSHOW_BROWSER_DRIVER: 'puppeteer',
      DSHOW_CHROME_PATH: systemChrome,
      PLAYWRIGHT_BROWSERS_PATH: empty,
    },
    path.join(tmp, 'render-puppeteer.png'),
  );
  assert.equal(data.ready, true, `готовность сцены не дождались: ${JSON.stringify(data.errors)}`);
  assert.match(String(data.engine || ''), /DSHOW_CHROME_PATH/);
  assert.deepEqual(data.errors, [], 'на исправном пути не должно быть ошибок');
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
console.log(`\nвизуализация: пройдено ${passed} из ${tests.length}`);
fs.rmSync(tmp, { recursive: true, force: true });
