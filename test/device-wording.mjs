// Проверка подсказок в окне просмотра файлов на разных устройствах:
//   - на компьютере предупреждение говорит про компьютер, а не про телефон;
//   - на телефоне — про телефон, с бесплатными приложениями.
// Раньше на настольной версии висел текст «Телефон не открывает файлы…».
//
// Запуск (нужен уже работающий сервер):
//   $env:DSHOW_BASE='http://127.0.0.1:3131'; $env:DSHOW_USER='admin'; $env:DSHOW_PASS='...'
//   node test/device-wording.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { deleteTestFile, skipOnLive } from './safe-live.mjs';

const BASE = process.env.DSHOW_BASE || 'http://127.0.0.1:3131';
const USER = process.env.DSHOW_USER || 'admin';
const PASS = process.env.DSHOW_PASS || 'Test-pass-2026';
const STAMP = Date.now().toString().slice(-6);
const FILE_NAME = `hint-${STAMP}.docx`;
skipOnLive(BASE, 'проверка подсказок');

const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36';
const PHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

const CHROME_CANDIDATES = [
  path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
];
const CHROME = CHROME_CANDIDATES.find((candidate) => fs.existsSync(candidate));
if (!CHROME) {
  console.log('  --  Chrome/Edge не найден, проверка интерфейса пропущена');
  process.exit(0);
}

