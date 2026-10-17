// Проверка панели «Файлы проекта» в настоящем Chrome через DevTools-протокол (без зависимостей):
//   - файл можно перетащить в панель → он сразу попадает в проект;
//   - файл из панели можно утащить мышью (проверяем полезную нагрузку dragstart);
//   - кнопка загрузки подписана словами, кнопки «Новый workflow» в шапке больше нет;
//   - окно «Новый проект» — только название, создания папок в интерфейсе нет.
//
// Запуск (нужен уже работающий сервер):
//   $env:DSHOW_BASE='http://127.0.0.1:3131'; $env:DSHOW_USER='admin'; $env:DSHOW_PASS='...'
//   node test/ui-dnd.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const BASE = process.env.DSHOW_BASE || 'http://127.0.0.1:3131';
const USER = process.env.DSHOW_USER || 'admin';
const PASS = process.env.DSHOW_PASS || 'Test-pass-2026';
const FILE_NAME = `drag-drop-${Date.now().toString().slice(-6)}.txt`;

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
  console.log(`  FAIL ${name}: ${detail}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------------------- Chrome + CDP ---------------------------- */

const PORT = Number(process.env.DSHOW_CDP_PORT || 9333);
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

  // 1. вход через API внутри страницы (cookie ставится как при обычном входе)
  await goto(BASE + '/');
  const loginStatus = await evaluate(
    `fetch('/api/login', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({username:${JSON.stringify(USER)}, password:${JSON.stringify(PASS)}})}).then(r => r.status)`,
  );
  loginStatus === 200 ? ok('вход в сервис') : fail('вход', loginStatus);

  // 2. проект и диалог, чтобы панель файлов была активна
  await evaluate(
    `(async () => {
       const boot = await (await fetch('/api/bootstrap')).json();
       let project = (boot.projects || [])[0];
       if (!project) project = (await (await fetch('/api/projects', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({name:'Проверка перетаскивания'})})).json()).project;
       if (!(project.chats || []).length) await fetch('/api/projects/' + project.id + '/chats', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({title:'Перетаскивание'})});
       return project.id;
     })()`,
  );
  await goto(BASE + '/');
  const appReady = await waitFor(`!!document.getElementById('app') && !document.getElementById('app').classList.contains('hidden')`);
  appReady ? ok('рабочее окно загрузилось') : fail('окно', 'приложение не показалось');

  // 3. шапка: кнопки «Новый workflow» больше нет, кнопка загрузки подписана словами
  const header = await evaluate(`({
     newWorkflowBtn: !!document.getElementById('newWorkflowBtn'),
     newProjectBtn: !!document.getElementById('newProjectBtn'),
   })`);
  header.newWorkflowBtn === false ? ok('кнопка «Новый workflow» убрана') : fail('кнопка workflow', 'всё ещё в шапке');
  header.newProjectBtn === true ? ok('кнопка «Новый проект» на месте') : fail('кнопка проекта', 'пропала');

  await evaluate(`document.getElementById('filesPanel').classList.contains('hidden') && document.getElementById('filesBtn').click()`);
  await waitFor(`!document.getElementById('filesPanel').classList.contains('hidden')`);
  const uploadLabel = await evaluate(`(document.getElementById('filesUploadLabel') || {}).textContent || ''`);
  uploadLabel.trim() === 'Загрузить файлы'
    ? ok('кнопка загрузки подписана', uploadLabel.trim())
    : fail('подпись кнопки загрузки', JSON.stringify(uploadLabel));

  // 3.5. окно «Новый проект» — только название; создания папок в интерфейсе нет
  await evaluate(`document.getElementById('newProjectBtn').click()`);
  const popoverShown = await waitFor(`!!document.querySelector('.popover')`);
  const popoverShape = popoverShown
    ? await evaluate(`(() => {
        const p = document.querySelector('.popover');
        return { selects: p.querySelectorAll('select').length, inputs: p.querySelectorAll('input').length, text: p.innerText };
      })()`)
    : { selects: -1, inputs: 0, text: '' };
  popoverShape.selects === 0 && popoverShape.inputs === 1
    ? ok('в окне «Новый проект» только название', `полей ввода ${popoverShape.inputs}, списков ${popoverShape.selects}`)
    : fail('окно «Новый проект»', JSON.stringify(popoverShape));
  /workflow|без папки/i.test(popoverShape.text)
    ? fail('текст окна «Новый проект»', 'остался выбор workflow')
    : ok('упоминания workflow в окне нет');
  if (process.env.DSHOW_UI_POPOVER_SHOT) {
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(process.env.DSHOW_UI_POPOVER_SHOT, Buffer.from(shot.data, 'base64'));
    console.log(`  --  снимок окна «Новый проект»: ${process.env.DSHOW_UI_POPOVER_SHOT}`);
  }
  await evaluate(`document.getElementById('newProjectBtn').click()`);
  await waitFor(`!document.querySelector('.popover')`);

  const folderControls = await evaluate(`(() => {
     const list = document.getElementById('projectList');
     const buttons = [...list.querySelectorAll('button')].map((node) => node.innerText.trim()).filter(Boolean);
     return { sidebarAdd: !!document.querySelector('.sidebar-add'), texts: buttons, header: [...document.querySelectorAll('#newProjectBtn, .sidebar-head button')].map((node) => node.innerText.trim()) };
   })()`);
  folderControls.sidebarAdd || folderControls.texts.some((text) => /папк/i.test(text))
    ? fail('создание папок в интерфейсе', JSON.stringify(folderControls))
    : ok('кнопки создания папки нет');

  // 4. перетаскивание файла в панель — подсветка и загрузка в проект
  const dragState = await evaluate(`(() => {
     const panel = document.getElementById('filesPanel');
     const dt = new DataTransfer();
     dt.items.add(new File(['проверка перетаскивания'], ${JSON.stringify(FILE_NAME)}, {type:'text/plain'}));
     window.__dshowDnd = { panel, dt };
     panel.dispatchEvent(new DragEvent('dragenter', {bubbles:true, cancelable:true, dataTransfer: dt}));
     const highlighted = panel.classList.contains('dragover');
     const hint = getComputedStyle(document.getElementById('filesDropHint')).display;
     panel.dispatchEvent(new DragEvent('dragover', {bubbles:true, cancelable:true, dataTransfer: dt}));
     return { highlighted, hint };
   })()`);
  dragState.highlighted ? ok('панель подсвечивается при перетаскивании') : fail('подсветка панели', 'класс dragover не появился');
  dragState.hint !== 'none' ? ok('показана подсказка «Отпустите…»') : fail('подсказка', dragState.hint);

  if (process.env.DSHOW_UI_SHOT) {
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(process.env.DSHOW_UI_SHOT, Buffer.from(shot.data, 'base64'));
    console.log(`  --  снимок состояния перетаскивания: ${process.env.DSHOW_UI_SHOT}`);
  }

  await evaluate(
    `(() => { const { panel, dt } = window.__dshowDnd; panel.dispatchEvent(new DragEvent('drop', {bubbles:true, cancelable:true, dataTransfer: dt})); })()`,
  );

  const appeared = await waitFor(
    `Array.from(document.querySelectorAll('.file-row .f-name')).some((node) => node.textContent === ${JSON.stringify(FILE_NAME)})`,
    12000,
  );
  appeared ? ok('файл из перетаскивания попал в проект', FILE_NAME) : fail('загрузка перетаскиванием', 'файла нет в списке');

  // 5. вытаскивание файла из панели: dragstart должен отдать DownloadURL и ссылку
  const dragOut = await evaluate(`(() => {
     const row = Array.from(document.querySelectorAll('.file-row'))
       .find((node) => (node.querySelector('.f-name') || {}).textContent === ${JSON.stringify(FILE_NAME)});
     if (!row) return { missing: true };
     const dt = new DataTransfer();
     row.dispatchEvent(new DragEvent('dragstart', {bubbles:true, cancelable:true, dataTransfer: dt}));
     const payload = { draggable: row.draggable, types: dt.types, downloadURL: dt.getData('DownloadURL'), uri: dt.getData('text/uri-list') };
     row.dispatchEvent(new DragEvent('dragend', {bubbles:true, dataTransfer: dt}));
     return payload;
   })()`);
  if (dragOut.missing) {
    fail('перетаскивание из панели', 'строка файла не найдена');
  } else {
    dragOut.draggable ? ok('строку файла можно тащить мышью') : fail('draggable', 'строка не помечена');
    /^text\/plain:.+:.+download=1/.test(dragOut.downloadURL || '')
      ? ok('dragstart отдаёт DownloadURL с download=1', String(dragOut.downloadURL).slice(0, 90))
      : fail('DownloadURL', JSON.stringify(dragOut.downloadURL));
    /\/api\/projects\/.+\/file\?path=/.test(dragOut.uri || '')
      ? ok('dragstart отдаёт ссылку text/uri-list')
      : fail('text/uri-list', JSON.stringify(dragOut.uri));
  }

  // 6. уборка: удаляем загруженный файл, чтобы тест не оставлял мусор
  const cleaned = await evaluate(
    `(async () => {
       const boot = await (await fetch('/api/bootstrap')).json();
       const project = (boot.projects || [])[0];
       if (!project) return 'нет проекта';
       const res = await fetch('/api/projects/' + project.id + '/file?path=' + encodeURIComponent(${JSON.stringify(FILE_NAME)}), {method:'DELETE'});
       return res.status;
     })()`,
  );
  cleaned === 200 ? ok('тестовый файл удалён') : fail('уборка', JSON.stringify(cleaned));
} finally {
  chrome.kill();
  await sleep(400);
  fs.rmSync(profileDir, { recursive: true, force: true });
}

const failed = results.filter((value) => !value).length;
console.log(`\nИтого: ${results.length - failed} ok, ${failed} fail`);
process.exit(failed ? 1 : 0);
