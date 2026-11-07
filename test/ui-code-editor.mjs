// Проверка редактора кода в блоке «Дизайн-проект» через DevTools-протокол
// (без зависимостей, как остальные ui-*.mjs):
//   - «Правка» открывает окно с вкладками: спек и каждый собранный лист;
//   - текст в поле ввода совпадает с подсвеченным слоем символ в символ, кегль,
//     высота строки и отступы у них одинаковые (иначе каретка уезжает от букв);
//   - нумерация строк совпадает с числом строк файла;
//   - быстрые параметры (формат листа) подставляются в текст спека, Ctrl+S
//     сохраняет файл, сервер пересобирает листы, панель дизайна это говорит;
//   - кривой JSON не сохраняется: показывается строка и символ ошибки;
//   - «Версии» возвращают прошлое содержимое файла;
//   - закрытие с несохранёнными правками спрашивает прямо в окне и не теряет
//     текст, если человек передумал;
//   - из просмотра файла есть «Править»;
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

  await goto(BASE + '/');
  await evaluate(
    `fetch('/api/login', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({username:${JSON.stringify(USER)}, password:${JSON.stringify(PASS)}})}).then(r => r.status)`,
  );
  await goto(BASE + '/');

  const projectId = await evaluate(`fetch('/api/bootstrap').then((r) => r.json()).then((d) => (Array.isArray(d.projects) && d.projects[0] ? d.projects[0].id : ''))`);
  if (!projectId) throw new Error('в сервисе нет проекта — проверять нечего');
  const before = await fileText(projectId, 'design.json');
  if (!before.editable) throw new Error('design.json не открывается как текст — редактор не проверить');
  const specBefore = JSON.parse(before.text);
  console.log(`  --  проект ${projectId}, спек ${before.bytes} Б, формат ${specBefore.paper}\n`);

  /* ---------------------------- компьютер ---------------------------- */
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

  const panelReady = await waitFor(`(() => {
    const panel = document.getElementById('designPanel');
    return panel && !panel.classList.contains('hidden') && document.querySelectorAll('.design-card').length > 0;
  })()`);
  if (!panelReady) throw new Error('панель дизайна не появилась: нет спека или проекта');

  await evaluate(`document.getElementById('designEditBtn').click()`);
  const opened = await waitFor(`(() => {
    const area = document.querySelector('#modalRoot .modal.code-modal .code-input');
    return Boolean(area) && !area.readOnly && area.value.length > 0;
  })()`);
  if (!opened) throw new Error('редактор не открылся или не прочитал файл');
  await sleep(320);
  const m = await evaluate(MEASURE);
  await shot('code-desktop.png');

  /* 1. Вкладки: спек первым, листы следом. */
  const designTab = m.tabs.find((tab) => tab.name === 'design.json');
  designTab && designTab.active && m.tabs.length >= 6
    ? ok('в окне вкладки спека и листов', `${m.tabs.length} шт.: ${m.tabs.map((t) => t.name).join(', ')}`)
    : fail('вкладки окна правки', JSON.stringify(m.tabs));
  m.path === 'design.json' && /JSON/.test(m.meta)
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

  /* 3. Сводка по спеку в предпросмотре — человек видит, что он правит. */
  const previewBtn = await clickByText('.code-modal .code-tool', 'Просмотр');
  await sleep(260);
  const mPreview = await evaluate(MEASURE);
  previewBtn && mPreview.previewOn && mPreview.summary.length >= 5 && mPreview.summaryRooms >= 1
    ? ok('предпросмотр показывает сводку спека', `${mPreview.summary.length} строк, ${mPreview.summaryRooms} комнат`)
    : fail('сводка спека', JSON.stringify({ clicked: previewBtn, on: mPreview.previewOn, summary: mPreview.summary, rooms: mPreview.summaryRooms }));
  await shot('code-desktop-preview.png');
  await clickByText('.code-modal .code-tool', 'Просмотр');
  await sleep(160);

  /* 4. Быстрые параметры подставляются в текст, Ctrl+S сохраняет и пересобирает.
        В спеке дизайна панель параметров открыта сразу (её и меняют чаще всего),
        поэтому проверяем и сворачивание. */
  m.quickHidden === false
    ? ok('параметры спека показаны сразу при открытии')
    : fail('параметры спека', 'панель спрятана при открытии');
  const quickHidden = `document.querySelector('#modalRoot .modal.code-modal .code-quick').classList.contains('hidden')`;
  await clickByText('.code-modal .code-tool', 'Параметры');
  await sleep(200);
  const quickOff = await evaluate(quickHidden);
  const quickToggleOn = await evaluate(`[...document.querySelectorAll('#modalRoot .modal.code-modal .code-tool')].some((b) => b.textContent.trim() === 'Параметры' && b.classList.contains('is-on'))`);
  await clickByText('.code-modal .code-tool', 'Параметры');
  await sleep(200);
  const quickOn = await evaluate(`!(${quickHidden})`);
  quickOff && quickOn && !quickToggleOn
    ? ok('параметры сворачиваются и разворачиваются')
    : fail('сворачивание параметров', JSON.stringify({ quickOff, quickOn, quickToggleOn }));
  const changed = await evaluate(`(() => {
    const select = document.getElementById('code-quick-paper');
    if (!select) return false;
    select.value = 'A1';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  await sleep(220);
  const mQuick = await evaluate(MEASURE);
  changed && /"paper": "A1"/.test(mQuick.value) && mQuick.status.dirty && mQuick.tabs.some((t) => t.active && t.dot)
    ? ok('параметры подставлены в спек, вкладка помечена как изменённая')
    : fail('подстановка параметров', JSON.stringify({ changed, paper: /"paper": "(\w+)"/.exec(mQuick.value)?.[1], status: mQuick.status, tabs: mQuick.tabs }));

  await ctrlS();
  const savedOk = await waitFor(`(() => {
    const status = document.querySelector('#modalRoot .modal.code-modal .code-status');
    return Boolean(status) && status.classList.contains('is-ok');
  })()`, 20000);
  await sleep(400);
  const mSaved = await evaluate(MEASURE);
  const afterSave = await fileText(projectId, 'design.json');
  savedOk && /пересобраны: \d+ из \d+/.test(mSaved.status.text)
    ? ok('Ctrl+S сохранил и пересобрал листы', mSaved.status.text.trim())
    : fail('сохранение через Ctrl+S', JSON.stringify({ savedOk, status: mSaved.status }));
  JSON.parse(afterSave.text).paper === 'A1'
    ? ok('на диск записан отредактированный спек', `paper=${JSON.parse(afterSave.text).paper}, ${afterSave.bytes} Б`)
    : fail('файл на диске', String(JSON.parse(afterSave.text).paper));
  const note = await evaluate(`(document.getElementById('designNote') || {}).textContent || ''`);
  /пересобраны: \d+ из \d+/.test(note)
    ? ok('панель дизайна сообщила о пересборке', note.trim())
    : fail('сообщение панели дизайна', JSON.stringify(note));
  mSaved.tabs.every((t) => !t.dot) ? ok('пометка «изменено» снята после сохранения') : fail('пометка изменений', JSON.stringify(mSaved.tabs));

  /* 5. «Версии» возвращают то, что было до правки. */
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
  const afterRestore = await fileText(projectId, 'design.json');
  askedVersion && restoredOk && JSON.parse(mRestored.value).paper === specBefore.paper && JSON.parse(afterRestore.text).paper === specBefore.paper
    ? ok('«Версии» вернули прошлый спек', `paper=${JSON.parse(afterRestore.text).paper}`)
    : fail('возврат версии', JSON.stringify({ askedVersion, restoredOk, inWindow: /"paper": "(\w+)"/.exec(mRestored.value)?.[1], onDisk: JSON.parse(afterRestore.text).paper }));

  /* 6. Кривой JSON не сохраняется: человек видит строку и символ ошибки. */
  await typeAtEnd(',');
  await ctrlS();
  const badOk = await waitFor(`(() => {
    const status = document.querySelector('#modalRoot .modal.code-modal .code-status');
    return Boolean(status) && status.classList.contains('is-bad');
  })()`, 8000);
  const mBad = await evaluate(MEASURE);
  const afterBad = await fileText(projectId, 'design.json');
  badOk && /строка \d+/.test(mBad.status.text) && afterBad.text === afterRestore.text
    ? ok('ошибка JSON показана со строкой, файл не тронут', mBad.status.text.trim())
    : fail('проверка JSON перед записью', JSON.stringify({ badOk, status: mBad.status, same: afterBad.text === afterRestore.text }));
  await ctrlKey('z', 'KeyZ', 90);
  await sleep(250);
  const mUndo = await evaluate(MEASURE);
  !mUndo.status.dirty && /отменена/.test(mUndo.status.text) && mUndo.value === afterRestore.text && mUndo.tabs.every((t) => !t.dot)
    ? ok('своя отмена вернула текст файла и сняла пометку изменений')
    : fail('отмена правки', JSON.stringify({ status: mUndo.status, same: mUndo.value === afterRestore.text, tabs: mUndo.tabs }));

  /* 7. Закрытие с несохранёнными правками спрашивает и не теряет текст. */
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

  /* 8. Из просмотра листа есть «Править» — тот же редактор на один файл. */
  await evaluate(`document.querySelector('.design-card').click()`);
  const previewOpen = await waitFor(`!!document.querySelector('#modalRoot .modal.file-preview-modal')`, 8000);
  const hasEdit = await evaluate(`[...document.querySelectorAll('#modalRoot .modal-foot .btn')].some((b) => b.textContent.trim() === 'Править')`);
  if (!previewOpen) {
    fail('просмотр листа из панели дизайна', 'окно не открылось');
  } else {
    hasEdit ? ok('в просмотре листа есть кнопка «Править»') : fail('кнопка «Править» в просмотре', 'её нет в нижней полосе');
    await clickByText('#modalRoot .modal-foot .btn', 'Править');
    const svgOpened = await waitFor(`(() => {
      const area = document.querySelector('#modalRoot .modal.code-modal .code-input');
      return Boolean(area) && area.value.startsWith('<') && /SVG/.test(document.querySelector('#modalRoot .modal.code-modal .code-meta').textContent);
    })()`, 12000);
    await sleep(420);
    const mSvg = await evaluate(MEASURE);
    await shot('code-desktop-svg.png');
    svgOpened && mSvg.tabs.length === 1 && mSvg.tabs[0].name === 'plan.svg'
      ? ok('лист открылся в редакторе отдельной вкладкой', mSvg.tabs[0].name)
      : fail('правка листа', JSON.stringify({ svgOpened, tabs: mSvg.tabs }));
    mSvg.hlText === mSvg.value && mSvg.gutter.count === mSvg.lines
      ? ok('SVG подсвечен без расхождения с текстом', `${mSvg.lines} строк`)
      : fail('подсветка SVG', JSON.stringify({ equal: mSvg.hlText === mSvg.value, gutter: mSvg.gutter, lines: mSvg.lines }));
    mSvg.previewOn && mSvg.img && mSvg.img.w > 0
      ? ok('предпросмотр листа показывает сам чертёж', `${mSvg.img.w}×${mSvg.img.h}`)
      : fail('предпросмотр SVG', JSON.stringify({ on: mSvg.previewOn, img: mSvg.img }));
    await clickByText('#modalRoot .modal.code-modal .modal-foot .btn', 'Закрыть');
    await waitFor(`!document.querySelector('#modalRoot .modal.code-modal')`, 6000);
  }

  /* ---------------------------- телефон ---------------------------- */
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await goto(BASE + '/');
  const panelShown = `(() => {
    const panel = document.getElementById('designPanel');
    return panel && !panel.classList.contains('hidden') && document.querySelectorAll('.design-card').length > 0;
  })()`;
  /* На телефоне панель файлов живёт в выдвижном ящике: пока он закрыт, блока
     «Дизайн-проект» на экране нет. Открываем ящик кнопкой — так же, как человек. */
  let mobilePanel = await waitFor(panelShown, 9000);
  if (!mobilePanel) {
    await evaluate(`document.getElementById('filesBtn').click()`);
    mobilePanel = await waitFor(panelShown, 9000);
  }
  if (!mobilePanel) {
    fail('панель дизайна на телефоне', 'не появилась даже после открытия панели файлов');
  } else {
    await evaluate(`document.getElementById('designEditBtn').click()`);
    const mobileOpen = await waitFor(`(() => {
      const area = document.querySelector('#modalRoot .modal.code-modal .code-input');
      return Boolean(area) && area.value.length > 0;
    })()`);
    await sleep(360);
    const mm = await evaluate(MEASURE);
    await shot('code-mobile.png');
    if (!mobileOpen || !mm) {
      fail('редактор на телефоне', 'окно не открылось');
    } else {
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
  }

  /* 9. Консоль страницы должна быть чистой: молчаливые ошибки в редакторе
        означают, что подсветка или сохранение где-то падают. */
  const failures = consoleErrors.filter((line) => !/favicon|ResizeObserver loop/i.test(line));
  failures.length === 0
    ? ok('в консоли страницы нет ошибок')
    : fail('ошибки в консоли', failures.slice(0, 4).join(' | '));

  /* 10. Файл вернулся к исходному спеку: проверка не оставляет мусора. */
  const finalState = await fileText(projectId, 'design.json');
  JSON.parse(finalState.text).paper === specBefore.paper
    ? ok('спек остался исходным после проверки', `paper=${JSON.parse(finalState.text).paper}`)
    : fail('спек изменился от проверки', String(JSON.parse(finalState.text).paper));
} finally {
  chrome.kill();
  await sleep(400);
  fs.rmSync(profileDir, { recursive: true, force: true });
}

const failed = results.filter((value) => !value).length;
console.log(`\nИтого: ${results.length - failed} ok, ${failed} fail`);
process.exit(failed ? 1 : 0);
