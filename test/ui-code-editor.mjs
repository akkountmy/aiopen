// Проверка окна правки в панели «Файлы проекта» через DevTools-протокол
// (без зависимостей, как остальные ui-*.mjs):
//   - дизайн-проект только смотрится: у панели нет «Править», у design.json и
//     листов нет кнопки правки, сервер отвечает 403 на запись;
//   - обычный текстовый файл открывается из просмотра кнопкой «Править»;
//   - текст в поле ввода совпадает с подсвеченным слоем символ в символ, кегль,
//     высота строки и отступы у них одинаковые (иначе каретка уезжает от букв);
//   - нумерация строк совпадает с числом строк файла;
//   - Ctrl+S сохраняет файл, «Версии» возвращают прошлое содержимое;
//   - закрытие с несохранёнными правками спрашивает прямо в окне и не теряет
//     текст, если человек передумал;
//   - на телефоне окно занимает весь экран, поле не мельче 16 px (иначе iOS
//     увеличивает страницу), горизонтальной прокрутки страницы нет;
//   - на странице нет ошибок в консоли.
//
// Запуск (нужен уже работающий сервер с проектом, где есть design.json):
//   $env:DSHOW_BASE='http://127.0.0.1:3131'; $env:DSHOW_USER='demo'; $env:DSHOW_PASS='demo-pass-123'
//   node test/ui-code-editor.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const BASE = process.env.DSHOW_BASE || 'http://127.0.0.1:3131';
const USER = process.env.DSHOW_USER || 'admin';
const PASS = process.env.DSHOW_PASS || 'Test-pass-2026';
const OUT = process.env.DSHOW_SHOT_DIR || '';

const CHROME_CANDIDATES = [
  path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
];
const CHROME = CHROME_CANDIDATES.find((candidate) => fs.existsSync(candidate));
if (!CHROME) {
  console.log('  --  Chrome/Edge не найден, проверка редактора кода пропущена');
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

const PORT = Number(process.env.DSHOW_CDP_PORT || 9339);
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshow-code-'));
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

const consoleErrors = [];

function connect(wsUrl) {
  const socket = new WebSocket(wsUrl);
  let nextId = 1;
  const pending = new Map();
  socket.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.method === 'Runtime.exceptionThrown') {
      const detail = msg.params.exceptionDetails;
      consoleErrors.push(`исключение: ${detail.exception?.description || detail.text}`);
      return;
    }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      consoleErrors.push(`console.error: ${msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ')}`);
      return;
    }
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

