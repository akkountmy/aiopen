/* Уведомления включены у всех по умолчанию — проверяем это настоящим Chrome
   (headless) через DevTools-протокол на уже запущенном сервере:
   – человек входит и ничего не настраивает, а устройство само появляется на
     сервере (подписка оформляется молча, без окон и кнопок);
   – в меню аккаунта нет пункта «Уведомления», окна уведомлений нет вовсе;
   – выключить уведомления из интерфейса нечем — ни «Выключить», ни тумблера;
   – повторное открытие приложения не заводит второе устройство;
   – без разрешения браузера приложение не просит его при загрузке (только по
     действию человека) и продолжает работать.
   Запуск (сервер уже слушает, нужен Chrome или Edge):
     DSHOW_BASE=http://127.0.0.1:3131 DSHOW_USER=admin DSHOW_PASS=... node test/push-auto.mjs */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const BASE = process.env.DSHOW_BASE || 'http://127.0.0.1:3131';
const USER = process.env.DSHOW_USER || 'admin';
const PASS = process.env.DSHOW_PASS || 'Test-pass-2026';
const PORT = Number(process.env.DSHOW_CDP_PORT || 9431);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const CHROME_CANDIDATES = [
  path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
];
const CHROME = CHROME_CANDIDATES.find((candidate) => fs.existsSync(candidate));
if (!CHROME) {
  console.log('  --  Chrome/Edge не найден, проверка уведомлений пропущена');
  process.exit(0);
}

let failures = 0;
function check(label, ok, detail = '') {
  if (ok) {
    console.log(`  ok  ${label}`);
    return;
  }
  failures += 1;
  console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
}

const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshow-push-auto-'));
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--window-size=1280,900',
    'about:blank',
  ],
  { stdio: 'ignore' },
);

