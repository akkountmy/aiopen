// Проверка подсказок в мобильной версии в настоящем Chrome через DevTools-протокол (без зависимостей):
//   - четыре карточки «Чем помочь?» стоят по две в ряд на телефоне (390 px и 320 px);
//   - ничего не вылезает по горизонтали, текст карточек не обрезан.
//
// Запуск (нужен уже работающий сервер):
//   $env:DSHOW_BASE='http://127.0.0.1:3131'; $env:DSHOW_USER='admin'; $env:DSHOW_PASS='...'
//   node test/ui-mobile.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const BASE = process.env.DSHOW_BASE || 'http://127.0.0.1:3131';
const USER = process.env.DSHOW_USER || 'admin';
const PASS = process.env.DSHOW_PASS || 'Test-pass-2026';

const CHROME_CANDIDATES = [
  path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
];
const CHROME = CHROME_CANDIDATES.find((candidate) => fs.existsSync(candidate));
if (!CHROME) {
  console.log('  --  Chrome/Edge не найден, проверка мобильной версии пропущена');
  process.exit(0);
}

const results = [];
function ok(name, extra = '') {
  results.push(true);
  console.log(`  ok  ${name}${extra ? ' — ' + extra : ''}`);
}
function fail(name, detail) {
  results.push(false);
  console.log(`  FAIL ${name}: ${detail}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------------------- Chrome + CDP ---------------------------- */

const PORT = Number(process.env.DSHOW_CDP_PORT || 9334);
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshow-cdp-'));
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

async function pageWs() {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const pages = (await res.json()).filter((t) => t.type === 'page');
      if (pages.length) return pages[0].webSocketDebuggerUrl;
    } catch {
      /* ещё стартует */
    }
    await sleep(250);
  }
  throw new Error('Chrome не поднял DevTools-порт');
}

function connect(wsUrl) {
  const socket = new WebSocket(wsUrl);
  let nextId = 1;
  const pending = new Map();
  socket.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (!msg.id || !pending.has(msg.id)) return;
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
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
    close() {
      socket.close();
    },
  };
}

try {
  const cdp = connect(await pageWs());
  await cdp.ready;
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  async function evaluate(expression) {
    const result = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  }

  async function goto(url) {
    await cdp.send('Page.navigate', { url });
    await sleep(600);
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

  // 1. вход через API внутри страницы (cookie ставится как при обычном входе)
  await goto(BASE + '/');
  const loginStatus = await evaluate(
    `fetch('/api/login', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({username:${JSON.stringify(USER)}, password:${JSON.stringify(PASS)}})}).then(r => r.status)`,
  );
  loginStatus === 200 ? ok('вход в сервис') : fail('вход', loginStatus);

  // 2. пустой диалог — именно там видны подсказки «Чем помочь?»
  const target = await evaluate(
    `(async () => {
       const boot = await (await fetch('/api/bootstrap')).json();
       let project = (boot.projects || [])[0];
       const created = !project;
       if (!project) project = (await (await fetch('/api/projects', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({name:'Проверка мобильной версии'})})).json()).project;
       if (!(project.chats || []).length) await fetch('/api/projects/' + project.id + '/chats', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({title:'Мобильная проверка'})});
       return { id: project.id, created };
     })()`,
  );

  async function checkWidth(width, height) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: true });
    await goto(BASE + '/');
    const shown = await waitFor(`!!document.querySelector('.suggestions .suggestion')`);
    if (!shown) {
      fail(`подсказки при ${width}px`, 'карточек нет на экране');
      return;
    }
    const layout = await evaluate(`(() => {
       const box = document.querySelector('.suggestions');
       const cards = [...box.querySelectorAll('.suggestion')].map((node) => {
         const rect = node.getBoundingClientRect();
         return { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), text: node.innerText.trim() };
       });
       return {
         cards,
         columns: getComputedStyle(box).gridTemplateColumns.split(' ').filter(Boolean).length,
         rows: new Set(cards.map((card) => card.y)).size,
         overflow: document.documentElement.scrollWidth - window.innerWidth,
         clipped: [...box.querySelectorAll('.suggestion')].some((node) => node.scrollHeight > node.clientHeight + 1),
         viewport: window.innerWidth,
       };
     })()`);
    layout.cards.length === 4 ? ok(`подсказки при ${width}px: четыре карточки`) : fail(`карточки при ${width}px`, String(layout.cards.length));
    layout.columns === 2 ? ok(`две карточки в ряд при ${width}px`, `ширина ${layout.cards[0].w}px`) : fail(`колонки при ${width}px`, `колонок ${layout.columns}`);
    layout.rows === 2 ? ok(`два ряда при ${width}px`) : fail(`ряды при ${width}px`, `рядов ${layout.rows}`);
    layout.cards[0].x < layout.cards[1].x && layout.cards[0].y === layout.cards[1].y
      ? ok(`первая пара стоит рядом при ${width}px`)
      : fail(`раскладка при ${width}px`, JSON.stringify(layout.cards));
    layout.overflow <= 0 ? ok(`нет горизонтальной прокрутки при ${width}px`) : fail(`переполнение при ${width}px`, `${layout.overflow}px`);
    layout.clipped ? fail(`обрезка текста при ${width}px`, 'текст карточек не влез') : ok(`текст карточек влезает при ${width}px`);
    if (process.env.DSHOW_MOBILE_SHOT) {
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(process.env.DSHOW_MOBILE_SHOT.replace('.png', `-${width}.png`), Buffer.from(shot.data, 'base64'));
    }
  }

  for (const [width, height] of [[390, 844], [360, 780], [320, 640]]) await checkWidth(width, height);

  // 3. уборка: удаляем проект только если создали его сами
  await cdp.send('Emulation.clearDeviceMetricsOverride');
  if (!target.created) {
    ok('чужие проекты не тронуты', 'использован существующий проект');
  } else {
    const cleaned = await evaluate(
      `(async () => {
         const res = await fetch('/api/projects/' + ${JSON.stringify(target.id)}, {method:'DELETE'});
         const boot = await (await fetch('/api/bootstrap')).json();
         return { status: res.status, left: (boot.projects || []).length };
       })()`,
    );
    cleaned.status === 200 ? ok('тестовый проект удалён') : fail('уборка проекта', JSON.stringify(cleaned));
  }
} finally {
  chrome.kill();
  await sleep(400);
  fs.rmSync(profileDir, { recursive: true, force: true });
}

const failed = results.filter((value) => !value).length;
console.log(`\nИтого: ${results.length - failed} ok, ${failed} fail`);
process.exit(failed ? 1 : 0);
