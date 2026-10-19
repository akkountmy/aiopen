// Headless-проверка интерфейса: скриншоты и замеры геометрии на разных ширинах.
// Запуск: node scripts/_ui-shots.mjs
//   DSHOW_BASE=http://127.0.0.1:3123 UI_USER=uicheck UI_PASS=ui-check-2026 \
//   OUT=%TEMP%\dshow-ui
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = Number(process.env.CDP_PORT || 9333);
const base = process.env.DSHOW_BASE || 'http://127.0.0.1:3123';
const user = process.env.UI_USER || 'uicheck';
const pass = process.env.UI_PASS || 'ui-check-2026';
const outDir = process.env.OUT || path.join(os.tmpdir(), 'dshow-ui');
fs.mkdirSync(outDir, { recursive: true });

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dshow-cdp-'));
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--hide-scrollbars',
    '--disable-extensions',
    'about:blank',
  ],
  { stdio: 'ignore' },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function wsUrl() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      const data = await res.json();
      if (data.webSocketDebuggerUrl) return data.webSocketDebuggerUrl;
    } catch {
      /* ещё не поднялся */
    }
    await sleep(250);
  }
  throw new Error('Chrome DevTools не отвечает');
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`));
        else resolve(msg.result);
      }
    };
  }

  send(method, params = {}, sessionId) {
    this.id += 1;
    const id = this.id;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(payload));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`таймаут ${method}`));
        }
      }, 30000);
    });
  }
}

const ws = new WebSocket(await wsUrl());
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});
const cdp = new Cdp(ws);

const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
const send = (method, params) => cdp.send(method, params, sessionId);
await send('Page.enable');
await send('Runtime.enable');

async function evaluate(expression) {
  const result = await send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || 'ошибка JS');
  }
  return result.result?.value;
}

async function waitFor(expression, timeout = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await evaluate(expression)) return true;
    await sleep(150);
  }
  throw new Error(`не дождались: ${expression}`);
}

async function shoot(name) {
  const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const file = path.join(outDir, `${name}.png`);
  fs.writeFileSync(file, Buffer.from(data, 'base64'));
  return file;
}

const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900, mobile: false },
  { name: 'laptop', width: 1180, height: 800, mobile: false },
  { name: 'tablet', width: 1000, height: 780, mobile: false },
  { name: 'mobile', width: 390, height: 844, mobile: true },
];

const GEOMETRY = `(() => {
  const r = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const b = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return { top: +b.top.toFixed(1), bottom: +b.bottom.toFixed(1), height: +b.height.toFixed(1), left: +b.left.toFixed(1), right: +b.right.toFixed(1), width: +b.width.toFixed(1), visible: cs.display !== 'none' && cs.visibility !== 'hidden' };
  };
  const ta = document.querySelector('#input');
  return {
    viewport: { w: innerWidth, h: innerHeight },
    sidebarHead: r('.sidebar-head'),
    topbar: r('.topbar'),
    filesHead: r('.files-head'),
    filesPanel: r('#filesPanel'),
    userChip: r('#userChip'),
    userName: r('#userName'),
    filesTitle: r('.files-title'),
    filesDownload: r('#exportProjectBtn'),
    filesClose: r('#filesClose'),
    composerButtons: ['#attachBtn', '#spellBtn', '#micBtn', '#sendBtn', '#stopBtn'].map((s) => [s, r(s)]),
    themeToggle: r('#themeToggle'),
    composer: r('.composer'),
    attachBtn: r('#attachBtn'),
    attachLabel: r('.attach-label'),
    input: r('#input'),
    inputScroll: ta ? { scrollHeight: ta.scrollHeight, clientHeight: ta.clientHeight, overflowY: getComputedStyle(ta).overflowY } : null,
    headerBottoms: [r('.sidebar-head'), r('.topbar'), r('.files-head')].filter(Boolean).map((x) => x.bottom),
    headBoxes: [['sidebar-head', '.sidebar-head'], ['topbar', '.topbar'], ['files-head', '.files-head']].map(([name, sel]) => {
      const el = document.querySelector(sel);
      if (!el) return { name, missing: true };
      const b = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return { name, top: Math.round(b.top), height: Math.round(b.height), cssHeight: cs.height, padding: cs.padding, children: el.children.length };
    }),
    bodyScroll: { scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth },
  };
})()`;

const report = [];
for (const vp of VIEWPORTS) {
  await send('Emulation.setDeviceMetricsOverride', {
    width: vp.width,
    height: vp.height,
    deviceScaleFactor: 1,
    mobile: vp.mobile,
  });
  await send('Page.navigate', { url: base + '/' });
  await waitFor("document.readyState === 'complete'");
  await sleep(400);
  const loggedIn = await evaluate("!document.querySelector('#app').classList.contains('hidden')");
  if (!loggedIn) {
    await evaluate(`(() => {
      const u = document.querySelector('#loginUser');
      const p = document.querySelector('#loginPass');
      u.value = ${JSON.stringify(user)};
      p.value = ${JSON.stringify(pass)};
      document.querySelector('#loginForm').requestSubmit();
      return true;
    })()`);
    await waitFor("!document.querySelector('#app').classList.contains('hidden')", 20000);
    await sleep(600);
  }
  const file = await shoot(`${vp.name}-chat`);
  const geometry = await evaluate(GEOMETRY);
  report.push({ vp: vp.name, file, geometry });
}

// Проверка авторасширения ввода: 1 строка, 8 строк, 40 строк.
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: base + '/' });
await waitFor("document.readyState === 'complete'");
await waitFor("!document.querySelector('#app').classList.contains('hidden')", 20000);
await sleep(400);
const grow = await evaluate(`(() => {
  const ta = document.querySelector('#input');
  const set = (text) => {
    ta.value = text;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    return { h: Math.round(ta.getBoundingClientRect().height), scroll: ta.scrollHeight, client: ta.clientHeight, overflow: getComputedStyle(ta).overflowY };
  };
  const one = set('Строка');
  const eight = set(Array.from({ length: 8 }, (_, i) => 'строка ' + (i + 1)).join('\\n'));
  const forty = set(Array.from({ length: 40 }, (_, i) => 'строка ' + (i + 1)).join('\\n'));
  const layout = {
    docScrollHeight: document.documentElement.scrollHeight,
    innerHeight,
    composerBottom: Math.round(document.querySelector('.composer').getBoundingClientRect().bottom),
    threadHeight: Math.round(document.querySelector('#thread').getBoundingClientRect().height),
  };
  ta.value = '';
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  return { one, eight, forty, layout };
})()`);

await evaluate(`(() => {
  const ta = document.querySelector('#input');
  ta.value = Array.from({ length: 9 }, (_, i) => 'Строка текста ' + (i + 1)).join('\\n');
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`);
await sleep(250);
const multilineShot = await shoot('desktop-multiline');
await evaluate(`(() => { const ta = document.querySelector('#input'); ta.value = ''; ta.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);

// Мобильное меню и панель файлов: проверяем открытие/закрытие.
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
await send('Page.navigate', { url: base + '/' });
await waitFor("document.readyState === 'complete'");
await waitFor("!document.querySelector('#app').classList.contains('hidden')", 20000);
await sleep(400);
await evaluate("document.querySelector('#sidebarToggle').click(); true");
await sleep(350);
const sidebarOpen = await evaluate("document.querySelector('#app').classList.contains('sidebar-open')");
const sidebarShot = await shoot('mobile-sidebar');
await evaluate("document.querySelector('#backdrop').click(); true");
await sleep(300);
const sidebarClosed = await evaluate("!document.querySelector('#app').classList.contains('sidebar-open')");
await evaluate("document.querySelector('#filesBtn').click(); true");
await sleep(400);
const filesOverlay = await evaluate(`(() => {
  const p = document.querySelector('#filesPanel');
  const b = document.querySelector('#backdrop');
  return {
    panelHidden: p.classList.contains('hidden'),
    panelRect: p.getBoundingClientRect().toJSON(),
    backdropShown: getComputedStyle(b).display !== 'none',
  };
})()`);
const filesShot = await shoot('mobile-files');
const filesGeometry = await evaluate(GEOMETRY);

const summary = {
  outDir,
  report,
  grow,
  sidebarOpen,
  sidebarClosed,
  filesOverlay,
  filesShot,
  multilineShot,
  filesGeometry: filesGeometry.headerBottoms,
};
fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(summary, null, 1));
console.log(JSON.stringify(summary, null, 1));

await cdp.send('Target.closeTarget', { targetId });
ws.close();
chrome.kill();
await sleep(300);
try {
  fs.rmSync(profile, { recursive: true, force: true });
} catch {
  /* профиль может остаться */
}
