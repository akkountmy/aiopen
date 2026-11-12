/**
 * Живая проверка: переход в диалог закрывает экран-раздел.
 *
 * Сценарий повторяет жалобу пользователя:
 *   1. открыт «Дашборд», человек создаёт новый проект — проект появляется в
 *      панели, а на экране остаётся дашборд, хотя ждёт новый диалог;
 *   2. то же самое из «Top news»;
 *   3. нажатие по проекту поверх открытого раздела тоже возвращает в диалог,
 *      даже если этот проект уже выбран (без диалога).
 *
 * «Дашборд» и «Top news» занимают место ленты (класс .dash-open / .news-open на
 * .app), поэтому проверяем по-настоящему видимое: класс снят, раздел скрыт,
 * лента и поле ввода на экране, в ленте — стартовый экран нового диалога.
 *
 * Поднимает отдельный экземпляр сервиса (планировщики выключены: проверка не
 * должна тратить токены) и headless Chrome через DevTools-протокол. У сервиса
 * свой временный каталог данных, поэтому настоящие проекты не трогаются.
 *
 * Запуск: node test/ui-sections.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const APP_PORT = 3418;
const CDP_PORT = 9434;
const BASE = `http://127.0.0.1:${APP_PORT}`;
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dshow-ui-sections-'));
const ADMIN = { username: 'DSH', password: 'TestPass-12345' };
const STAMP = Date.now().toString().slice(-6);
const FROM_DASHBOARD = `Проект из дашборда ${STAMP}`;
const FROM_NEWS = `Проект из новостей ${STAMP}`;

const CHROME_CANDIDATES = [
  path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
];
const CHROME = CHROME_CANDIDATES.find((candidate) => fs.existsSync(candidate));
if (!CHROME) {
  console.log('  --  Chrome/Edge не найден, живая проверка пропущена');
  process.exit(0);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let failures = 0;
function ok(label, extra = '') {
  console.log(`  ok  ${label}${extra ? ' — ' + extra : ''}`);
}
function fail(label, detail) {
  failures += 1;
  console.log(`  ПРОВАЛ ${label}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
}
const check = (good, label, detail) => (good ? ok(label, detail) : fail(label, detail));

/* ------------------------------ сервис ------------------------------ */

const app = spawn(process.execPath, ['server.mjs'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    DSHOW_PORT: String(APP_PORT),
    DSHOW_HOST: '127.0.0.1',
    DSHOW_DATA_DIR: DIR,
    DSHOW_ADMIN_USER: ADMIN.username,
    DSHOW_ADMIN_PASSWORD: ADMIN.password,
    DSHOW_TRUST_PROXY: '0',
    /* Ни один планировщик не должен сходить в модель: проверяется только
       переход между экранами. */
    DSHOW_DASHBOARD: '0',
    DSHOW_TOPNEWS_SCHEDULE: '0',
    DSHOW_BACKUPS: '0',
    DSHOW_PUSH_SCHEDULE: '0',
    DSHOW_TG_SCHEDULE: '0',
    DSHOW_CONTEXT_COMPACT: '0',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
app.stderr.on('data', (chunk) => {
  const line = String(chunk);
  if (!/ExperimentalWarning|localstorage/.test(line)) process.stderr.write(`[сервис] ${line}`);
});

const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshow-ui-sections-profile-'));
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--window-size=1440,900',
    'about:blank',
  ],
  { stdio: 'ignore' },
);

async function pageWs() {
  for (let i = 0; i < 80; i += 1) {
    try {
      const pages = (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()).filter((t) => t.type === 'page');
      if (pages.length) return pages[0].webSocketDebuggerUrl;
    } catch {
      /* ещё стартует */
    }
    await sleep(250);
  }
  throw new Error('нет страницы для подключения');
}

