/* Панель администратора: рассылка уведомлений на выбранные дату и время.
   Настоящий Chrome и настоящий сервер во временной папке данных.

   Запуск: node test/push-schedule-ui.mjs */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.DSHOW_TEST_PORT || 3295);
const BASE = `http://127.0.0.1:${PORT}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshow-push-schedule-ui-'));

const CHROME_CANDIDATES = [
  path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
];
const CHROME = CHROME_CANDIDATES.find((candidate) => fs.existsSync(candidate));
if (!CHROME) {
  console.log('  --  Chrome/Edge не найден, проверка панели пропущена');
  process.exit(0);
}

const env = {
  ...process.env,
  DSHOW_HOST: '127.0.0.1',
  DSHOW_PORT: String(PORT),
  DSHOW_DATA_DIR: dataDir,
  DSHOW_ADMIN_USER: 'tester',
  DSHOW_ADMIN_PASSWORD: 'Test12345',
  DSHOW_OPEN_SIGNUP: '0',
  DSHOW_PUSH_SCHEDULE: '0',
  DSHOW_TG_TOKEN: '',
  DSHOW_TG_CHAT: '',
  DSHOW_DEEPSEEK_KEY: '',
  OPENROUTER_API_KEY: '',
};

const server = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], {
  cwd: ROOT,
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (chunk) => { serverLog += chunk.toString(); });
server.stderr.on('data', (chunk) => { serverLog += chunk.toString(); });

let failures = 0;
function check(label, ok, detail = '') {
  if (ok) {
    console.log(`  ok  ${label}${detail ? ` — ${detail}` : ''}`);
    return;
  }
  failures += 1;
  console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitReady() {
  for (let i = 0; i < 100; i += 1) {
    try {
      const response = await fetch(`${BASE}/api/health`);
      if (response.ok) return true;
    } catch {
      /* сервер ещё поднимается */
    }
    await sleep(100);
  }
  return false;
}

async function openAdmin(page) {
  await page.locator('#userChip').click();
  await page.locator('.menu button', { hasText: 'Пользователи' }).click();
  await page.waitForSelector('.push-broadcast', { timeout: 15000 });
  await page.waitForTimeout(400);
}

async function main() {
  if (!(await waitReady())) {
    console.error('Сервер не поднялся');
    console.error(serverLog);
    process.exitCode = 1;
    return;
  }

  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const login = await context.request.post(`${BASE}/api/login`, {
      data: { username: 'tester', password: 'Test12345' },
    });
    check('вход администратора', login.status() === 200, `HTTP ${login.status()}`);

    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => Boolean(document.querySelector('#app')), null, { timeout: 15000 });
    await openAdmin(page);

    const whenField = page.locator('.push-when-field');
    check('в форме есть выбор «Когда отправить»', (await whenField.count()) === 1);
    const whenSelect = whenField.locator('select');
    check('по умолчанию — сразу', (await whenSelect.inputValue()) === 'now');
    const whenRow = page.locator('.push-when-row');
    check('поля даты и времени сначала скрыты', !(await whenRow.isVisible()));

    await whenSelect.selectOption('later');
    check('поля даты и времени появились', await whenRow.isVisible());
    check('есть поле даты', (await page.locator('.push-when-row input[type="date"]').count()) === 1);
    check('есть поле времени', (await page.locator('.push-when-row input[type="time"]').count()) === 1);
    const preview = await page.locator('.push-when-preview').innerText();
    check('подпись говорит о Минске', /Минск/i.test(preview), preview);
    const buttonCaption = await page.locator('.push-actions .btn-primary').innerText();
    check('кнопка стала «Запланировать»', /Запланировать/.test(buttonCaption), buttonCaption);

    const title = `Проверка расписания ${Date.now().toString(36)}`;
    await page.locator('.push-form .field input').first().fill(title);
    await page.locator('.push-form textarea').fill('Сообщение должно уйти в выбранное время.');
    await page.locator('.push-actions .btn-primary').click();
    await page.waitForFunction(
      (expected) => [...document.querySelectorAll('.push-schedule-name')].some((node) => node.textContent === expected),
      title,
      { timeout: 10000 },
    );
    check('запланированная появилась в списке', true);
    const row = page.locator('.push-schedule-row', { hasText: title });
    const rowText = await row.innerText();
    check('статус «запланирована»', /запланирована/.test(rowText), rowText);
    check('видно время по Минску', /На .+ в \d{2}:\d{2}/.test(rowText), rowText);

    await row.locator('.push-schedule-cancel').click();
    await page.waitForSelector('.modal-foot', { timeout: 5000 });
    await page.locator('.modal-foot button', { hasText: 'Отменить рассылку' }).click();
    await page.waitForFunction(
      (expected) => {
        const node = [...document.querySelectorAll('.push-schedule-row')].find((entry) =>
          entry.textContent.includes(expected),
        );
        return node && /отменена/.test(node.textContent);
      },
      title,
      { timeout: 10000 },
    );
    check('после отмены статус «отменена»', true);
    check('ошибок JavaScript нет', pageErrors.length === 0, pageErrors.join(' | '));

    /* На узком экране форма не должна разъезжаться по горизонтали. */
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(250);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check('на телефоне нет горизонтальной прокрутки', overflow <= 1, `${overflow}px`);
  } finally {
    await browser.close();
  }
}

try {
  await main();
} finally {
  server.kill();
  await sleep(150);
  fs.rmSync(dataDir, { recursive: true, force: true });
  console.log(`\n${failures ? `ПРОВАЛОВ: ${failures}` : 'Все проверки пройдены'}`);
  if (failures) process.exitCode = 1;
}
