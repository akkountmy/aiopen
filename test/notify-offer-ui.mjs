/* Проверка окна «Узнай о новых возможностях DSH Open» в настоящем Chrome.
   Сервер поднимается на свободном порту во временной папке данных, поэтому
   рабочие данные не затрагиваются.

   Что проверяем:
   - после регистрации окно появляется на компьютере и на телефоне;
   - в нём ровно две кнопки «Включить» и «Отложить» и нужная подпись;
   - «Отложить» переносит напоминание на месяц, второе — на три, третье
     выключает его совсем;
   - крестик считается откладыванием;
   - «Включить» получает разрешение браузера и закрывает напоминание навсегда;
   - на телефоне окно не вылезает по горизонтали.

   Запуск: node test/notify-offer-ui.mjs */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.DSHOW_TEST_PORT || 3292);
const BASE = `http://127.0.0.1:${PORT}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshow-notify-ui-'));
const shotsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshow-notify-shots-'));
const OFFERS_FILE = path.join(dataDir, 'notify-offers.json');
const HOME_SCREEN_KEY = 'dshow-home-screen-offer-v1';

const CHROME_CANDIDATES = [
  path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
];
const CHROME = CHROME_CANDIDATES.find((candidate) => fs.existsSync(candidate));
if (!CHROME) {
  console.log('  --  Chrome/Edge не найден, проверка окна уведомлений пропущена');
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
  DSHOW_SIGNUP_PER_HOUR: '30',
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

function forceDue(userId, stage, dueAt = '2020-01-01T00:00:00.000Z') {
  const list = JSON.parse(fs.readFileSync(OFFERS_FILE, 'utf8'));
  const record = list.find((item) => item.userId === userId);
  assert.ok(record, 'нет записи напоминания');
  record.status = 'scheduled';
  record.stage = stage;
  record.dueAt = dueAt;
  fs.writeFileSync(OFFERS_FILE, JSON.stringify(list, null, 2));
}

async function signUp(context, username) {
  const response = await context.request.post(`${BASE}/api/signup`, {
    data: { username, password: 'Test12345' },
  });
  assert.equal(response.status(), 200);
  return response.json();
}

async function waitModal(page, timeout = 12000) {
  await page.waitForFunction(
    () => {
      const title = document.querySelector('.modal-title');
      const root = document.querySelector('#modalRoot');
      return Boolean(title && title.textContent.trim() === 'Уведомления DSH Open' && root && !root.classList.contains('hidden'));
    },
    null,
    { timeout },
  );
}

async function waitClosed(page, timeout = 12000) {
  await page.waitForFunction(
    () => {
      const root = document.querySelector('#modalRoot');
      return Boolean(root && root.classList.contains('hidden'));
    },
    null,
    { timeout },
  );
}

async function noModal(page, waitMs = 1600) {
  await page.waitForTimeout(waitMs);
  return page.evaluate(() => {
    const root = document.querySelector('#modalRoot');
    return !root || root.classList.contains('hidden');
  });
}

async function offerState(page) {
  return page.evaluate(async () => {
    const response = await fetch('/api/notify-offer');
    return response.json();
  });
}

async function preparePage(context, relative = '/') {
  const page = await context.newPage();
  page.on('pageerror', (error) => console.log('PAGEERROR', error.message));
  await page.goto(BASE + relative, { waitUntil: 'domcontentloaded' });
  /* Подсказку про ярлык выключаем: она не должна перекрывать проверяемое окно. */
  await page.evaluate(
    ({ key }) => {
      try {
        localStorage.setItem(key, '1');
      } catch {
        /* ignore */
      }
    },
    { key: HOME_SCREEN_KEY },
  );
  return page;
}

async function openAsNewUser(context, username) {
  const page = await preparePage(context);
  const payload = await signUp(context, username);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitModal(page);
  return { page, user: payload.user };
}

let browser = null;
try {
  if (!(await waitReady())) throw new Error('сервер не поднялся');

  browser = await chromium.launch({ executablePath: CHROME, headless: true });

  /* ---------- компьютер: отложить, крестик и полное выключение ---------- */
  const desktop = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const desktopUser = `notify_desktop_${Date.now().toString(36)}`;
  const { page, user } = await openAsNewUser(desktop, desktopUser);

  const text = await page.locator('.modal-body').innerText();
  check('в окне есть подпись «Узнай о новых возможностях DSH Open»', text.includes('Узнай о новых возможностях DSH Open'));
  const labels = await page.locator('.modal-foot button').allTextContents();
  check('в окне ровно две кнопки «Включить» и «Отложить»', labels.join('|') === 'Включить|Отложить', labels.join(' | '));
  const desktopShot = path.join(shotsDir, 'desktop.png');
  await page.screenshot({ path: desktopShot });
  check('окно помещается в экран компьютера', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));

  await page.locator('.modal-foot button', { hasText: 'Отложить' }).click();
  await waitClosed(page);
  await sleep(300);
  let state = await offerState(page);
  check('кнопка «Отложить» переносит на месяц', state.status === 'scheduled' && state.stage === 2, state.dueAt || '');
  await page.reload({ waitUntil: 'domcontentloaded' });
  check('после «Отложить» окно не мешает при перезагрузке', await noModal(page, 1500));

  forceDue(user.id, 2);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitModal(page);
  await page.locator('.modal-close').click();
  await waitClosed(page);
  await sleep(300);
  state = await offerState(page);
  check('крестик считается откладыванием и ведёт к третьему этапу', state.status === 'scheduled' && state.stage === 3, state.dueAt || '');

  forceDue(user.id, 3);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitModal(page);
  await page.locator('.modal-foot button', { hasText: 'Отложить' }).click();
  await waitClosed(page);
  await sleep(300);
  state = await offerState(page);
  check('третье «Отложить» выключает напоминания', state.status === 'stopped' && state.show === false);
  await page.reload({ waitUntil: 'domcontentloaded' });
  check('после третьего раза окно больше не появляется', await noModal(page, 1800));

  /* ---------- компьютер: включить ---------- */
  const enableContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  /* Подписку в headless-Chrome не проверяем: пусть enablePush не ждёт push-службу. */
  await enableContext.route('**/api/push/state', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ publicKey: '' }) }),
  );
  const enableUser = `notify_enable_${Date.now().toString(36)}`;
  const { page: enablePage } = await openAsNewUser(enableContext, enableUser);
  await enableContext.grantPermissions(['notifications'], { origin: BASE });
  await enablePage.locator('.modal-foot button', { hasText: 'Включить' }).click();
  await waitClosed(enablePage);
  await sleep(400);
  const permission = await enablePage.evaluate(() => (typeof Notification !== 'undefined' ? Notification.permission : 'none'));
  check('кнопка «Включить» получает разрешение браузера', permission === 'granted', permission);
  const enabledState = await offerState(enablePage);
  check('после включения напоминание закрыто навсегда', enabledState.status === 'enabled' && enabledState.show === false);
  await enablePage.reload({ waitUntil: 'domcontentloaded' });
  check('после включения окно не возвращается', await noModal(enablePage, 1800));

  /* ---------- телефон ---------- */
  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });
  const mobileUser = `notify_mobile_${Date.now().toString(36)}`;
  const { page: mobilePage } = await openAsNewUser(mobile, mobileUser);
  const mobileText = await mobilePage.locator('.modal-body').innerText();
  check('на телефоне окно тоже показывается', mobileText.includes('Узнай о новых возможностях DSH Open'));
  const mobileLabels = await mobilePage.locator('.modal-foot button').allTextContents();
  check('на телефоне те же две кнопки', mobileLabels.join('|') === 'Включить|Отложить', mobileLabels.join(' | '));
  /* Лист выезжает снизу за 0,3 с. Меряем после анимации: во время выезда
     кнопки ещё за нижним краем экрана, и проверка ложно падала. */
  await mobilePage.locator('.modal:not(.file-preview-modal)').evaluate((node) =>
    Promise.all(node.getAnimations().map((animation) => animation.finished.catch(() => {}))),
  );
  const metrics = await mobilePage.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
    footBottom: document.querySelector('.modal-foot')?.getBoundingClientRect().bottom || 0,
    viewportHeight: window.innerHeight,
  }));
  check('на телефоне нет горизонтальной прокрутки', metrics.scrollWidth <= metrics.innerWidth, `${metrics.scrollWidth} ≤ ${metrics.innerWidth}`);
  check('кнопки окна видны на экране телефона', metrics.footBottom > 0 && metrics.footBottom <= metrics.viewportHeight, `${Math.round(metrics.footBottom)} ≤ ${metrics.viewportHeight}`);
  const mobileShot = path.join(shotsDir, 'mobile.png');
  await mobilePage.screenshot({ path: mobileShot });
  await mobilePage.locator('.modal-foot button', { hasText: 'Отложить' }).click();
  await waitClosed(mobilePage);
  const mobileState = await offerState(mobilePage);
  check('на телефоне «Отложить» тоже работает', mobileState.status === 'scheduled' && mobileState.stage === 2);

  console.log(`\nСнимки: ${desktopShot}; ${mobileShot}`);
} catch (error) {
  failures += 1;
  console.error('FAIL', error?.message || error);
  if (serverLog) console.error(serverLog.slice(-2000));
} finally {
  if (browser) await browser.close().catch(() => {});
  server.kill();
  await sleep(150);
  fs.rmSync(dataDir, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} проверок не прошло` : '\nВсе проверки окна уведомлений прошли');
if (failures) process.exitCode = 1;
