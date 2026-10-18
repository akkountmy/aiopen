// Проверка подсказок в мобильной версии в настоящем Chrome через DevTools-протокол (без зависимостей):
//   - четыре карточки «Чем помочь?» стоят по две в ряд на телефоне (390 px и 320 px);
//   - ничего не вылезает по горизонтали, текст карточек не обрезан;
//   - «Файлы проекта» выезжают таким же ящиком, как «Проекты», и закрываются крестиком.
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
  //    Заводим отдельный проект: сервер отдаёт проекты по updatedAt, поэтому
  //    свежий оказывается первым, и приложение открывает его единственный
  //    (пустой) диалог. Так тест не зависит от того, что уже лежит у пользователя.
  const target = await evaluate(
    `(async () => {
       const project = (await (await fetch('/api/projects', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({name:'Проверка мобильной версии'})})).json()).project;
       await fetch('/api/projects/' + project.id + '/chats', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({title:'Мобильная проверка'})});
       return { id: project.id };
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

  // 3. выезжающие ящики: «Файлы проекта» выезжает так же, как «Проекты»,
  //    того же размера, и закрывается крестиком в своём заголовке.
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await goto(BASE + '/');
  await waitFor(`!!document.getElementById('app') && !document.getElementById('app').classList.contains('hidden')`);
  const DRAWERS = `(() => {
    const box = (selector) => {
      const node = document.querySelector(selector);
      if (!node) return null;
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return {
        left: Math.round(rect.left), right: Math.round(rect.right), width: Math.round(rect.width),
        corners: style.borderRadius.split(' ').filter(Boolean), visibility: style.visibility, display: style.display,
      };
    };
    const app = document.getElementById('app').classList;
    return {
      viewport: window.innerWidth,
      sidebar: box('#sidebar'),
      files: box('#filesPanel'),
      close: box('#filesClose'),
      backdrop: getComputedStyle(document.getElementById('backdrop')).display,
      sidebarOpen: app.contains('sidebar-open'),
      filesOpen: app.contains('files-open'),
    };
  })()`;
  await evaluate(`document.getElementById('sidebarToggle').click()`);
  await waitFor(`document.getElementById('app').classList.contains('sidebar-open')`);
  const sidebarDrawer = await evaluate(DRAWERS);
  await evaluate(`document.getElementById('backdrop').click()`);
  await waitFor(`!document.getElementById('app').classList.contains('sidebar-open')`);
  await evaluate(`document.getElementById('filesBtn').click()`);
  await waitFor(`document.getElementById('app').classList.contains('files-open')`);
  const filesDrawer = await evaluate(DRAWERS);
  const sameWidth = sidebarDrawer.sidebar.width === filesDrawer.files.width;
  sameWidth
    ? ok('ящик файлов той же ширины, что ящик проектов', `${filesDrawer.files.width} px`)
    : fail('ширина ящиков', JSON.stringify({ sidebar: sidebarDrawer.sidebar.width, files: filesDrawer.files.width }));
  filesDrawer.files.right === filesDrawer.viewport && sidebarDrawer.sidebar.left === 0
    ? ok('файлы выезжают справа, проекты — слева')
    : fail('края ящиков', JSON.stringify({ filesRight: filesDrawer.files.right, viewport: filesDrawer.viewport, sidebarLeft: sidebarDrawer.sidebar.left }));
  const mirrored =
    filesDrawer.files.corners[0] === sidebarDrawer.sidebar.corners[1] &&
    filesDrawer.files.corners[3] === sidebarDrawer.sidebar.corners[2];
  mirrored
    ? ok('скругления у ящиков зеркальные', `${filesDrawer.files.corners.join(' ')} / ${sidebarDrawer.sidebar.corners.join(' ')}`)
    : fail('скругления ящиков', JSON.stringify({ files: filesDrawer.files.corners, sidebar: sidebarDrawer.sidebar.corners }));
  filesDrawer.filesOpen && !filesDrawer.sidebarOpen && filesDrawer.backdrop !== 'none'
    ? ok('открыт один ящик, остальное затемнено')
    : fail('состояние ящиков', JSON.stringify(filesDrawer));
  filesDrawer.close && filesDrawer.close.display !== 'none' && filesDrawer.close.width >= 32
    ? ok('в ящике файлов есть крестик', `${filesDrawer.close.width}×${filesDrawer.close.display}`)
    : fail('крестик ящика файлов', JSON.stringify(filesDrawer.close));
  await evaluate(`document.getElementById('filesClose').click()`);
  // visibility переключается по завершении выезда (0,28 s), поэтому ждём её, а не класс.
  const filesClosed = await waitFor(`(() => {
    const panel = document.getElementById('filesPanel');
    if (document.getElementById('app').classList.contains('files-open')) return false;
    return getComputedStyle(panel).visibility === 'hidden';
  })()`);
  const closedState = await evaluate(DRAWERS);
  filesClosed && closedState.files.visibility === 'hidden'
    ? ok('крестик закрывает ящик файлов')
    : fail('закрытие ящика крестиком', JSON.stringify(closedState.files));

  // 3. уборка: свой проект удаляем, чужие не трогаем
  await cdp.send('Emulation.clearDeviceMetricsOverride');
  const cleaned = await evaluate(
    `(async () => {
       const res = await fetch('/api/projects/' + ${JSON.stringify(target.id)}, {method:'DELETE'});
       const boot = await (await fetch('/api/bootstrap')).json();
       return { status: res.status, left: (boot.projects || []).length };
     })()`,
  );
  cleaned.status === 200 ? ok('тестовый проект удалён') : fail('уборка проекта', JSON.stringify(cleaned));
} finally {
  chrome.kill();
  await sleep(400);
  fs.rmSync(profileDir, { recursive: true, force: true });
}

const failed = results.filter((value) => !value).length;
console.log(`\nИтого: ${results.length - failed} ok, ${failed} fail`);
process.exit(failed ? 1 : 0);