async function pageWs() {
  for (let i = 0; i < 80; i += 1) {
    try {
      const pages = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter((t) => t.type === 'page');
      if (pages.length) return pages[0].webSocketDebuggerUrl;
    } catch {
      /* браузер ещё стартует */
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
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
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

let cdp;
try {
  cdp = connect(await pageWs());
  await cdp.ready;
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Network.enable');

  let loaded = false;
  const consoleErrors = [];
  cdp.on((msg) => {
    if (msg.method === 'Page.loadEventFired') loaded = true;
    if (msg.method === 'Runtime.exceptionThrown') {
      consoleErrors.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
    }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      consoleErrors.push(msg.params.args.map((arg) => arg.value ?? arg.description ?? '').join(' '));
    }
  });

  async function evaluate(expression) {
    const result = await cdp.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    }
    return result.result.value;
  }
  async function goto(url) {
    loaded = false;
    await cdp.send('Page.navigate', { url });
    for (let i = 0; i < 150 && !loaded; i += 1) await sleep(80);
    await sleep(300);
  }
  async function waitFor(expression, timeoutMs = 20000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        if (await evaluate(expression)) return true;
      } catch {
        /* страница перезагружается */
      }
      await sleep(150);
    }
    return false;
  }
  const readySelector = `document.querySelector('#boot').classList.contains('hidden') && Boolean(document.querySelector('#input'))`;
  const pushState = () => evaluate(`fetch('/api/push/state').then((r) => r.json())`);
  const subscriptions = async () => {
    try {
      return Number((await pushState()).subscriptions) || 0;
    } catch {
      return -1;
    }
  };
  /* Уборка после проверки: снимаем устройство через API этого же аккаунта. */
  const unsubscribeBrowserDevice = async () => {
    const endpoint = await evaluate(
      `navigator.serviceWorker.ready.then((r) => r.pushManager.getSubscription()).then((s) => (s ? s.endpoint : ''))`,
    ).catch(() => '');
    if (endpoint) {
      await evaluate(
        `fetch('/api/push/unsubscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint: ${JSON.stringify(endpoint)} }) }).then((r) => r.status)`,
      ).catch(() => 0);
    }
    return endpoint;
  };

  /* Разрешение выдаём заранее: так приложение получает его без запроса —
     ровно то состояние, в котором у человека уведомления уже работают. */
  await cdp.send('Browser.grantPermissions', { origin: BASE, permissions: ['notifications'] });

  await goto(`${BASE}/`);
  await evaluate(
    `fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: ${JSON.stringify(USER)}, password: ${JSON.stringify(PASS)} }) }).then((r) => r.status)`,
  );
  await goto(`${BASE}/`);
  const entered = await waitFor(readySelector, 30000);
  check('приложение открывается после входа', entered);
  if (!entered) throw new Error('вход не удался');

  /* Главное: человек ничего не нажимал в уведомлениях, а устройство уже есть. */
  let autoSubscribed = false;
  for (let i = 0; i < 90 && !autoSubscribed; i += 1) {
    if ((await subscriptions()) >= 1) autoSubscribed = true;
    else await sleep(500);
  }
  check('устройство подписалось само, без окон и кнопок', autoSubscribed);
  const state = await pushState();
  check('на сервере ровно одно устройство', Number(state.subscriptions) === 1, JSON.stringify(state));
  check('ключ VAPID отдан браузеру', Boolean(state.publicKey));

  /* Пункта «Уведомления» в меню больше нет, а окна нет вовсе. */
  await evaluate(`document.querySelector('#userChip').click()`);
  const menuOpened = await waitFor(`document.querySelectorAll('.menu button').length > 0`);
  const menuLabels = await evaluate(`Array.from(document.querySelectorAll('.menu button')).map((node) => node.textContent.trim())`);
  check('меню аккаунта открывается', menuOpened, JSON.stringify(menuLabels));
  check('в меню нет пункта «Уведомления»', !menuLabels.includes('Уведомления'), JSON.stringify(menuLabels));
  check('остальные пункты меню на месте', menuLabels.includes('Выйти'), JSON.stringify(menuLabels));

  const pageText = await evaluate(`document.body.innerText`);
  check('на странице нет кнопки «Выключить»', !/Выключить/i.test(pageText));
  check('окна уведомлений в разметке нет', (await evaluate(`document.querySelectorAll('.push-panel').length`)) === 0);
  check(
    'про уведомления нигде не спрашивают',
    !/включить уведомления|уведомления выключены|уведомления включены/i.test(pageText),
  );

  /* Повторное открытие не должно заводить второе устройство. */
  await goto(`${BASE}/`);
  const reopened = await waitFor(readySelector, 30000);
  check('приложение открывается повторно', reopened);
  let stable = false;
  for (let i = 0; i < 60 && !stable; i += 1) {
    const count = await subscriptions();
    if (count === 1) {
      await sleep(1200);
      stable = (await subscriptions()) === 1;
      break;
    }
    await sleep(500);
  }
  check('после перезагрузки устройство по-прежнему одно', stable, String(await subscriptions()));

  /* Уборка: снимаем устройство, чтобы не оставлять следов на сервере. */
  const endpoint = await unsubscribeBrowserDevice();
  check('устройство снимается через API', Boolean(endpoint));
  let cleaned = await subscriptions();
  for (let i = 0; i < 20 && cleaned !== 0; i += 1) {
    await sleep(250);
    cleaned = await subscriptions();
  }
  check('после проверки устройств нет', cleaned === 0, String(cleaned));

  /* Без разрешения браузера: при загрузке ничего не спрашиваем, приложение
     работает, подписки нет. */
  await cdp.send('Browser.resetPermissions');
  await goto(`${BASE}/`);
  const reopenedWithoutPermission = await waitFor(readySelector, 30000);
  check('без разрешения приложение тоже работает', reopenedWithoutPermission);
  const permission = await evaluate(`Notification.permission`);
  check('при загрузке разрешение не спрашивают', permission === 'default', permission);
  await sleep(1500);
  const stillEmpty = await subscriptions();
  check('без разрешения устройство не добавляется', stillEmpty === 0, String(stillEmpty));

  const errorsBeforeCleanup = consoleErrors.filter((line) => !/favicon|Failed to load resource/i.test(line));
  check('ошибок в консоли нет', errorsBeforeCleanup.length === 0, errorsBeforeCleanup.slice(0, 3).join(' | '));
} finally {
  try {
    cdp?.close();
  } catch {
    /* ignore */
  }
  chrome.kill();
  try {
    fs.rmSync(profileDir, { recursive: true, force: true });
  } catch {
    /* профиль мог остаться занятым */
  }
}

console.log(failures ? `\n  провалено проверок: ${failures}` : '\n  уведомления включены по умолчанию и выключить их нельзя');
process.exitCode = failures ? 1 : 0;
