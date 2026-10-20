// Проверка самопроизвольного обновления страницы: открытая вкладка сама
// перезагружается, когда на сервере выложили новую сборку статики.
// Сервер должен быть уже запущен (по умолчанию http://127.0.0.1:3131).
// Запуск:
//   $env:DSHOW_BASE='http://127.0.0.1:3131'; $env:DSHOW_USER='admin'; $env:DSHOW_PASS='...'
//   node test/ui-version.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const BASE = process.env.DSHOW_BASE || 'http://127.0.0.1:3131';
const USER = process.env.DSHOW_USER || 'admin';
const PASS = process.env.DSHOW_PASS || '';
const PORT = Number(process.env.DSHOW_CDP_PORT || 9455);
const UA =
  'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Mobile Safari/537.36';
const CHROME = [
  path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
].find((candidate) => fs.existsSync(candidate));
if (!CHROME) {
  console.log('  --  Chrome/Edge не найден, проверка пропущена');
  process.exit(0);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const version = async () => (await (await fetch(`${BASE}/api/version`)).json()).version;

// 1. сеанс на «телефонной полке», чтобы не выбить вкладку в Chrome
const login = await fetch(`${BASE}/api/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'user-agent': UA },
  body: JSON.stringify({ username: USER, password: PASS }),
});
if (login.status !== 200) {
  console.log(`  FAIL вход в сервис: ${login.status} ${(await login.text()).slice(0, 200)}`);
  process.exit(1);
}
const raw = (login.headers.getSetCookie() || [])[0] || '';
const [pair] = raw.split(';');
const eq = pair.indexOf('=');
const cookieName = pair.slice(0, eq);
const cookieValue = pair.slice(eq + 1);

const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshow-ver-cdp-'));
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
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((item) => item.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      /* ещё стартует */
    }
    await sleep(250);
  }
  throw new Error('CDP не поднялся');
}

const socket = new WebSocket(await pageWs());
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true });
  socket.addEventListener('error', reject, { once: true });
});
let seq = 0;
const pending = new Map();
const loads = [];
socket.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(msg.error.message));
    else resolve(msg.result);
    return;
  }
  if (msg.method === 'Page.loadEventFired') loads.push(Date.now());
});
function send(method, params = {}) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

await send('Page.enable');
await send('Network.enable');
await send('Network.setCookie', {
  name: cookieName,
  value: cookieValue,
  domain: '127.0.0.1',
  path: '/',
  httpOnly: true,
});
await send('Page.navigate', { url: `${BASE}/` });

let failed = 0;
const ok = (name, extra = '') => console.log(`  ok  ${name}${extra ? ` — ${extra}` : ''}`);
const fail = (name, extra = '') => {
  failed += 1;
  console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ''}`);
};

for (let i = 0; i < 80 && loads.length < 1; i++) await sleep(250);
loads.length >= 1 ? ok('вкладка открылась') : fail('первая загрузка');

const before = await version();
const styles = path.resolve('public/styles.css');
const stamp = new Date(Date.now() + 5000);
fs.utimesSync(styles, stamp, stamp);
await sleep(2600); // сервер запоминает версию на пару секунд
const after = await version();
after !== before
  ? ok('версия статики сменилась', `${before} → ${after}`)
  : fail('версия статики', `${before} → ${after}`);

// Клиент спрашивает версию раз в минуту; ждём перезагрузку вкладки до 100 с.
const loadsBefore = loads.length;
for (let i = 0; i < 200 && loads.length === loadsBefore; i++) await sleep(500);
loads.length > loadsBefore
  ? ok('вкладка обновилась сама, без F5', `через ${Math.round((loads[loads.length - 1] - loads[0]) / 1000)} с`)
  : fail('вкладка не обновилась сама');

socket.close();
chrome.kill();
await sleep(300);
fs.rmSync(profileDir, { recursive: true, force: true });
console.log(failed ? `Итого: провалов ${failed}` : 'Итого: 0 провалов');
process.exit(failed ? 1 : 0);
