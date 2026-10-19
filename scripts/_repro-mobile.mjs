// Repro мобильных проблем: авто-зум на поле «Название проекта» и отправка сообщения.
// Запуск: DSHOW_BASE=http://127.0.0.1:3199 node scripts/_repro-mobile.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = Number(process.env.CDP_PORT || 9444);
const base = process.env.DSHOW_BASE || 'http://127.0.0.1:3199';
const outDir = process.env.OUT || path.join(os.tmpdir(), 'dshow-repro');
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
  for (let i = 0; i < 80; i += 1) {
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
    this.events = [];
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`));
        else resolve(msg.result);
      } else if (msg.method) {
        this.events.push(msg);
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
await send('Network.enable');
await send('Log.enable');

async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || 'ошибка JS');
  return result.result?.value;
}

async function waitFor(expression, timeout = 20000) {
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

const report = { base, outDir, steps: {} };

const VIEWPORT = {
  width: Number(process.env.VW || 390),
  height: Number(process.env.VH || 844),
  dsf: Number(process.env.VDSF || 2),
  mobile: process.env.VMOBILE !== '0',
};
await send('Emulation.setDeviceMetricsOverride', {
  width: VIEWPORT.width,
  height: VIEWPORT.height,
  deviceScaleFactor: VIEWPORT.dsf,
  mobile: VIEWPORT.mobile,
});
await send('Page.navigate', { url: base + '/' });
await waitFor("document.readyState === 'complete'");
await sleep(500);

// Вход: регистрация нового пользователя (на тестовом инстансе signup открыт).
const loggedIn = await evaluate("!document.querySelector('#app').classList.contains('hidden')");
if (!loggedIn) {
  // Сначала пробуем войти тестовой учёткой, иначе регистрируем её.
  await evaluate(`(() => {
    document.querySelector('#loginUser').value = 'repro';
    document.querySelector('#loginPass').value = 'repro-pass-2026';
    document.querySelector('#loginForm').requestSubmit();
    return true;
  })()`);
  await sleep(1500);
  const ok = await evaluate("!document.querySelector('#app').classList.contains('hidden')");
  report.steps.loginWorked = ok;
  if (!ok) {
    const user = 'repro';
    await evaluate(`(() => {
      const sw = document.querySelector('#authSwitchToSignup');
      if (sw && !sw.closest('.hidden')) sw.click();
      return true;
    })()`);
    await sleep(200);
    const signupVisible = await evaluate("!document.querySelector('#signupForm').classList.contains('hidden')");
    report.steps.signupVisible = signupVisible;
    await evaluate(`(() => {
      document.querySelector('#signupUser').value = ${JSON.stringify('repro')};
      document.querySelector('#signupPass').value = 'repro-pass-2026';
      document.querySelector('#signupPass2').value = 'repro-pass-2026';
      document.querySelector('#signupForm').requestSubmit();
      return true;
    })()`);
    await waitFor("!document.querySelector('#app').classList.contains('hidden')", 15000);
  }
}
await sleep(600);
report.steps.appVisible = await evaluate("!document.querySelector('#app').classList.contains('hidden')");

// --- 1. Поле «Название проекта»: размер шрифта (главная причина авто-зума) ---
await evaluate("document.querySelector('#sidebarToggle').click(); true");
await sleep(400);
await evaluate("document.querySelector('#newProjectBtn').click(); true");
await sleep(400);
report.steps.popoverShown = await evaluate("!!document.querySelector('.popover .popover-input')");
report.steps.popoverInput = await evaluate(`(() => {
  const input = document.querySelector('.popover-input');
  if (!input) return null;
  const cs = getComputedStyle(input);
  const r = input.getBoundingClientRect();
  return { fontSize: cs.fontSize, height: +r.height.toFixed(1), width: +r.width.toFixed(1), viewport: innerWidth };
})()`);
report.steps.popoverGeometry = await evaluate(`(() => {
  const p = document.querySelector('.popover');
  const r = p.getBoundingClientRect();
  return { top: +r.top.toFixed(1), bottom: +r.bottom.toFixed(1), left: +r.left.toFixed(1), right: +r.right.toFixed(1), viewport: { w: innerWidth, h: innerHeight } };
})()`);
report.steps.popoverShot = await shoot('mobile-new-project');

// --- 2. «Зум» и реакция вёрстки: эмулируем масштаб страницы, как это делает iOS ---
await send('Emulation.setPageScaleFactor', { pageScaleFactor: 1.3 });
await sleep(700);
report.steps.afterZoom = await evaluate(`(() => {
  const vv = window.visualViewport;
  const root = document.documentElement;
  return {
    scale: vv ? +vv.scale.toFixed(2) : null,
    vvHeight: vv ? Math.round(vv.height) : null,
    innerHeight,
    kbOpen: root.classList.contains('kb-open'),
    appH: root.style.getPropertyValue('--app-h'),
    kbOffset: root.style.getPropertyValue('--kb-offset'),
  };
})()`);
report.steps.zoomShot = await shoot('mobile-zoomed');
await send('Emulation.setPageScaleFactor', { pageScaleFactor: 1 });
await sleep(600);
report.steps.afterZoomReset = await evaluate(`(() => {
  const vv = window.visualViewport;
  const root = document.documentElement;
  return {
    scale: vv ? +vv.scale.toFixed(2) : null,
    kbOpen: root.classList.contains('kb-open'),
    appH: root.style.getPropertyValue('--app-h'),
  };
})()`);

// --- 3. Создание проекта и отправка сообщения ---
await evaluate(`(() => {
  const input = document.querySelector('.popover-input');
  input.value = 'Проверка';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  const buttons = [...document.querySelectorAll('.popover-actions .btn')];
  const create = buttons.find((b) => /Создать/.test(b.textContent));
  create.click();
  return true;
})()`);
await sleep(1500);
report.steps.afterCreate = await evaluate(`(() => ({
  popoverLeft: !!document.querySelector('.popover'),
  projects: document.querySelectorAll('.project-row').length,
  crumbs: document.querySelector('#crumbChat')?.textContent || '',
  sendVisible: !document.querySelector('#sendBtn').classList.contains('hidden'),
  stopVisible: !document.querySelector('#stopBtn').classList.contains('hidden'),
  activeElement: document.activeElement?.id || document.activeElement?.tagName,
}))()`);
report.steps.afterCreateShot = await shoot('mobile-after-create');

cdp.events.length = 0;
await evaluate(`(() => {
  const input = document.querySelector('#input');
  input.value = 'Привет, это проверка отправки';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  document.querySelector('#sendBtn').click();
  return true;
})()`);
await sleep(2500);
report.steps.afterSend = await evaluate(`(() => ({
  inputValue: document.querySelector('#input').value,
  messages: document.querySelectorAll('.msg').length,
  bubbles: [...document.querySelectorAll('.msg-user .bubble')].map((b) => b.textContent.slice(0, 60)),
  streaming: !document.querySelector('#stopBtn').classList.contains('hidden'),
  errorText: [...document.querySelectorAll('.msg-error, .error-note')].map((n) => n.textContent.slice(0, 200)),
  toast: document.querySelector('#toastRoot')?.textContent || '',
}))()`);
const reqs = cdp.events
  .filter((e) => e.method === 'Network.requestWillBeSent')
  .map((e) => ({ url: e.params.request.url, method: e.params.request.method, postData: e.params.request.postData || '' }))
  .filter((r) => !/\.(css|js|svg|woff2?)($|\?)/.test(r.url));
report.steps.requests = reqs;
const responses = cdp.events
  .filter((e) => e.method === 'Network.responseReceived')
  .map((e) => ({ url: e.params.response.url, status: e.params.response.status }))
  .filter((r) => /\/api\//.test(r.url));
report.steps.responses = responses;
const consoleMsgs = cdp.events
  .filter((e) => e.method === 'Runtime.consoleAPICalled' || e.method === 'Log.entryAdded')
  .map((e) =>
    e.method === 'Log.entryAdded'
      ? `log:${e.params.entry.level}: ${e.params.entry.text}`
      : `console:${e.params.type}: ${(e.params.args || []).map((a) => a.value || a.description || '').join(' ')}`,
  );
report.steps.console = consoleMsgs.slice(-20);

fs.writeFileSync(path.join(outDir, 'repro.json'), JSON.stringify(report, null, 1));
console.log(JSON.stringify(report, null, 1));

await send('Emulation.setPageScaleFactor', { pageScaleFactor: 1 });
await cdp.send('Target.closeTarget', { targetId });
ws.close();
chrome.kill();
await sleep(300);
try {
  fs.rmSync(profile, { recursive: true, force: true });
} catch {
  /* профиль может остаться */
}