const results = [];
function ok(name, extra = '') {
  results.push(true);
  console.log(`  ok  ${name}${extra ? ' — ' + extra : ''}`);
}
function fail(name, detail) {
  results.push(false);
  console.log(`  FAIL ${name}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------------------- Chrome + CDP ---------------------------- */

const PORT = Number(process.env.DSHOW_CDP_PORT || 9336);
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshow-words-'));
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--window-size=1440,900',
    'about:blank',
  ],
  { stdio: 'ignore' },
);

async function browserWs() {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (res.ok) return (await res.json()).webSocketDebuggerUrl;
    } catch {
      /* ещё стартует */
    }
    await sleep(250);
  }
  throw new Error('Chrome не поднял DevTools-порт');
}

const pageWs = async () => {
  for (let attempt = 0; attempt < 60; attempt++) {
    const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
    const pages = (await res.json()).filter((t) => t.type === 'page');
    if (pages.length) return pages[0].webSocketDebuggerUrl;
    await sleep(250);
  }
  throw new Error('нет страницы для подключения');
};

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
  const ready = new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve);
    socket.addEventListener('error', reject);
  });
  return {
    ready,
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

let uploadedProjectId = '';

try {
  await browserWs();
  const cdp = connect(await pageWs());
  await cdp.ready;
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  let loaded = false;
  cdp.on((msg) => {
    if (msg.method === 'Page.loadEventFired') loaded = true;
  });

  async function evaluate(expression) {
    const result = await cdp.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  }

  async function goto(url) {
    loaded = false;
    await cdp.send('Page.navigate', { url });
    for (let attempt = 0; attempt < 80 && !loaded; attempt++) await sleep(100);
    await sleep(300);
  }

  async function waitFor(expression, timeoutMs = 8000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        if (await evaluate(expression)) return true;
      } catch {
        /* страница ещё перезагружается */
      }
      await sleep(150);
    }
    return false;
  }

  async function useDevice(ua, mobile) {
    await cdp.send('Emulation.setUserAgentOverride', { userAgent: ua, platform: mobile ? 'iPhone' : 'Windows' });
    if (mobile) {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: 390,
        height: 844,
        deviceScaleFactor: 2,
        mobile: true,
        screenWidth: 390,
        screenHeight: 844,
      });
      await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    } else {
      await cdp.send('Emulation.clearDeviceMetricsOverride');
      await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false });
    }
  }

  /* Заходим и кладём в проект файл с «офисным» именем: окно просмотра
     показывает для него подсказку об открытии документа. */
  await useDevice(DESKTOP_UA, false);
  await goto(BASE + '/');
  const loginStatus = await evaluate(
    `fetch('/api/login', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({username:${JSON.stringify(USER)}, password:${JSON.stringify(PASS)}})}).then(r => r.status)`,
  );
  loginStatus === 200 ? ok('вход в сервис') : fail('вход', loginStatus);

  uploadedProjectId = await evaluate(
    `(async () => {
       const boot = await (await fetch('/api/bootstrap')).json();
       let project = (boot.projects || [])[0];
       if (!project) project = (await (await fetch('/api/projects', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({name:'Проверка подсказок'})})).json()).project;
       await fetch('/api/projects/' + project.id + '/upload?path=' + encodeURIComponent(${JSON.stringify(FILE_NAME)}), {
         method: 'POST',
         headers: { 'x-filename': encodeURIComponent(${JSON.stringify(FILE_NAME)}) },
         body: 'проверка подсказок',
       });
       return project.id;
     })()`,
  );

  /* Открываем файл так же, как это делает человек: на компьютере — двойным
     щелчком, на тач-экране — одиночным касанием. */
  async function openHintFile(mode = 'dblclick') {
    await waitFor(`[...document.querySelectorAll('.file-row .f-name')].some(n => n.textContent === ${JSON.stringify(FILE_NAME)})`, 10000);
    await evaluate(`(() => {
      const row = [...document.querySelectorAll('.file-row')].find(r => (r.querySelector('.f-name') || {}).textContent === ${JSON.stringify(FILE_NAME)});
      if (!row) return false;
      if (${JSON.stringify(mode)} === 'click') row.click();
      else row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, view: window }));
      return true;
    })()`);
    await waitFor(`!!document.querySelector('.file-preview-modal')`, 8000);
    return evaluate(`(() => {
      const box = document.querySelector('.file-preview');
      return {
        row: [...document.querySelectorAll('.file-row .f-name')].map((n) => n.textContent),
        modal: Boolean(document.querySelector('.file-preview-modal')),
        hint: (box && box.querySelector('.pv-hint') ? box.querySelector('.pv-hint').textContent : '') || '',
        hintParas: box ? [...box.querySelectorAll('.file-hint p')].map((p) => p.textContent.trim()) : [],
      };
    })()`);
  }

  async function closePreview() {
    await evaluate(`document.querySelector('.file-preview-modal .modal-close')?.click()`);
    await waitFor(`!document.querySelector('.file-preview-modal')`, 6000);
  }

  await goto(BASE + '/');
  const appReady = await waitFor(`!!document.getElementById('app') && !document.getElementById('app').classList.contains('hidden')`);
  appReady ? ok('рабочее окно загрузилось') : fail('окно', 'приложение не показалось');

  const desktop = await openHintFile();
  const desktopAll = [desktop.hint, ...desktop.hintParas].join(' ');
  /компьютер/i.test(desktopAll) && !/Телефон не открывает/i.test(desktopAll)
    ? ok('на компьютере подсказка говорит про компьютер', desktop.hint.slice(0, 60))
    : fail('подсказка на компьютере', desktop);
  await closePreview();

  /* Телефон: другая подпись браузера и узкий экран с тач-вводом. */
  await useDevice(PHONE_UA, true);
  await goto(BASE + '/');
  await waitFor(`!!document.getElementById('app') && !document.getElementById('app').classList.contains('hidden')`);
  await evaluate(`document.getElementById('filesBtn')?.click()`);
  await sleep(300);
  const phone = await openHintFile('click');
  const phoneAll = [phone.hint, ...phone.hintParas].join(' ');
  /* Основная подсказка окна говорит про телефон; блок «чем открыть» появляется
     только когда сервис не смог прочитать документ, и тогда он тоже про телефон. */
  /на вашем телефоне/i.test(phoneAll) && (phone.hintParas.length === 0 || /Телефон не открывает/i.test(phoneAll))
    ? ok('на телефоне подсказка говорит про телефон и приложения', phone.hint.slice(0, 60))
    : fail('подсказка на телефоне', phone);
  await closePreview();

  await cdp.send('Emulation.clearDeviceMetricsOverride');
} finally {
  if (uploadedProjectId) await deleteTestFile(BASE, USER, PASS, uploadedProjectId, FILE_NAME).catch(() => {});
  chrome.kill();
  try {
    fs.rmSync(profileDir, { recursive: true, force: true });
  } catch {
    /* профиль мог остаться занят — не критично */
  }
}

const passed = results.filter(Boolean).length;
const failed = results.length - passed;
console.log(`\nИтого: ${passed} ok, ${failed} fail`);
process.exit(failed ? 1 : 0);
