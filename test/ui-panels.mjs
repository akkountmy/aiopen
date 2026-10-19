// Проверка раскладки панелей и всплывающих карточек в настоящем Chrome через
// DevTools-протокол (без зависимостей):
//   - панель «Проекты» и панель «Файлы проекта» одинаковой ширины;
//   - в шапке только название диалога, «проект /» убран;
//   - все карточки и меню, вызванные из панели, открываются внутри своей панели
//     и стоят с равными отступами от левой и правой границ блока;
//   - «Новый проект» оформлен как подтверждение удаления: «Отмена» + главная кнопка;
//   - пока правую панель не тянули, она повторяет ширину левой.
//
// Запуск (нужен уже работающий сервер):
//   $env:DSHOW_BASE='http://127.0.0.1:3131'; $env:DSHOW_USER='admin'; $env:DSHOW_PASS='...'
//   node test/ui-panels.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const BASE = process.env.DSHOW_BASE || 'http://127.0.0.1:3131';
const USER = process.env.DSHOW_USER || 'admin';
const PASS = process.env.DSHOW_PASS || 'Test-pass-2026';
const FILE_NAME = `panels-${Date.now().toString().slice(-6)}.txt`;

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

  /* Мерки: рамка элемента и отступы карточки от границ её панели. */
  const MEASURE = `
    const box = (sel) => {
      const node = typeof sel === 'string' ? document.querySelector(sel) : sel;
      if (!node) return null;
      const r = node.getBoundingClientRect();
      return { l: Math.round(r.left), r: Math.round(r.right), w: Math.round(r.width), h: Math.round(r.height) };
    };
    const card = (sel, host) => {
      const c = box(sel);
      const h = box(host);
      if (!c || !h) return null;
      return { ...c, left: c.l - h.l, right: h.r - c.r, host: h.w };
    };
    const buttons = (sel) => [...document.querySelectorAll(sel + ' .btn')].map((b) => ({
      text: b.textContent.trim(),
      kind: b.className,
      h: Math.round(b.getBoundingClientRect().height),
    }));
  `;

  // 1. вход через API внутри страницы
  await goto(BASE + '/');
  const loginStatus = await evaluate(
    `fetch('/api/login', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({username:${JSON.stringify(USER)}, password:${JSON.stringify(PASS)}})}).then(r => r.status)`,
  );
  loginStatus === 200 ? ok('вход в сервис') : fail('вход', loginStatus);

  // 2. проект, диалог и файл — чтобы обе панели были наполнены
  const project = await evaluate(
    `(async () => {
       const boot = await (await fetch('/api/bootstrap')).json();
       let project = (boot.projects || [])[0];
       if (!project) project = (await (await fetch('/api/projects', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({name:'Проверка панелей'})})).json()).project;
       const chats = project.chats || [];
       if (!chats.length) await fetch('/api/projects/' + project.id + '/chats', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({title:'Проверка панелей'})});
       await fetch('/api/projects/' + project.id + '/upload?path=' + encodeURIComponent(${JSON.stringify(FILE_NAME)}), {
         method: 'POST',
         headers: { 'x-filename': encodeURIComponent(${JSON.stringify(FILE_NAME)}) },
         body: 'проверка',
       });
       return project.id;
     })()`,
  );
  await goto(BASE + '/');
  const appReady = await waitFor(`!!document.getElementById('app') && !document.getElementById('app').classList.contains('hidden')`);
  appReady ? ok('рабочее окно загрузилось') : fail('окно', 'приложение не показалось');

  // 3. панели одинаковой ширины
  const panels = await evaluate(`(() => { ${MEASURE}
    return { sidebar: box('.sidebar'), files: box('.files-panel'), main: box('.main'),
             vars: getComputedStyle(document.getElementById('app')).getPropertyValue('--files').trim() + ' | ' +
                   getComputedStyle(document.getElementById('app')).getPropertyValue('--sidebar').trim() };
  })()`);
  const sameWidth = panels.sidebar && panels.files && Math.abs(panels.sidebar.w - panels.files.w) <= 1;
  sameWidth
    ? ok('панели одной ширины', `проекты ${panels.sidebar.w} px, файлы ${panels.files.w} px`)
    : fail('ширина панелей', JSON.stringify(panels));
  panels.vars === `${panels.sidebar && panels.sidebar.w}px | ${panels.sidebar && panels.sidebar.w}px`
    ? ok('переменные раскладки совпадают', panels.vars)
    : fail('--files / --sidebar', panels.vars);

  // 4. в шапке только название диалога
  const crumbs = await evaluate(`({
    project: !!document.querySelector('.crumb-project'),
    sep: !!document.querySelector('.crumb-sep'),
    chat: (document.querySelector('#crumbChat') || {}).textContent || '',
    text: (document.querySelector('.crumbs') || {}).textContent || '',
  })`);
  !crumbs.project && !crumbs.sep
    ? ok('в шапке нет «проект /»', JSON.stringify(crumbs.chat.trim()))
    : fail('шапка', JSON.stringify(crumbs));
  crumbs.chat.trim() && !/\/|проект\s*$/i.test(crumbs.text.trim())
    ? ok('в шапке название диалога')
    : fail('название в шапке', JSON.stringify(crumbs));

  // 5. в корне проекта нет строки «/ проект»
  const filesCrumb = await evaluate(`(() => {
    const node = document.getElementById('filesCrumb');
    return { text: (node.textContent || '').trim(), hidden: node.classList.contains('hidden') || !node.offsetHeight };
  })()`);
  !filesCrumb.text || filesCrumb.hidden
    ? ok('в панели файлов нет строки «проект»', JSON.stringify(filesCrumb.text))
    : fail('строка пути в панели файлов', JSON.stringify(filesCrumb));

  // 6. карточка «Новый проект» — как подтверждение удаления
  await evaluate(`document.getElementById('newProjectBtn').click()`);
  const newShown = await waitFor(`!!document.querySelector('.popover')`);
  const newCard = newShown
    ? await evaluate(`(() => { ${MEASURE}
        const inside = !!document.querySelector('.sidebar .popover.in-panel');
        return { inside, card: card('.popover', '.sidebar'), buttons: buttons('.popover') };
      })()`)
    : { inside: false, card: null, buttons: [] };
  newCard.inside ? ok('карточка «Новый проект» внутри панели проектов') : fail('карточка вне панели', JSON.stringify(newCard.card));
  newCard.card && Math.abs(newCard.card.left - newCard.card.right) <= 2
    ? ok('«Новый проект» стоит ровно по краям панели', `слева ${newCard.card.left}, справа ${newCard.card.right}`)
    : fail('отступы «Нового проекта»', JSON.stringify(newCard.card));
  const newButtons = newCard.buttons.map((b) => b.text).join(' / ');
  newButtons === 'Отмена / Создать проект' && /btn-quiet/.test(newCard.buttons[0].kind) && /btn-primary/.test(newCard.buttons[1].kind)
    ? ok('у «Нового проекта» две кнопки, как у удаления', newButtons)
    : fail('кнопки «Нового проекта»', JSON.stringify(newCard.buttons));
  await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await waitFor(`!document.querySelector('.popover')`);

  // 7. меню проекта — внутри блока, по краям панели
  await evaluate(`document.querySelector('.project-row .row-menu').click()`);
  const menuShown = await waitFor(`!!document.querySelector('.menu')`);
  const menuBox = menuShown
    ? await evaluate(`(() => { ${MEASURE}
        return { inside: !!document.querySelector('.sidebar .menu.in-panel'), card: card('.menu', '.sidebar'),
                 items: [...document.querySelectorAll('.menu button')].map((b) => b.textContent.trim()) };
      })()`)
    : { inside: false, card: null, items: [] };
  menuBox.inside ? ok('меню проекта внутри панели') : fail('меню вне панели', JSON.stringify(menuBox.card));
  menuBox.card && Math.abs(menuBox.card.left - menuBox.card.right) <= 2
    ? ok('меню проекта стоит ровно по краям панели', `слева ${menuBox.card.left}, справа ${menuBox.card.right}`)
    : fail('отступы меню проекта', JSON.stringify(menuBox.card));

  // 8. переименование — та же карточка, а не отдельное окно по центру
  await evaluate(`(() => { const b = [...document.querySelectorAll('.menu button')].find((n) => /Переимен/.test(n.textContent)); if (b) b.click(); })()`);
  const renameShown = await waitFor(`!!document.querySelector('.popover')`);
  const renameCard = renameShown
    ? await evaluate(`(() => { ${MEASURE}
        return { inside: !!document.querySelector('.sidebar .popover.in-panel'), card: card('.popover', '.sidebar'),
                 modal: !!document.querySelector('.modal'), input: (document.querySelector('.popover-input') || {}).value,
                 title: (document.querySelector('.popover-title') || {}).textContent, buttons: buttons('.popover') };
      })()`)
    : { inside: false, card: null, buttons: [], modal: true };
  renameCard.inside && !renameCard.modal
    ? ok('переименование открывается карточкой в панели')
    : fail('переименование', JSON.stringify(renameCard));
  renameCard.card && Math.abs(renameCard.card.left - renameCard.card.right) <= 2 && renameCard.input
    ? ok('переименование по краям панели, имя подставлено', `«${renameCard.input}»`)
    : fail('карточка переименования', JSON.stringify(renameCard));
  await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await waitFor(`!document.querySelector('.popover')`);

  // 9. удаление проекта — подтверждение в том же стиле
  await evaluate(`document.querySelector('.project-row .row-menu').click()`);
  await waitFor(`!!document.querySelector('.menu')`);
  await evaluate(`(() => { const b = [...document.querySelectorAll('.menu button')].find((n) => /Удал/.test(n.textContent)); if (b) b.click(); })()`);
  const confirmShown = await waitFor(`!!document.querySelector('.popover')`);
  const confirmCard = confirmShown
    ? await evaluate(`(() => { ${MEASURE}
        return { inside: !!document.querySelector('.sidebar .popover.in-panel'), card: card('.popover', '.sidebar'),
                 buttons: buttons('.popover'), modal: !!document.querySelector('.modal') };
      })()`)
    : { inside: false, card: null, buttons: [], modal: true };
  confirmCard.inside && !confirmCard.modal && Math.abs((confirmCard.card || {}).left - (confirmCard.card || {}).right) <= 2
    ? ok('подтверждение удаления по краям панели', `слева ${confirmCard.card.left}, справа ${confirmCard.card.right}`)
    : fail('подтверждение удаления', JSON.stringify(confirmCard));
  confirmCard.buttons.length === 2 && /btn-danger/.test(confirmCard.buttons[1].kind)
    ? ok('у удаления две кнопки: отмена и удаление', confirmCard.buttons.map((b) => b.text).join(' / '))
    : fail('кнопки удаления', JSON.stringify(confirmCard.buttons));
  await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await waitFor(`!document.querySelector('.popover')`);

  // 10. удаление файла — карточка в своей панели
  /* Имя файла в строке разбито на основу и расширение (два элемента), поэтому
     innerText отдаёт их с переводом строки — сверяем по textContent строки. */
  const fileRowReady = await waitFor(
    `[...document.querySelectorAll('#filesList .file-row')].some((r) => r.textContent.includes(${JSON.stringify(FILE_NAME)}))`,
  );
  const fileRow = fileRowReady
    ? await evaluate(`(() => {
        const rows = [...document.querySelectorAll('#filesList .file-row')];
        const row = rows.find((r) => r.textContent.includes(${JSON.stringify(FILE_NAME)}));
        if (!row) return false;
        const del = [...row.querySelectorAll('button')].find((b) => /Удалить/.test(b.title));
        if (!del) return false;
        del.click();
        return true;
      })()`)
    : false;
  const fileConfirm = fileRow && (await waitFor(`!!document.querySelector('.files-panel .popover')`))
    ? await evaluate(`(() => { ${MEASURE}
        return { card: card('.popover', '.files-panel'), buttons: buttons('.popover'), modal: !!document.querySelector('.modal'),
                 title: (document.querySelector('.popover-title') || {}).textContent };
      })()`)
    : { card: null, buttons: [], modal: true, row: fileRowReady, rowClicked: fileRow };
  fileConfirm.card && !fileConfirm.modal && Math.abs(fileConfirm.card.left - fileConfirm.card.right) <= 2
    ? ok('удаление файла подтверждается карточкой в панели файлов', `слева ${fileConfirm.card.left}, справа ${fileConfirm.card.right}`)
    : fail('подтверждение удаления файла', JSON.stringify(fileConfirm));
  fileConfirm.card && fileConfirm.buttons.length === 2 && /btn-danger/.test(fileConfirm.buttons[1].kind)
    ? ok('у удаления файла две кнопки: отмена и удаление', fileConfirm.buttons.map((b) => b.text).join(' / '))
    : fail('кнопки удаления файла', JSON.stringify(fileConfirm.buttons));
  await evaluate(`(() => { const b = [...document.querySelectorAll('.files-panel .popover .btn')].find((n) => /Удалить/.test(n.textContent)); if (b) b.click(); })()`);
  const fileGone = await waitFor(
    `![...document.querySelectorAll('#filesList .file-row')].some((r) => r.textContent.includes(${JSON.stringify(FILE_NAME)}))`,
  );
  fileGone && fileRowReady ? ok('файл удалён после подтверждения') : fail('удаление файла', fileRowReady ? 'строка осталась в списке' : 'строки файла не было в панели');

  // 11. правая панель повторяет ширину левой, пока её не тронули
  const dragSidebar = async (key) =>
    evaluate(`(() => {
      const handle = document.getElementById('sidebarResizer');
      handle.focus();
      handle.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true }));
      const app = document.getElementById('app');
      return {
        sidebar: Math.round(document.getElementById('sidebar').getBoundingClientRect().width),
        files: Math.round(document.getElementById('filesPanel').getBoundingClientRect().width),
        main: Math.round(document.querySelector('.main').getBoundingClientRect().width),
        vars: app.style.getPropertyValue('--sidebar').trim() + ' | ' + app.style.getPropertyValue('--files').trim(),
      };
    })()`);
  const before = await dragSidebar('ArrowRight');
  const before2 = await dragSidebar('ArrowRight');
  before.sidebar > panels.sidebar.w && before.files === before.sidebar
    ? ok('левая панель расширилась, правая следом', `проекты ${before.sidebar}, файлы ${before.files}`)
    : fail('расширение панелей', JSON.stringify({ before, before2 }));
  before.main < panels.main.w ? ok('диалог отдал место панелям', `${panels.main.w} → ${before.main}`) : fail('ширина диалога', JSON.stringify(before));

  // 12. своя ширина правой панели и сброс к левой
  const dragged = await evaluate(`(() => {
    const handle = document.getElementById('filesResizer');
    handle.focus();
    handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    return {
      sidebar: Math.round(document.getElementById('sidebar').getBoundingClientRect().width),
      files: Math.round(document.getElementById('filesPanel').getBoundingClientRect().width),
    };
  })()`);
  dragged.files !== dragged.sidebar
    ? ok('правую панель можно тянуть отдельно', `проекты ${dragged.sidebar}, файлы ${dragged.files}`)
    : fail('своя ширина правой панели', JSON.stringify(dragged));
  const WIDTHS = `({
    sidebar: Math.round(document.getElementById('sidebar').getBoundingClientRect().width),
    files: Math.round(document.getElementById('filesPanel').getBoundingClientRect().width),
  })`;
  await evaluate(`document.getElementById('filesResizer').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
  const resetDone = await waitFor(`${WIDTHS}.files === ${WIDTHS}.sidebar`, 3000);
  const reset = await evaluate(WIDTHS);
  resetDone && reset.files === reset.sidebar
    ? ok('двойной щелчок возвращает правую панель к ширине левой', `обе по ${reset.sidebar} px`)
    : fail('сброс правой панели', JSON.stringify({ reset, resetDone }));
  const follows = await dragSidebar('ArrowRight');
  follows.files === follows.sidebar && follows.sidebar === reset.sidebar + 16
    ? ok('после сброса правая панель снова ходит за левой', `проекты ${follows.sidebar}, файлы ${follows.files}`)
    : fail('правая панель не повторяет левую', JSON.stringify(follows));

  // 13. меню учётной записи — у правой границы шапки, а не под кнопкой
  await evaluate(`document.getElementById('userChip').click()`);
  const userMenuShown = await waitFor(`!!document.querySelector('.menu')`);
  const userMenu = userMenuShown
    ? await evaluate(`(() => {
        const bar = document.querySelector('.topbar');
        const menu = document.querySelector('.menu');
        const barRect = bar.getBoundingClientRect();
        const menuRect = menu.getBoundingClientRect();
        return {
          right: Math.round(menuRect.right),
          blockRight: Math.round(barRect.right - (Number.parseFloat(getComputedStyle(bar).paddingRight) || 0)),
          insideBar: !!bar.querySelector('.menu'),
          items: [...menu.querySelectorAll('button')].map((b) => b.textContent.trim()),
        };
      })()`)
    : { right: -1, blockRight: -2, items: [] };
  Math.abs(userMenu.right - userMenu.blockRight) <= 1
    ? ok('меню учётной записи прижато к правой границе шапки', `${userMenu.right} = ${userMenu.blockRight}`)
    : fail('край меню учётной записи', JSON.stringify(userMenu));
  userMenu.items.length >= 3 && /Выйти/.test(userMenu.items.join(' '))
    ? ok('в меню учётной записи те же пункты', userMenu.items.join(' / '))
    : fail('пункты меню учётной записи', JSON.stringify(userMenu.items));
  await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await evaluate(`document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`);
  await waitFor(`!document.querySelector('.menu')`);

  if (process.env.DSHOW_UI_PANELS_SHOT) {
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(process.env.DSHOW_UI_PANELS_SHOT, Buffer.from(shot.data, 'base64'));
    console.log(`  --  снимок: ${process.env.DSHOW_UI_PANELS_SHOT}`);
  }
} catch (error) {
  fail('ход проверки', error.message);
} finally {
  chrome.kill();
  await sleep(400);
  fs.rmSync(profileDir, { recursive: true, force: true });
}

const failed = results.filter((value) => !value).length;
console.log(`\nИтого: ${results.length - failed} ok, ${failed} fail`);
process.exit(failed ? 1 : 0);