function connect(wsUrl) {
  const socket = new WebSocket(wsUrl);
  let nextId = 1;
  const pending = new Map();
  const listeners = new Set();
  socket.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
      return;
    }
    for (const listener of listeners) listener(msg);
  });
  return {
    ready: new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve);
      socket.addEventListener('error', reject);
    }),
    send(method, params = {}) {
      const id = nextId++;
      socket.send(JSON.stringify({ id, method, params }));
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    },
    on(listener) {
      listeners.add(listener);
    },
    close() {
      socket.close();
    },
  };
}

let cdp = null;
let loaded = false;
const pageErrors = [];
const consoleLog = [];
const apiLog = [];

async function evaluate(expression) {
  const result = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result.value;
}

async function goto(url) {
  loaded = false;
  await cdp.send('Page.navigate', { url });
  for (let i = 0; i < 140 && !loaded; i += 1) await sleep(70);
  await sleep(350);
}

async function waitFor(expression, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await evaluate(expression)) return true;
    } catch {
      /* страница перерисовывается */
    }
    await sleep(120);
  }
  return false;
}

const fill = (selector, value) =>
  evaluate(`(() => {
    const node = document.querySelector(${JSON.stringify(selector)});
    if (!node) throw new Error('нет ${selector}');
    node.focus();
    node.value = ${JSON.stringify(value)};
    node.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);

const click = (selector) =>
  evaluate(`(() => {
    const node = document.querySelector(${JSON.stringify(selector)});
    if (!node) throw new Error('нет ${selector}');
    node.click();
    return true;
  })()`);

/* Enter в поле названия проекта: карточка создаёт проект тем же путём, что и
   кнопка «Создать проект». */
const pressEnter = (selector) =>
  evaluate(`(() => {
    const node = document.querySelector(${JSON.stringify(selector)});
    if (!node) throw new Error('нет ${selector}');
    node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    return true;
  })()`);

/* Что видно на экране: раздел открыт или человек в диалоге. Разделы занимают
   место ленты, поэтому смотрим не только на класс .app, но и на видимость
   ленты и поля ввода. */
const SCREEN = `(() => {
    const app = document.getElementById('app');
    const visible = (selector) => {
      const node = document.querySelector(selector);
      return Boolean(node) && getComputedStyle(node).display !== 'none';
    };
    const crumb = document.getElementById('crumbChat');
    return {
      dashOpen: app.classList.contains('dash-open'),
      newsOpen: app.classList.contains('news-open'),
      dashHidden: document.getElementById('dashboardView').classList.contains('hidden'),
      newsHidden: document.getElementById('newsView').classList.contains('hidden'),
      scrollVisible: visible('.scroll'),
      composerVisible: visible('.composer-wrap'),
      startScreen: Boolean(document.querySelector('#thread .empty .empty-title')),
      crumb: ((crumb && crumb.textContent) || '').trim(),
    };
  })()`;

/* Новый проект, созданный из открытого раздела, должен оставить человека в его
   диалоге: раздел закрыт, лента и поле ввода на экране, в ленте — стартовый
   экран «Чем помочь?». */
function inDialog(screen, section) {
  return (
    !screen.dashOpen &&
    !screen.newsOpen &&
    screen.dashHidden &&
    screen.newsHidden &&
    screen.scrollVisible &&
    screen.composerVisible &&
    screen.startScreen &&
    screen.crumb !== section
  );
}

const rowOf = (name) =>
  `[...document.querySelectorAll('.project-row')].find((row) => (row.querySelector('.p-name') || {}).textContent?.includes(${JSON.stringify(name)}))`;

/* Диагностика при провале: что видно и что сервис ответил в этот момент. */
async function dumpPage(tag) {
  const info = await evaluate(`(() => ({
    dash: document.getElementById('dashboardView').classList.contains('hidden'),
    news: document.getElementById('newsView').classList.contains('hidden'),
    popover: Boolean(document.querySelector('.sidebar .popover')),
    popoverTitle: (document.querySelector('.popover-title') || {}).textContent || '',
    input: (document.querySelector('.popover-input') || {}).value || '',
    projects: [...document.querySelectorAll('.project-row .p-name')].map((n) => n.textContent.trim()).slice(-6),
    toasts: [...document.querySelectorAll('.toast')].map((n) => n.textContent.trim()).slice(0, 4),
    thread: ((document.querySelector('#thread') || {}).textContent || '').slice(0, 160),
  }))()`);
  console.log(`  [${tag}]`, JSON.stringify(info));
  console.log(`  [${tag}] api:`, apiLog.slice(-16).join(' | ') || 'нет запросов');
  if (consoleLog.length) console.log(`  [${tag}] консоль:`, consoleLog.slice(-6).join(' || '));
}

async function createProjectFromSection(buttonId, name, label) {
  await click(buttonId);
  const opened = await waitFor(`!!document.querySelector('.sidebar .popover input')`);
  if (!opened) {
    fail(`${label}: карточка «Новый проект» открылась`, 'нет поля названия');
    return;
  }
  await fill('.sidebar .popover input', name);
  await pressEnter('.sidebar .popover input');
  /* Тост живёт несколько секунд: если создание упало, его текст — единственное
     объяснение. Снимаем его сразу, а строку проекта ждём уже потом. */
  await sleep(900);
  const earlyToasts = await evaluate(`[...document.querySelectorAll('.toast')].map((n) => n.textContent.trim())`);
  const created = await waitFor(`Boolean(${rowOf(name)})`, 15000);
  check(created, `${label}: проект создан`, name);
  if (!created) {
    console.log(`  [тосты] ${JSON.stringify(earlyToasts)}`);
    await dumpPage(`проект из «${label}» не появился`);
    return;
  }
  /* Экран перерисовывается после ответа сервера — ждём, пока раздел уйдёт. */
  await waitFor(`!document.getElementById('app').classList.contains('dash-open') && !document.getElementById('app').classList.contains('news-open')`);
  const screen = await evaluate(SCREEN);
  check(inDialog(screen, label), `${label}: вместо раздела открылся диалог`, JSON.stringify(screen));
}

/* ------------------------------ сценарии ------------------------------ */

try {
  for (let i = 0; i < 80; i += 1) {
    try {
      if ((await fetch(`${BASE}/api/health`)).ok) break;
    } catch {
      /* поднимается */
    }
    await sleep(250);
  }

  cdp = connect(await pageWs());
  await cdp.ready;
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Network.enable');
  cdp.on((msg) => {
    if (msg.method === 'Page.loadEventFired') loaded = true;
    if (msg.method === 'Runtime.exceptionThrown') {
      pageErrors.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
    }
    if (msg.method === 'Runtime.consoleAPICalled') {
      consoleLog.push(`${msg.params.type}: ${(msg.params.args || []).map((a) => a.value ?? a.description).join(' ')}`.slice(0, 400));
    }
    if (msg.method === 'Network.requestWillBeSent') {
      const request = msg.params.request;
      if (request.url.includes('/api/')) apiLog.push(`#${msg.params.requestId} -> ${request.method} ${request.url.replace(BASE, '')}`);
    }
    if (msg.method === 'Network.responseReceived') {
      const response = msg.params.response;
      if (response.url.includes('/api/')) apiLog.push(`#${msg.params.requestId} <- ${response.status}`);
    }
  });

  await goto(BASE);
  await waitFor(`!!document.querySelector('#loginUser')`);
  await fill('#loginUser', ADMIN.username);
  await fill('#loginPass', ADMIN.password);
  await click('#loginSubmit');
  /* Поле ввода есть в разметке всегда, поэтому «вход выполнен» проверяем по
     признаку вошедшего человека: экран входа скрыт, приложение показано и в
     списке уже стоит проект. Иначе нажатия уходят на сервер раньше, чем он
     успевает выдать cookie, и всё возвращается 401. */
  const signedIn = await waitFor(
    `(() => {
      const app = document.getElementById('app');
      const auth = document.getElementById('auth');
      return Boolean(app) && !app.classList.contains('hidden')
        && Boolean(auth) && auth.classList.contains('hidden')
        && document.querySelectorAll('.project-row').length > 0;
    })()`,
    15000,
  );
  check(signedIn, 'вход через интерфейс выполнен');

  /* ---------------- 1. «Дашборд» → новый проект ---------------- */

  await click('#dashboardBtn');
  const dashShown = await waitFor(`document.getElementById('app').classList.contains('dash-open')`);
  check(dashShown, '«Дашборд» открылся');
  const onDash = dashShown ? await evaluate(SCREEN) : null;
  check(
    Boolean(onDash) && onDash.scrollVisible === false && onDash.composerVisible === false && onDash.crumb === 'Дашборд',
    '«Дашборд» занимает место ленты, в крошке его название',
    JSON.stringify(onDash),
  );

  await createProjectFromSection('#newProjectBtn', FROM_DASHBOARD, 'Дашборд');

  /* ---------------- 2. «Top news» → новый проект ---------------- */

  await click('#newsBtn');
  const newsShown = await waitFor(`document.getElementById('app').classList.contains('news-open')`);
  check(newsShown, '«Top news» открылся');
  const onNews = newsShown ? await evaluate(SCREEN) : null;
  check(
    Boolean(onNews) && onNews.scrollVisible === false && onNews.composerVisible === false && onNews.crumb === 'Top news',
    '«Top news» занимает место ленты, в крошке его название',
    JSON.stringify(onNews),
  );

  await createProjectFromSection('#newProjectBtn', FROM_NEWS, 'Top news');

  /* ---------------- 3. нажатие по проекту поверх раздела ---------------- */

  await click('#dashboardBtn');
  await waitFor(`document.getElementById('app').classList.contains('dash-open')`);
  /* Нажимаем по уже выбранному проекту без диалога: обычно это только
     сворачивает список диалогов, но под открытым разделом это «ничего» —
     поэтому такой клик тоже обязан вернуть в диалог. */
  const clicked = await evaluate(`(() => {
    const row = ${rowOf(FROM_NEWS)};
    if (!row) return false;
    (row.querySelector('.row-main') || row).click();
    return true;
  })()`);
  check(clicked, 'строка проекта нажата поверх «Дашборда»');
  await waitFor(`!document.getElementById('app').classList.contains('dash-open')`, 6000);
  const afterRowClick = await evaluate(SCREEN);
  check(inDialog(afterRowClick, 'Дашборд'), 'нажатие по проекту закрыло раздел и вернуло в диалог', JSON.stringify(afterRowClick));

  /* ---------------- 4. обычная жизнь разделов не сломана ---------------- */

  await click('#dashboardBtn');
  await waitFor(`document.getElementById('app').classList.contains('dash-open')`);
  await click('#dashboardBtn');
  const dashClosed = await waitFor(`!document.getElementById('app').classList.contains('dash-open')`);
  const afterToggle = dashClosed ? await evaluate(SCREEN) : null;
  check(
    Boolean(afterToggle) && afterToggle.scrollVisible && afterToggle.composerVisible && afterToggle.dashHidden,
    'кнопка «Дашборд» по-прежнему закрывает раздел и возвращает ленту',
    JSON.stringify(afterToggle),
  );

  check(pageErrors.length === 0, 'ошибок в консоли за весь сценарий нет', pageErrors.slice(0, 2).join(' | '));
} catch (error) {
  fail('сценарий', error.stack || error.message);
} finally {
  if (cdp) cdp.close();
  chrome.kill();
  app.kill();
  await sleep(400);
  for (const dir of [DIR, profileDir]) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

console.log(failures ? `\nПровалов: ${failures}` : '\nВсё прошло');
process.exit(failures ? 1 : 0);
