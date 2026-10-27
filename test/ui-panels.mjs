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
import { deleteTestFile, skipOnLive } from './safe-live.mjs';

const BASE = process.env.DSHOW_BASE || 'http://127.0.0.1:3131';
const USER = process.env.DSHOW_USER || 'admin';
const PASS = process.env.DSHOW_PASS || 'Test-pass-2026';
/* Имя не должно попадать под TEST_ARTIFACT в src/tools.mjs: такие файлы сервис
   намеренно прячет из панели, и проверка искала бы невидимую строку. */
const FILE_NAME = `panel-check-${Date.now().toString().slice(-6)}.txt`;
const STAMP = Date.now().toString().slice(-6);
skipOnLive(BASE, 'проверка панелей');

let testProjectId = '';
let pickerProjectId = '';
let pickerFile = '';

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
  const testProject = await evaluate(
    `(async () => {
       const boot = await (await fetch('/api/bootstrap')).json();
       let project = (boot.projects || [])[0];
       if (!project) project = (await (await fetch('/api/projects', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({name:'Проверка панелей'})})).json()).project;
       const chats = project.chats || [];
       if (!chats.length) await fetch('/api/projects/' + project.id + '/chats', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({title:'Проверка панелей'})});
       const up = await fetch('/api/projects/' + project.id + '/upload?path=' + encodeURIComponent(${JSON.stringify(FILE_NAME)}), {
         method: 'POST',
         headers: { 'x-filename': encodeURIComponent(${JSON.stringify(FILE_NAME)}) },
         body: 'проверка',
       });
       if (up.status !== 200) throw new Error('upload ' + up.status);
       return { id: project.id, name: project.name };
     })()`,
  );
  testProjectId = testProject.id;
  await goto(BASE + '/');
  const appReady = await waitFor(`!!document.getElementById('app') && !document.getElementById('app').classList.contains('hidden')`);
  appReady ? ok('рабочее окно загрузилось') : fail('окно', 'приложение не показалось');
  /* Свежий запуск показывает стартовый экран без открытого диалога — чтобы
     проверить шапку и панели, сначала открываем диалог, как это сделал бы человек.
     Диалог открываем именно в том проекте, куда положили файл: на сервере могут
     остаться другие проекты от прошлых проверок, и «первая строка списка» была бы
     чужим диалогом — панель файлов справедливо показала бы чужой проект. */
  const openTestChat = `(() => {
    const block = [...document.querySelectorAll('.project')].find(
      (p) => (p.querySelector('.p-name') || {}).textContent.trim() === ${JSON.stringify(testProject.name)},
    );
    if (!block) return false;
    const chat = block.querySelector('.chat-row .row-main');
    if (chat) { chat.click(); return true; }
    block.querySelector('.project-row .row-main').click();
    return false;
  })()`;
  const chatOpened = await evaluate(openTestChat);
  if (!chatOpened) {
    await sleep(300);
    await evaluate(openTestChat);
  }
  await waitFor(`(document.querySelector('#crumbChat')?.textContent || '').trim().length > 0`);
  await waitFor(
    `[...document.querySelectorAll('#filesList .file-row')].some((row) => row.textContent.includes(${JSON.stringify(FILE_NAME)}))`,
  );

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

  // 5. над кнопкой загрузки нет строки пути «/ проект»
  const filesPath = await evaluate(`(() => {
    const head = document.querySelector('.files-head');
    const actions = document.querySelector('.files-actions');
    const between = [];
    let node = head ? head.nextElementSibling : null;
    while (node && node !== actions) {
      between.push((node.textContent || '').trim());
      node = node.nextElementSibling;
    }
    return { crumb: !!document.getElementById('filesCrumb'), between, slash: between.some((t) => t.includes('/')) };
  })()`);
  !filesPath.crumb && !filesPath.slash
    ? ok('над кнопкой «Загрузить файлы» нет строки пути', JSON.stringify(filesPath.between))
    : fail('строка пути в панели файлов', JSON.stringify(filesPath));

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

  /* 12.5. Шапки панелей и ширина разговора на компьютере.
     «Новый проект» и «Файлы проекта» стоят по центру своих блоков; кнопки
     выгрузки проекта архивом больше нет; лента и поле ввода занимают всю
     ширину между панелями — по 16 px поля с каждой стороны. */
  const heads = await evaluate(`(() => {
    const btn = document.querySelector('.btn-new');
    const title = document.querySelector('.files-title');
    const head = document.querySelector('.files-head');
    const centerOf = (element) => {
      const box = element.getBoundingClientRect();
      const range = document.createRange();
      range.selectNodeContents(element);
      const text = range.getBoundingClientRect();
      const textCenter = (text.left + text.right) / 2;
      const boxCenter = (box.left + box.right) / 2;
      return { offset: Math.round(textCenter - boxCenter), boxWidth: Math.round(box.width) };
    };
    return {
      newCenter: centerOf(btn),
      titleCenter: centerOf(title),
      hasArchive: [...head.querySelectorAll('button')].some((b) => /архив/i.test(b.getAttribute('aria-label') || b.title || '')),
    };
  })()`);
  Math.abs(heads.newCenter.offset) <= 2 && Math.abs(heads.titleCenter.offset) <= 2
    ? ok('подписи «Новый проект» и «Файлы проекта» по центру блоков', `${heads.newCenter.offset} / ${heads.titleCenter.offset} px`)
    : fail('подписи не по центру', JSON.stringify(heads));
  !heads.hasArchive
    ? ok('кнопки «Скачать проект архивом» в шапке нет')
    : fail('кнопка выгрузки архива', 'всё ещё в шапке файлов');

  /* 12.6. Значки: «Новый проект» нарисован как «добавить рабочую область» в
     Harness (заливка в сетке 16 px), а у открытого проекта папка раскрыта —
     у остальных она закрыта и значок тусклее. */
  await evaluate(`(async () => {
    const boot = await (await fetch('/api/bootstrap')).json();
    if ((boot.projects || []).length < 2) {
      await fetch('/api/projects', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ name: 'Второй проект' }) });
    }
    return true;
  })()`);
  await goto(BASE + '/');
  await waitFor(`document.querySelectorAll('.project').length >= 2`);
  const icons = await evaluate(`(() => {
    const btn = document.querySelector('#newProjectBtn svg');
    const rowIcon = (project) => {
      const holder = project.querySelector('.project-row .f-icon');
      const svg = holder ? holder.querySelector('svg') : null;
      return svg ? { viewBox: svg.getAttribute('viewBox'), color: getComputedStyle(holder).color } : null;
    };
    const rows = [...document.querySelectorAll('.project')].map((project) => ({ active: project.classList.contains('active'), ...rowIcon(project) }));
    /* Значок в шапке панели «Файлы проекта» — раскрытая папка Harness (сетка
       16, заливка). Кнопка-ящик в шапке сервиса нарисована той же папкой, чтобы
       раздел читался как один, а не как два разных. */
    const folder = (svg, openStartsWith) => {
      if (!svg) return null;
      const path = svg.querySelector('path');
      const box = svg.getBoundingClientRect();
      const style = getComputedStyle(svg);
      return {
        viewBox: svg.getAttribute('viewBox'),
        fill: style.fill,
        stroke: style.stroke,
        strokeWidth: style.strokeWidth,
        size: Math.round(box.width * 10) / 10,
        paths: svg.querySelectorAll('path').length,
        opens: Boolean(path) && path.getAttribute('d').startsWith(openStartsWith),
      };
    };
    /* Ряд значков в шапке сервиса: у всех один штрих и один размер. Шеврон у
       профиля — не значок кнопки, а указатель «здесь раскрывается список». */
    const headerIcons = [...document.querySelectorAll('.topbar-right svg')]
      .filter((svg) => svg.getBoundingClientRect().width > 0 && !svg.classList.contains('chev'))
      .map((svg) => ({
        id: svg.closest('button') ? svg.closest('button').id : '',
        size: Math.round(svg.getBoundingClientRect().width * 10) / 10,
        strokeWidth: getComputedStyle(svg).strokeWidth,
        fill: getComputedStyle(svg).fill,
      }));
    return {
      button: btn ? { viewBox: btn.getAttribute('viewBox'), fill: getComputedStyle(btn).fill, stroke: getComputedStyle(btn).stroke } : null,
      active: rows.find((row) => row.active) || null,
      other: rows.find((row) => !row.active) || null,
      headerIcons,
      filesTitle: folder(document.querySelector('.files-title svg'), 'M5.19629'),
      filesToggle: folder(document.querySelector('#filesBtn svg'), 'M5.19629'),
    };
  })()`);
  icons.button && icons.button.viewBox === '0 0 16 16' && icons.button.fill !== 'none' && icons.button.stroke === 'none'
    ? ok('значок «Новый проект» — как «добавить рабочую область» в Harness', `сетка ${icons.button.viewBox}, заливка ${icons.button.fill}`)
    : fail('значок «Новый проект»', JSON.stringify(icons.button));
  icons.active && icons.active.viewBox === '0 0 24 24' && icons.other && icons.other.viewBox === '0 0 20 20'
    ? ok('у открытого проекта папка раскрыта, у остальных закрыта')
    : fail('значок открытого проекта', JSON.stringify({ active: icons.active, other: icons.other }));
  icons.active && icons.other && icons.active.color !== icons.other.color
    ? ok('значок открытого проекта заметнее закрытых', `${icons.active.color} против ${icons.other.color}`)
    : fail('яркость значка открытого проекта', JSON.stringify({ active: icons.active, other: icons.other }));
  const openFolder = (icon) => Boolean(icon) && icon.viewBox === '0 0 16 16' && icon.paths === 1 && icon.opens;
  openFolder(icons.filesTitle) && icons.filesTitle.fill !== 'none' && icons.filesTitle.stroke === 'none'
    ? ok('значок «Файлы проекта» — раскрытая папка в наборе Harness', `сетка ${icons.filesTitle.viewBox}, заливка ${icons.filesTitle.fill}`)
    : fail('значок «Файлы проекта»', JSON.stringify(icons.filesTitle));
  icons.filesToggle && openFolder(icons.filesToggle) && icons.filesToggle.fill !== 'none' && icons.filesToggle.stroke === 'none'
    ? ok('папка в шапке — та же залитая иконка, что в панели', `сетка ${icons.filesToggle.viewBox}, заливка ${icons.filesToggle.fill}`)
    : fail('значок ящика файлов', JSON.stringify(icons.filesToggle));
  /* Контурные значки шапки сервиса — один размер и одна толщина линии 2 px.
     Штрих задан через non-scaling-stroke, поэтому не зависит от масштаба сетки
     (20 px) и размера значка: раньше 1,8 на 24 px давал 2,16 px. */
  const headerLine = icons.headerIcons.filter((icon) => icon.id !== 'filesBtn');
  const headerSizes = [...new Set(headerLine.map((icon) => icon.size))];
  const headerStrokes = [...new Set(headerLine.map((icon) => icon.strokeWidth))];
  headerLine.length >= 3 && headerSizes.length === 1 && headerStrokes.length === 1 && headerStrokes[0] === '2px'
    ? ok('контурные значки шапки одного размера и штриха', `${headerLine.length} значка по ${headerSizes[0]} px, штрих ${headerStrokes[0]}`)
    : fail('значки шапки разной толщины', JSON.stringify(icons.headerIcons));

  /* «Дашборд» на компьютере — только значок, без подписи: кнопка стоит в ряду
     таких же квадратных значков и не шире соседей. */
  const dashState = await evaluate(`(() => {
    const btn = document.getElementById('dashboardBtn');
    const label = btn.querySelector('.dash-btn-label');
    const icon = document.getElementById('themeToggle');
    const box = (node) => Math.round(node.getBoundingClientRect().width);
    return {
      text: btn.innerText.trim(),
      label: label ? getComputedStyle(label).display : 'нет в разметке',
      width: box(btn),
      iconWidth: box(icon),
      height: Math.round(btn.getBoundingClientRect().height),
      title: btn.title,
    };
  })()`);
  dashState.text === '' && dashState.label !== 'inline' && dashState.width === dashState.iconWidth && dashState.title
    ? ok('«Дашборд» на компьютере — только значок', `${dashState.width} px, как у соседних кнопок`)
    : fail('подпись у кнопки «Дашборд»', JSON.stringify(dashState));

  /* 12.7. Заголовок «Файлы проекта» — подпись, а не кнопка выбора проекта:
     файлы всегда принадлежат проекту, открытому слева, и панель идёт за ним.
     Раньше ручной выбор в заголовке расходился с активным проектом, и фоновая
     сверка подменяла список — файлы «пропадали» через несколько секунд.
     Крестика закрытия в шапке панели нет. */
  const PICK_FILE = `picker-check-${STAMP}.txt`;
  pickerFile = PICK_FILE;
  const pickerSetup = await evaluate(`(async () => {
    const boot = await (await fetch('/api/bootstrap')).json();
    const activeNode = document.querySelector('.project.active .p-name');
    const current = activeNode ? activeNode.textContent.trim() : '';
    const other = (boot.projects || []).find((project) => project.name !== current);
    if (!other) return { missing: true };
    await fetch('/api/projects/' + other.id + '/upload?path=' + encodeURIComponent(${JSON.stringify(PICK_FILE)}), {
      method: 'POST',
      headers: { 'x-filename': encodeURIComponent(${JSON.stringify(PICK_FILE)}) },
      body: 'файл другого проекта',
    });
    return { other: other.name, otherId: other.id, current };
  })()`);
  if (pickerSetup.missing) {
    fail('заголовок панели файлов', 'нет второго проекта');
  } else {
    pickerProjectId = pickerSetup.otherId;
    const noClose = await evaluate(`!document.getElementById('filesClose')`);
    noClose
      ? ok('крестика закрытия в шапке панели файлов нет')
      : fail('крестик панели файлов', 'ещё в разметке');
    const header = await evaluate(`(() => {
      const title = document.getElementById('filesProjectTitle');
      const label = document.getElementById('filesProjectName');
      return {
        tag: title ? title.tagName : '',
        text: label ? label.textContent : '',
        cursor: title ? getComputedStyle(title).cursor : '',
        chev: Boolean(document.querySelector('.files-title .chev')),
        expanded: title ? title.getAttribute('aria-expanded') : null,
        hasOldButton: Boolean(document.getElementById('filesProjectBtn')),
      };
    })()`);
    header.tag === 'DIV' &&
    !header.hasOldButton &&
    !header.chev &&
    header.expanded === null &&
    header.text === 'Файлы проекта' &&
    header.cursor === 'default'
      ? ok('заголовок панели — подпись «Файлы проекта», выбора проекта в нём нет')
      : fail('заголовок панели файлов', JSON.stringify(header));
    await evaluate(`document.getElementById('filesProjectTitle').click()`);
    await sleep(400);
    const noMenu = await evaluate(`!document.querySelector('.files-panel .menu')`);
    noMenu
      ? ok('нажатие на заголовок не открывает список проектов')
      : fail('меню в панели файлов', 'появилось по нажатию заголовка');

    /* Файлы панели ходят за проектом, который открыт слева: чужой файл не
       виден, пока не открыт его проект, и появляется сразу после нажатия. */
    const fileVisible = `[...document.querySelectorAll('#filesList .file-row')].some((r) => r.textContent.includes(${JSON.stringify(PICK_FILE)}))`;
    const beforePick = await evaluate(fileVisible);
    !beforePick
      ? ok('чужого файла в панели нет до выбора проекта слева')
      : fail('файл другого проекта виден заранее', PICK_FILE);
    const openProject = (name) => `(() => {
      const row = [...document.querySelectorAll('.project')].find((project) => {
        const label = project.querySelector('.p-name');
        return label && label.textContent.trim() === ${JSON.stringify(name)};
      });
      if (!row) return false;
      row.querySelector('.project-row').click();
      return true;
    })()`;
    const picked = await evaluate(openProject(pickerSetup.other));
    const switched =
      picked &&
      (await waitFor(
        `(() => {
          const active = document.querySelector('.project.active .p-name');
          if (!active || active.textContent.trim() !== ${JSON.stringify(pickerSetup.other)}) return false;
          return ${fileVisible};
        })()`,
        10000,
      ));
    switched
      ? ok('проект, открытый слева, показывает в панели свои файлы', pickerSetup.other)
      : fail(
          'переключение проекта в панели',
          await evaluate(`(document.getElementById('filesList') || {}).innerText || ''`),
        );

    /* Фоновая сверка с сервером (раз в 20 секунд) не должна подменять список
       файлами другого проекта — это и был баг «файлы пропадают». */
    await evaluate(`window.dispatchEvent(new Event('focus'))`);
    await sleep(1500);
    const afterSync = await evaluate(`(() => {
      const active = document.querySelector('.project.active .p-name');
      return {
        active: active ? active.textContent.trim() : '',
        hasFile: ${fileVisible},
        title: (document.getElementById('filesProjectName') || {}).textContent || '',
      };
    })()`);
    afterSync.active === pickerSetup.other && afterSync.hasFile && afterSync.title === 'Файлы проекта'
      ? ok('фоновая сверка с сервером не подменяет файлы панели')
      : fail('файлы панели после фоновой сверки', JSON.stringify(afterSync));

    /* Возвращаемся к прежнему проекту: панель снова показывает его файлы. */
    await evaluate(openProject(pickerSetup.current));
    const backAgain = await waitFor(
      `(() => {
        const active = document.querySelector('.project.active .p-name');
        if (!active || active.textContent.trim() !== ${JSON.stringify(pickerSetup.current)}) return false;
        return !${fileVisible};
      })()`,
      10000,
    );
    backAgain
      ? ok('возврат к прежнему проекту показывает его файлы')
      : fail('возврат проекта в панели', pickerSetup.current);
  }
  const wide = await evaluate(`(() => {
    const main = document.querySelector('.main');
    const thread = document.querySelector('.thread');
    const composer = document.querySelector('.composer');
    const style = getComputedStyle(thread);
    const box = (element) => Math.round(element.getBoundingClientRect().width);
    return {
      main: box(main),
      thread: box(thread),
      threadPad: Math.round(Number.parseFloat(style.paddingLeft)) + Math.round(Number.parseFloat(style.paddingRight)),
      composer: box(composer),
      desktop: window.innerWidth >= 1101,
    };
  })()`);
  wide.desktop && wide.thread === wide.main && wide.threadPad === 32 && wide.composer === wide.main - 32
    ? ok('на компьютере лента и поле ввода занимают всю ширину, поля по 16 px', `лента ${wide.thread}, ввод ${wide.composer}`)
    : fail('ширина разговора на компьютере', JSON.stringify(wide));

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

  /* 14. Порядок в панели «Проекты» — по времени создания, а не по последнему
     диалогу: работа в проекте не должна переставлять папки и диалоги. */
  const orderNames = [`Начало-${STAMP}`, `Середина-${STAMP}`, `Конец-${STAMP}`];
  const orderSetup = await evaluate(`(async () => {
    const names = ${JSON.stringify(orderNames)};
    const created = [];
    for (const name of names) {
      const data = await (await fetch('/api/projects', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }),
      })).json();
      const project = data.project;
      created.push(project.id);
      for (const title of ['Диалог 1', 'Диалог 2']) {
        await fetch('/api/projects/' + project.id + '/chats', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title }),
        });
      }
    }
    return created;
  })()`);
  await goto(BASE + '/');
  await waitFor(`document.querySelectorAll('.project').length >= 3`);
  const orderOfMine = () =>
    evaluate(`[...document.querySelectorAll('.project .p-name')]
      .map((node) => node.textContent.trim())
      .filter((name) => /-${STAMP}$/.test(name))`);
  const orderBefore = await orderOfMine();
  const orderOk = orderBefore.length === 3 && orderBefore.every((name, index) => name === orderNames[index]);
  orderOk
    ? ok('проекты идут в порядке создания', orderBefore.join(' / '))
    : fail('порядок проектов до работы', JSON.stringify(orderBefore));

  /* Работаем в проекте из середины списка: диалог и переименование обновляют
     дату изменения — раньше из-за этого проект уезжал наверх. */
  const orderTouched = await evaluate(`(async () => {
    const boot = await (await fetch('/api/bootstrap')).json();
    const project = (boot.projects || []).find((p) => p.name === ${JSON.stringify(orderNames[1])});
    if (!project) return { missing: true };
    const chats = project.chats || [];
    if (chats.length) {
      await fetch('/api/chats/' + chats[0].id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'Диалог 1 (обновлён)' }) });
    }
    await fetch('/api/projects/' + project.id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: ${JSON.stringify(orderNames[1])} }) });
    const again = await (await fetch('/api/bootstrap')).json();
    return { chats: (again.projects || []).find((p) => p.id === project.id).chats.map((c) => c.title) };
  })()`);
  await goto(BASE + '/');
  await waitFor(`document.querySelectorAll('.project').length >= 3`);
  const orderAfter = await orderOfMine();
  orderAfter.length === 3 && orderAfter.every((name, index) => name === orderNames[index])
    ? ok('после работы в проекте порядок не изменился', orderAfter.join(' / '))
    : fail('порядок проектов после работы', JSON.stringify({ before: orderBefore, after: orderAfter }));
  /* Новый диалог встаёт в конец списка, а не наверх. */
  const chatOrder = !orderTouched.missing && Array.isArray(orderTouched.chats)
    ? orderTouched.chats
    : [];
  chatOrder.length === 2 && /Диалог 2/.test(chatOrder[1]) && /Диалог 1/.test(chatOrder[0])
    ? ok('диалоги идут в порядке создания', chatOrder.join(' / '))
    : fail('порядок диалогов', JSON.stringify(chatOrder));

  /* 15. Дашборд на компьютере занимает место ленты: лента и поле ввода скрыты,
     дашборд на экране, горизонтальной прокрутки нет. Колонка файлов при этом
     остаётся рабочей — рядом с дашбордом её видно, а на телефоне это выезжающий
     ящик (см. test/ui-mobile.mjs). Проверяем саму подмену и чистый возврат. */
  await evaluate(`document.getElementById('dashboardBtn').click()`);
  await waitFor(`document.getElementById('app').classList.contains('dash-open')`);
  const dashDesktop = await evaluate(`(() => {
    const view = document.getElementById('dashboardView');
    return {
      scrollDisplay: getComputedStyle(document.querySelector('.scroll')).display,
      filesDisplay: getComputedStyle(document.getElementById('filesPanel')).display,
      dashWidth: Math.round(view.getBoundingClientRect().width),
      overflow: document.documentElement.scrollWidth - window.innerWidth,
      viewport: window.innerWidth,
    };
  })()`);
  dashDesktop.scrollDisplay === 'none' && dashDesktop.dashWidth > 300 && dashDesktop.overflow <= 0
    ? ok('дашборд на компьютере занимает место ленты', `дашборд ${dashDesktop.dashWidth}px, ящик файлов: ${dashDesktop.filesDisplay}`)
    : fail('дашборд на компьютере', JSON.stringify(dashDesktop));
  await evaluate(`document.getElementById('dashboardBtn').click()`);
  await waitFor(`!document.getElementById('app').classList.contains('dash-open')`);
  const afterDash = await evaluate(`(() => ({
    scrollDisplay: getComputedStyle(document.querySelector('.scroll')).display,
    filesDisplay: getComputedStyle(document.getElementById('filesPanel')).display,
  }))()`);
  afterDash.scrollDisplay !== 'none' && afterDash.filesDisplay !== 'none'
    ? ok('после дашборда лента и панель файлов возвращаются')
    : fail('после дашборда', JSON.stringify(afterDash));

  /* Уборка за собой: созданные для проверки порядка проекты не нужны. */
  await evaluate(`(async () => {
    const boot = await (await fetch('/api/bootstrap')).json();
    for (const project of boot.projects || []) {
      if (/-${STAMP}$/.test(String(project.name || ''))) {
        await fetch('/api/projects/' + project.id, { method: 'DELETE' });
      }
    }
    return true;
  })()`);

  if (process.env.DSHOW_UI_PANELS_SHOT) {
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(process.env.DSHOW_UI_PANELS_SHOT, Buffer.from(shot.data, 'base64'));
    console.log(`  --  снимок: ${process.env.DSHOW_UI_PANELS_SHOT}`);
  }
} catch (error) {
  fail('ход проверки', error.message);
} finally {
  await deleteTestFile(BASE, USER, PASS, testProjectId, FILE_NAME).catch(() => {});
  await deleteTestFile(BASE, USER, PASS, pickerProjectId, pickerFile).catch(() => {});
  chrome.kill();
  await sleep(400);
  fs.rmSync(profileDir, { recursive: true, force: true });
}

const failed = results.filter((value) => !value).length;
console.log(`\nИтого: ${results.length - failed} ok, ${failed} fail`);
process.exit(failed ? 1 : 0);
