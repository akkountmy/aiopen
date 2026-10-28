/* Проверка панели администратора: время напоминания об уведомлениях.
   Настоящий Chrome, настоящий сервер во временной папке данных.

   Запуск: node test/notify-schedule-ui.mjs */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.DSHOW_TEST_PORT || 3293);
const BASE = `http://127.0.0.1:${PORT}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshow-notify-schedule-ui-'));

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
  DSHOW_OPEN_SIGNUP: '1',
  DSHOW_SIGNUP_PER_HOUR: '20',
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
let crashed = false;
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
  await page.waitForSelector('.notify-schedule-block', { timeout: 15000 });
  /* Даём запросу расписания завершиться: select заполняется ответом сервера. */
  await page.waitForTimeout(400);
}

async function schedule(page) {
  return page.evaluate(async () => {
    const response = await fetch('/api/admin/notify-schedule');
    return response.json();
  });
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
    page.on('pageerror', (error) => console.log('PAGEERROR', error.message));
    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => Boolean(document.querySelector('#app')), null, { timeout: 15000 });
    await openAdmin(page);

    const section = page.locator('.notify-schedule-block');
    check('в панели есть блок времени напоминания', (await section.count()) === 1);
    check(
      'блок подписан понятно',
      (await section.innerText()).toLowerCase().includes('время напоминания об уведомлениях'),
    );
    const options = await page.locator('.notify-schedule-form select option').allTextContents();
    check(
      'три режима: сразу, через минуты, в заданное время',
      options.length === 3 && options[0].includes('Сразу') && options[1].includes('минут') && options[2].includes('Минск'),
      options.join(' | '),
    );
    check(
      'по умолчанию выбран режим «сразу»',
      (await page.locator('.notify-schedule-form select').inputValue()) === 'immediate',
    );

    await page.locator('.notify-schedule-form select').selectOption('time');
    await page.locator('.notify-schedule-form input[type="time"]').fill('10:30');
    await page.locator('.notify-schedule-form button[type="submit"]').click();
    await page.waitForSelector('.toast.ok', { timeout: 8000 });
    const saved = await schedule(page);
    check(
      'время сохраняется на сервере',
      saved.mode === 'time' && saved.time === '10:30',
      `${saved.mode} ${saved.time}`,
    );
    check(
      'панель показывает ближайшее окно',
      (await page.locator('.notify-schedule-preview').innerText()).includes('Следующее окно'),
    );

    await page.reload({ waitUntil: 'domcontentloaded' });
    await openAdmin(page);
    check(
      'после перезагрузки режим сохранился',
      (await page.locator('.notify-schedule-form select').inputValue()) === 'time' &&
        (await page.locator('.notify-schedule-form input[type="time"]').inputValue()) === '10:30',
    );

    await page.locator('.notify-schedule-form select').selectOption('delay');
    await page.locator('.notify-schedule-form input[type="number"]').fill('45');
    await page.locator('.notify-schedule-form button[type="submit"]').click();
    await page.waitForTimeout(600);
    const delayed = await schedule(page);
    check('задержка 45 минут сохраняется', delayed.mode === 'delay' && delayed.delayMinutes === 45);
    check(
      'в режиме задержки видно ближайшее окно',
      (await page.locator('.notify-schedule-preview').innerText()).includes('Следующее окно'),
    );

    const mobile = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    await mobile.request.post(`${BASE}/api/login`, {
      data: { username: 'tester', password: 'Test12345' },
    });
    const mobilePage = await mobile.newPage();
    await mobilePage.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
    await mobilePage.waitForFunction(() => Boolean(document.querySelector('#app')), null, { timeout: 15000 });
    await openAdmin(mobilePage);
    const metrics = await mobilePage.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
      blockBottom: document.querySelector('.notify-schedule-block').getBoundingClientRect().bottom,
      viewport: window.innerHeight,
    }));
    check('на телефоне нет горизонтальной прокрутки', metrics.scrollWidth <= metrics.innerWidth, `${metrics.scrollWidth} ≤ ${metrics.innerWidth}`);
    check(
      'поля и кнопка сохранения помещаются по ширине',
      await mobilePage.evaluate(() => {
        const form = document.querySelector('.notify-schedule-form');
        const save = form?.querySelector('button[type="submit"]');
        if (!form || !save) return false;
        const box = save.getBoundingClientRect();
        return box.width > 0 && box.right <= window.innerWidth + 1;
      }),
    );
    await mobile.close();
    await context.close();
  } finally {
    await browser.close();
  }
}

try {
  await main();
} catch (error) {
  crashed = true;
  console.error(error);
  console.error(serverLog);
  process.exitCode = 1;
} finally {
  server.kill();
  await sleep(150);
  fs.rmSync(dataDir, { recursive: true, force: true });
}

if (failures || crashed) {
  console.log(`\n${failures} проверок не прошло`);
  process.exitCode = 1;
} else {
  console.log('\nВсе проверки панели расписания прошли');
}