/* Всё, что нужно проверкам окна, — одним запросом. */
const MEASURE = `(() => {
  const modal = document.querySelector('#modalRoot .modal.code-modal');
  if (!modal) return null;
  const area = modal.querySelector('.code-input');
  const hl = modal.querySelector('.code-hl code');
  const gutter = modal.querySelector('.code-gutter-in');
  const status = modal.querySelector('.code-status');
  const ask = modal.querySelector('.code-ask.is-open');
  const img = modal.querySelector('.code-preview-img');
  const frame = modal.querySelector('.code-preview-frame');
  const rect = modal.getBoundingClientRect();
  const sa = getComputedStyle(area);
  const sh = getComputedStyle(hl);
  const sm = getComputedStyle(modal);
  const lines = area.value.split(String.fromCharCode(10)).length;
  return {
    inner: { w: innerWidth, h: innerHeight },
    rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
    radius: sm.borderTopLeftRadius,
    previewOn: modal.classList.contains('preview-on'),
    tabs: [...modal.querySelectorAll('.code-tab')].map((t) => ({
      name: (t.querySelector('.code-tab-name') || {}).textContent || '',
      active: t.classList.contains('is-active'),
      dot: Boolean(t.querySelector('.code-tab-dot')),
    })),
    value: area.value,
    readonly: area.readOnly,
    font: { area: [sa.fontFamily, sa.fontSize, sa.lineHeight, sa.letterSpacing].join(' / '), hl: [sh.fontFamily, sh.fontSize, sh.lineHeight, sh.letterSpacing].join(' / ') },
    padding: { area: sa.padding, hl: sh.padding },
    hlText: hl ? hl.textContent : null,
    gutter: { count: gutter.querySelectorAll('.code-line').length, last: (gutter.querySelector('.code-line:last-child') || {}).textContent || '' },
    lines,
    status: { text: (status.querySelector('.code-status-text') || status).textContent, ok: status.classList.contains('is-ok'), bad: status.classList.contains('is-bad'), dirty: status.classList.contains('is-dirty') },
    ask: ask ? ask.textContent : null,
    path: (modal.querySelector('.code-path') || {}).textContent || '',
    meta: (modal.querySelector('.code-meta') || {}).textContent || '',
    img: img ? { w: img.naturalWidth, h: img.naturalHeight } : null,
    frame: frame ? frame.getAttribute('src') : null,
    previewTitle: (modal.querySelector('.code-preview-title') || {}).textContent || '',
    summary: [...modal.querySelectorAll('.code-summary-row')].map((row) => row.textContent),
    summaryRooms: modal.querySelectorAll('.code-summary-list li').length,
    tools: [...modal.querySelectorAll('.code-tool')].filter((b) => !b.classList.contains('hidden')).map((b) => ({ label: b.textContent, disabled: b.disabled, on: b.classList.contains('is-on') })),
    quickHidden: modal.querySelector('.code-quick').classList.contains('hidden'),
    overflowX: document.documentElement.scrollWidth - innerWidth,
  };
})()`;

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
    await sleep(700);
  }
  async function waitFor(expression, timeoutMs = 12000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        if (await evaluate(expression)) return true;
      } catch {
        /* страница ещё грузится */
      }
      await sleep(150);
    }
    return false;
  }
  async function shot(name) {
    if (!OUT) return;
    fs.mkdirSync(OUT, { recursive: true });
    const data = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT, name), Buffer.from(data.data, 'base64'));
  }
  async function ctrlS() {
    const base = { modifiers: 2, key: 's', code: 'KeyS', windowsVirtualKeyCode: 83, nativeVirtualKeyCode: 83 };
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  }
  async function ctrlKey(key, code, vk, modifiers = 2) {
    const base = { modifiers, key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk };
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  }
  /* Ставим курсор в конец текста и печатаем: так проверяется тот же путь, что
     у человека, — событие input, своя отмена и подсветка. */
  async function typeAtEnd(text) {
    await evaluate(`(() => {
      const area = document.querySelector('#modalRoot .modal.code-modal .code-input');
      area.focus();
      area.setSelectionRange(area.value.length, area.value.length);
    })()`);
    await cdp.send('Input.insertText', { text });
    await sleep(180);
  }
  async function clickByText(selector, label) {
    return evaluate(`(() => {
      const node = [...document.querySelectorAll(${JSON.stringify(selector)})]
        .find((item) => item.textContent.trim() === ${JSON.stringify(label)} && item.offsetParent !== null);
      if (!node) return false;
      node.click();
      return true;
    })()`);
  }
  async function fileText(projectId, relPath) {
    return evaluate(`fetch('/api/projects/${projectId}/file-text?path=' + encodeURIComponent(${JSON.stringify(relPath)}))
      .then((r) => r.json()).then((d) => ({ editable: d.editable, text: d.text, hash: d.hash, bytes: d.bytes }))`);
  }
  /* Открываем файл из панели так же, как человек: на компьютере двойным
     щелчком, в мобильной эмуляции — одним касанием. */
  async function openPreviewOf(name, touch = false) {
    const clicked = await evaluate(`(() => {
      const row = [...document.querySelectorAll('#filesList .file-row')]
        .find((item) => item.textContent.includes(${JSON.stringify(name)}));
      if (!row) return false;
      const main = row.querySelector('.row-main');
      if (${touch ? 'true' : 'false'}) main.click();
      else main.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
      return true;
    })()`);
    return Boolean(clicked) && (await waitFor(`!!document.querySelector('#modalRoot .modal.file-preview-modal')`, 8000));
  }
  async function deleteFile(projectId, relPath) {
    return evaluate(`fetch('/api/projects/${projectId}/file?path=' + encodeURIComponent(${JSON.stringify(relPath)}), { method: 'DELETE' }).then((r) => r.status)`);
  }

  await goto(BASE + '/');
  await evaluate(
    `fetch('/api/login', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({username:${JSON.stringify(USER)}, password:${JSON.stringify(PASS)}})}).then(r => r.status)`,
  );
  await goto(BASE + '/');

  /* Берём проект с дизайном, если он есть: на нём проверяется запрет правки.
     Если дизайна нет ни в одном проекте, остаётся обычный проект и проверка
     самого окна правки. */
  const picked = await evaluate(`(async () => {
    const projects = (await fetch('/api/bootstrap').then((r) => r.json())).projects || [];
    for (const project of projects) {
      const data = await fetch('/api/projects/' + encodeURIComponent(project.id) + '/design')
        .then((r) => r.json()).catch(() => ({}));
      if (data && data.design && data.design.hasSpec) return { id: project.id, name: project.name };
    }
    return projects[0] ? { id: projects[0].id, name: projects[0].name } : null;
  })()`);
  if (!picked) throw new Error('в сервисе нет проекта — проверять нечего');
  const projectId = picked.id;

  /* Дизайн-проект — только для просмотра: сервер не отдаёт его в редактор и не
     принимает запись. Если спека в проекте нет, эту часть пропускаем: редактор
     обычных файлов от дизайна не зависит. */
  const designText = await fileText(projectId, 'design.json');
  const design = await evaluate(`fetch('/api/projects/${projectId}/design').then((r) => r.json()).then((d) => Boolean(d.design && d.design.hasSpec))`);
  const designWrite = await evaluate(`fetch('/api/projects/${projectId}/file-text', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: 'design/editor-check.svg', text: '<svg/>', force: true }),
  }).then((r) => r.json().then((d) => ({ status: r.status, error: d.error })))`);
  if (design) {
    designText.editable === false && designWrite.status === 403
      ? ok('дизайн-проект закрыт от ручной правки', `чтение editable=${designText.editable}, запись ${designWrite.status}`)
      : fail('запрет правки дизайна', JSON.stringify({ editable: designText.editable, write: designWrite }));
  } else {
    console.log('  --  в проекте нет design.json — проверка запрета правки дизайна пропущена');
  }

  /* Файл для проверки самого окна правки: обычный текст, не дизайн. */
  const scratch = await evaluate(`fetch('/api/projects/${projectId}/upload', {
    method: 'POST', headers: { 'x-filename': 'editor-check.md', 'Content-Type': 'text/markdown' },
    body: '# Проверка редактора\\n\\nПервая строка.\\n',
  }).then((r) => r.json())`);
  if (!scratch || !scratch.path) throw new Error('проверочный файл не загрузился');
  const scratchText = await fileText(projectId, scratch.path);
  console.log(`  --  проект ${projectId}, проверочный файл ${scratch.path} (${scratchText.bytes} Б)\n`);
  await goto(BASE + '/');

  /* ---------------------------- компьютер ---------------------------- */
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

  const activated = await evaluate(`(() => {
    const row = [...document.querySelectorAll('#projectList .project .row-main')]
      .find((item) => item.querySelector('.p-name') && item.querySelector('.p-name').textContent === ${JSON.stringify(picked.name)});
    if (!row) return false;
    row.click();
    return true;
  })()`);
  if (!activated) throw new Error('проект с дизайном не нашёлся в списке проектов');
  await waitFor(`(() => {
    const row = document.querySelector('#filesList .file-row');
    return Boolean(row) && row.textContent.includes(${JSON.stringify(scratch.path.split('/').pop())});
  })()`, 12000);
  if (design) await waitFor(`document.querySelectorAll('.design-card').length > 0`, 9000);

  const designPanelState = await evaluate(`(() => {
    const panel = document.getElementById('designPanel');
    return {
      shown: Boolean(panel) && !panel.classList.contains('hidden'),
      cards: document.querySelectorAll('.design-card').length,
      edit: Boolean(document.getElementById('designEditBtn')),
      build: Boolean(document.getElementById('designBuildBtn')),
    };
  })()`);
  if (design) {
    designPanelState.shown && designPanelState.cards > 0 && designPanelState.build && !designPanelState.edit
      ? ok('в панели дизайна осталась сборка, а правки нет', `${designPanelState.cards} листов`)
      : fail('панель дизайна без кнопки правки', JSON.stringify(designPanelState));

    /* «Пересобрать» остаётся рабочим: листы обновляются из сохранённого спека. */
    await evaluate(`document.getElementById('designBuildBtn').click()`);
    const rebuilt = await waitFor(`/Листы обновлены/.test((document.getElementById('designNote') || {}).textContent || '')`, 30000);
    rebuilt
      ? ok('«Пересобрать» обновляет листы без редактора')
      : fail('пересборка листов', (await evaluate(`(document.getElementById('designNote') || {}).textContent || ''`)).slice(0, 160));
  }

  /* Обычный текстовый файл открывается из панели и правится из просмотра. */
  const previewOk = await openPreviewOf(scratch.path, false);
  const previewEdit = await evaluate(`[...document.querySelectorAll('#modalRoot .modal-foot .btn')].some((b) => b.textContent.trim() === 'Править')`);
  previewOk && previewEdit
    ? ok('у обычного текстового файла в просмотре есть «Править»')
    : fail('кнопка «Править» у обычного файла', JSON.stringify({ previewOk, previewEdit }));
  await clickByText('#modalRoot .modal-foot .btn', 'Править');
  const opened = await waitFor(`(() => {
    const area = document.querySelector('#modalRoot .modal.code-modal .code-input');
    return Boolean(area) && !area.readOnly && area.value.length > 0;
  })()`);
  if (!opened) throw new Error('редактор не открылся или не прочитал файл');
  await sleep(320);
  const m = await evaluate(MEASURE);
  await shot('code-desktop.png');

  /* 1. Одна вкладка — открытый файл. */
  const tabName = scratch.path.split('/').pop();
  const scratchTab = m.tabs.find((tab) => tab.name === tabName);
  scratchTab && scratchTab.active && m.tabs.length === 1
    ? ok('в окне вкладка открытого файла', m.tabs.map((t) => t.name).join(', '))
    : fail('вкладки окна правки', JSON.stringify(m.tabs));
  m.path === scratch.path && /Markdown/.test(m.meta)
    ? ok('подпись и язык файла на месте', m.meta)
    : fail('подпись файла', JSON.stringify({ path: m.path, meta: m.meta }));

  /* 2. Слой подсветки и поле ввода совпадают: кегль, высота строки, отступы и
        сам текст. Разъедутся — каретка встанет не там, где человек кликнул. */
  m.font.area === m.font.hl && m.padding.area === m.padding.hl
    ? ok('подсветка и поле ввода свёрстаны одинаково', m.font.hl)
    : fail('метрики слоёв разъехались', JSON.stringify({ font: m.font, padding: m.padding }));
  m.hlText === m.value
    ? ok('подсвеченный слой совпадает с текстом символ в символ', `${m.value.length} симв.`)
    : fail('текст подсветки не совпал', `поле ${m.value.length}, подсветка ${m.hlText === null ? 'нет' : m.hlText.length}`);
  m.gutter.count === m.lines && m.gutter.last === String(m.lines)
    ? ok('нумерация строк совпадает с файлом', `${m.lines} строк`)
    : fail('нумерация строк', JSON.stringify({ gutter: m.gutter, lines: m.lines }));

  /* 3. Правка текста и Ctrl+S: файл на диске меняется, пометка снимается. */
  await typeAtEnd('\n\nДобавлено проверкой.');
  await sleep(220);
  const mDirty = await evaluate(MEASURE);
  mDirty.status.dirty && mDirty.tabs.some((t) => t.active && t.dot)
    ? ok('правка в поле помечает вкладку как изменённую')
    : fail('пометка изменений', JSON.stringify({ status: mDirty.status, tabs: mDirty.tabs }));

  await ctrlS();
  const savedOk = await waitFor(`(() => {
    const status = document.querySelector('#modalRoot .modal.code-modal .code-status');
    return Boolean(status) && status.classList.contains('is-ok');
  })()`, 20000);
  await sleep(400);
  const mSaved = await evaluate(MEASURE);
  const afterSave = await fileText(projectId, scratch.path);
  savedOk && /Файл сохранён/.test(mSaved.status.text)
    ? ok('Ctrl+S сохранил файл', mSaved.status.text.trim())
    : fail('сохранение через Ctrl+S', JSON.stringify({ savedOk, status: mSaved.status }));
  afterSave.text.includes('Добавлено проверкой.')
    ? ok('на диск записан отредактированный текст', `${afterSave.bytes} Б`)
    : fail('файл на диске', afterSave.text);
  mSaved.tabs.every((t) => !t.dot) ? ok('пометка «изменено» снята после сохранения') : fail('пометка изменений', JSON.stringify(mSaved.tabs));

  /* 4. «Версии» возвращают то, что было до правки. */
  await clickByText('.code-modal .code-tool', 'Версии');
  await sleep(200);
  const askedVersion = await evaluate(`Boolean(document.querySelector('#modalRoot .modal.code-modal .code-ask.is-open'))`);
  await clickByText('.code-modal .code-ask.is-open .btn', 'Вернуть');
  const restoredOk = await waitFor(`(() => {
    const status = document.querySelector('#modalRoot .modal.code-modal .code-status');
    return Boolean(status) && /возвращена/.test(status.textContent);
  })()`, 20000);
  await sleep(300);
  const mRestored = await evaluate(MEASURE);
  const afterRestore = await fileText(projectId, scratch.path);
  askedVersion && restoredOk && mRestored.value === scratchText.text && afterRestore.text === scratchText.text
    ? ok('«Версии» вернули прошлый текст', `${afterRestore.bytes} Б`)
    : fail('возврат версии', JSON.stringify({ askedVersion, restoredOk, inWindow: mRestored.value === scratchText.text, onDisk: afterRestore.text === scratchText.text }));

  /* 5. Своя отмена снимает пометку и возвращает текст файла. */
  await typeAtEnd(' ');
  await sleep(160);
  await ctrlKey('z', 'KeyZ', 90);
  await sleep(300);
  const mUndo = await evaluate(MEASURE);
  !mUndo.status.dirty && mUndo.value === scratchText.text && mUndo.tabs.every((t) => !t.dot)
    ? ok('своя отмена вернула текст файла и сняла пометку изменений')
    : fail('отмена правки', JSON.stringify({ status: mUndo.status, same: mUndo.value === scratchText.text, tabs: mUndo.tabs }));

  /* 6. Закрытие с несохранёнными правками спрашивает и не теряет текст. */
  await typeAtEnd(' ');
  await sleep(200);
  const dirtyState = await evaluate(MEASURE);
  dirtyState.status.dirty ? ok('правка в поле помечает вкладку как изменённую') : fail('пометка изменений', JSON.stringify(dirtyState.status));
  await clickByText('#modalRoot .modal.code-modal .modal-foot .btn', 'Закрыть');
  await sleep(280);
  const mGuard = await evaluate(MEASURE);
  mGuard && /несохранённые правки/.test(mGuard.ask || '') && mGuard.value === dirtyState.value
    ? ok('закрытие с правками спрашивает прямо в окне', (mGuard.ask || '').slice(0, 60))
    : fail('вопрос при закрытии', JSON.stringify({ ask: mGuard && mGuard.ask, kept: mGuard && mGuard.value === dirtyState.value }));
  await clickByText('.code-modal .code-ask.is-open .btn', 'Остаться');
  await sleep(200);
  const stayed = await evaluate(`Boolean(document.querySelector('#modalRoot .modal.code-modal')) && !document.querySelector('#modalRoot .modal.code-modal .code-ask.is-open')`);
  stayed ? ok('«Остаться» оставляет окно и правки на месте') : fail('ответ «Остаться»', 'окно или полоска вопросов не в том состоянии');
  await ctrlKey('z', 'KeyZ', 90);
  await sleep(220);
  await clickByText('#modalRoot .modal.code-modal .modal-foot .btn', 'Закрыть');
  const closed = await waitFor(`!document.querySelector('#modalRoot .modal.code-modal')`, 6000);
  closed ? ok('чистое окно закрывается сразу') : fail('закрытие чистого окна', 'окно осталось');

  /* 7. Панель дизайна: лист открывается, но «Править» в просмотре нет.
        Сам design.json из списка файлов — тоже только для просмотра. */
  if (design) {
    await evaluate(`document.querySelector('.design-card').click()`);
    const previewOpen = await waitFor(`!!document.querySelector('#modalRoot .modal.file-preview-modal')`, 8000);
    const hasEdit = await evaluate(`[...document.querySelectorAll('#modalRoot .modal-foot .btn')].some((b) => b.textContent.trim() === 'Править')`);
    previewOpen && !hasEdit
      ? ok('лист из панели дизайна открывается без кнопки «Править»')
      : fail('просмотр листа', JSON.stringify({ previewOpen, hasEdit }));
    await clickByText('#modalRoot .modal-foot .btn', 'Закрыть');
    await waitFor(`!document.querySelector('#modalRoot .modal.file-preview-modal')`, 6000);

    const specPreview = await openPreviewOf('design.json', false);
    const specEdit = await evaluate(`[...document.querySelectorAll('#modalRoot .modal-foot .btn')].some((b) => b.textContent.trim() === 'Править')`);
    specPreview && !specEdit
      ? ok('design.json из списка файлов открывается только для просмотра')
      : fail('просмотр design.json', JSON.stringify({ specPreview, specEdit }));
    await clickByText('#modalRoot .modal-foot .btn', 'Закрыть');
    await waitFor(`!document.querySelector('#modalRoot .modal.file-preview-modal')`, 6000);
  }

  /* ---------------------------- телефон ---------------------------- */
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await goto(BASE + '/');
  /* На телефоне панель файлов живёт в выдвижном ящике: пока он закрыт, списка
     файлов на экране нет. Открываем ящик кнопкой — так же, как человек. */
  const drawerOpen = await evaluate(`document.getElementById('app').classList.contains('files-open')`);
  if (!drawerOpen) await evaluate(`document.getElementById('filesBtn').click()`);
  await waitFor(`document.querySelectorAll('#filesList .file-row').length > 0`, 9000);
  const mobilePreview = await openPreviewOf(scratch.path, true);
  const mobileEdit = await evaluate(`[...document.querySelectorAll('#modalRoot .modal-foot .btn')].some((b) => b.textContent.trim() === 'Править')`);
  const mobileOpen = mobilePreview && mobileEdit
    ? await (async () => {
        await clickByText('#modalRoot .modal-foot .btn', 'Править');
        return waitFor(`(() => {
          const area = document.querySelector('#modalRoot .modal.code-modal .code-input');
          return Boolean(area) && area.value.length > 0;
        })()`);
      })()
    : false;
  if (!mobilePreview || !mobileEdit || !mobileOpen) {
    fail('редактор на телефоне', JSON.stringify({ mobilePreview, mobileEdit, mobileOpen }));
  } else {
    await sleep(360);
    const mm = await evaluate(MEASURE);
    await shot('code-mobile.png');
    /* Окно правки на телефоне — весь экран, как остальные полноэкранные окна:
       на узком экране половина строки кода хуже, чем ничего. */
    mm.rect.x === 0 && mm.rect.y === 0 && mm.rect.w === 390 && mm.rect.h === 844
      ? ok('на телефоне окно правки во весь экран', `${mm.rect.w}×${mm.rect.h}`)
      : fail('размер окна на телефоне', JSON.stringify({ rect: mm.rect, inner: mm.inner }));
    const areaFont = parseFloat((mm.font.area.split(' / ')[1] || '0'));
    areaFont >= 16
      ? ok('поле ввода не мельче 16 px', `${areaFont} px`)
      : fail('кегль поля на телефоне', `${areaFont} px — iOS увеличит страницу`);
    mm.font.area === mm.font.hl
      ? ok('на телефоне слои по-прежнему совпадают', mm.font.hl)
      : fail('метрики на телефоне', JSON.stringify(mm.font));
    mm.hlText === mm.value ? ok('текст и подсветка совпадают на телефоне') : fail('подсветка на телефоне', 'слои разъехались');
    mm.overflowX <= 0 ? ok('страница не прокручивается вбок', `${mm.tabs.length} вкладок`) : fail('горизонтальная прокрутка', `${mm.overflowX} px`);
    /* Кнопки правки на телефоне должны переноситься, а не уезжать за край:
       иначе «Просмотр» и «Скачать» просто не нажать. */
    const toolsRects = await evaluate(`[...document.querySelectorAll('#modalRoot .modal.code-modal .code-bar .code-tool')]
      .filter((b) => !b.classList.contains('hidden'))
      .map((b) => { const r = b.getBoundingClientRect(); return { label: b.textContent.trim(), left: Math.round(r.left), right: Math.round(r.right), w: Math.round(r.width) }; })`);
    const toolsFit = toolsRects.every((r) => r.w > 0 && r.right <= 391);
    toolsFit
      ? ok('все кнопки правки видны на телефоне', `${toolsRects.length} шт.`)
      : fail('кнопки за краем экрана', JSON.stringify({ rects: toolsRects, bar: mm.rect.w }));
    const keys = await evaluate(`(() => {
      const node = document.querySelector('#modalRoot .modal.code-modal .code-keys');
      return node ? getComputedStyle(node).display : 'нет';
    })()`);
    keys === 'none' ? ok('подсказка про Ctrl+S спрятана на телефоне') : fail('подсказка клавиш на телефоне', String(keys));
    await clickByText('#modalRoot .modal.code-modal .modal-foot .btn', 'Закрыть');
    await waitFor(`!document.querySelector('#modalRoot .modal.code-modal')`, 6000);
  }

  /* 8. Консоль страницы должна быть чистой: молчаливые ошибки в редакторе
        означают, что подсветка или сохранение где-то падают. */
  const failures = consoleErrors.filter((line) => !/favicon|ResizeObserver loop/i.test(line));
  failures.length === 0
    ? ok('в консоли страницы нет ошибок')
    : fail('ошибки в консоли', failures.slice(0, 4).join(' | '));

  /* 9. Убираем проверочный файл и убеждаемся, что дизайн не тронут. */
  await deleteFile(projectId, scratch.path);
  if (designWrite.status !== 403) await deleteFile(projectId, 'design/editor-check.svg');
  if (design) {
    const finalDesign = await evaluate(`fetch('/api/projects/${projectId}/design').then((r) => r.json()).then((d) => Boolean(d.design && d.design.hasSpec))`);
    finalDesign ? ok('дизайн-проект остался на месте после проверки') : fail('дизайн после проверки', 'спека больше нет');
  }
  const leftover = await fileText(projectId, scratch.path);
  leftover.editable === false || leftover.bytes === undefined
    ? ok('проверочный файл удалён')
    : fail('проверочный файл остался', scratch.path);
} finally {
  chrome.kill();
  await sleep(400);
  fs.rmSync(profileDir, { recursive: true, force: true });
}

const failed = results.filter((value) => !value).length;
console.log(`\nИтого: ${results.length - failed} ok, ${failed} fail`);
process.exit(failed ? 1 : 0);
