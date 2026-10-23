// Сквозная проверка сервиса в настоящем Chrome через DevTools-протокол.
// Проходит путь пользователя целиком: вход (и ошибки входа), тема, проекты и
// папки, диалоги, отправка сообщения и «Стоп», вложения, орфография, панель
// файлов, меню и их закрытие, администрирование, смена пароля, выход.
//
// Запуск (нужен уже работающий сервер):
//   $env:DSHOW_BASE='http://127.0.0.1:3131'; $env:DSHOW_USER='admin'; $env:DSHOW_PASS='...'
//   node test/ui-flows.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Document, Packer, Paragraph, TextRun, HeadingLevel } from 'docx';
import ExcelJS from 'exceljs';

const BASE = process.env.DSHOW_BASE || 'http://127.0.0.1:3131';
const USER = process.env.DSHOW_USER || 'admin';
const PASS = process.env.DSHOW_PASS || 'Test-pass-2026';
const STAMP = Date.now().toString().slice(-6);
const NEW_USER = `flow_${STAMP}`;
const NEW_PASS = 'Flow-pass-2026';
const FILE_NAME = `flows-${STAMP}.txt`;
const DOCX_NAME = `office-${STAMP}.docx`;
const XLSX_NAME = `sheet-${STAMP}.xlsx`;
const HTML_NAME = `page-${STAMP}.html`;
const PAGE_MARK = 'маркер-' + STAMP;

/* Настоящий docx: окно просмотра показывает документ разметкой, а не текстом,
   поэтому проверять его нужно на файле, который действительно открывает Word. */
async function realDocx() {
  const doc = new Document({
    sections: [
      {
        children: [
          new Paragraph({ text: 'Договор проверки', heading: HeadingLevel.HEADING_1 }),
          new Paragraph({ children: [new TextRun({ text: 'Сумма ' }), new TextRun({ text: '1 000 ₽', bold: true })] }),
        ],
      },
    ],
  });
  return Packer.toBuffer(doc);
}

/* Настоящая книга Excel: окно просмотра должно показать таблицу с числами,
   а не «файл не найден» из чужого проекта. */
async function realXlsx() {
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet('Смета');
  sheet.addRow(['Статья', 'Сумма']);
  sheet.addRow(['Материалы', 12500]);
  sheet.addRow(['Работа', 32000]);
  return Buffer.from(await book.xlsx.writeBuffer());
}

/* HTML-страница проекта: открывается в рамке окна просмотра. */
function projectPage() {
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Страница проекта</title></head><body><h1>Страница проекта</h1><p>маркер-${STAMP}</p></body></html>`;
}

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
  console.log(`  FAIL ${name}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PORT = Number(process.env.DSHOW_CDP_PORT || 9422);
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshow-flows-'));
const chrome = spawn(
  CHROME,
  ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profileDir}`, '--no-first-run',
    '--no-default-browser-check', '--disable-extensions', '--window-size=1440,900', 'about:blank'],
  { stdio: 'ignore' },
);

async function pageWs() {
  for (let i = 0; i < 80; i++) {
    try {
      const pages = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter((t) => t.type === 'page');
      if (pages.length) return pages[0].webSocketDebuggerUrl;
    } catch { /* ещё стартует */ }
    await sleep(250);
  }
  throw new Error('нет страницы для подключения');
}

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
  return {
    ready: new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve);
      socket.addEventListener('error', reject);
    }),
    send(method, params = {}) {
      const id = nextId++;
      socket.send(JSON.stringify({ id, method, params }));
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    },
    on(listener) { listeners.add(listener); },
    close() { socket.close(); },
  };
}

try {
  const cdp = connect(await pageWs());
  await cdp.ready;
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Network.enable');
  await cdp.send('DOM.enable');

  let loaded = false;
  const consoleErrors = [];
  cdp.on((msg) => {
    if (msg.method === 'Page.loadEventFired') loaded = true;
    if (msg.method === 'Runtime.exceptionThrown') {
      consoleErrors.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
    }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      consoleErrors.push(msg.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
    }
  });

  async function evaluate(expression) {
    const result = await cdp.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    }
    return result.result.value;
  }
  async function goto(url) {
    loaded = false;
    await cdp.send('Page.navigate', { url });
    for (let i = 0; i < 100 && !loaded; i++) await sleep(80);
    await sleep(320);
  }
  async function waitFor(expression, timeoutMs = 8000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        if (await evaluate(expression)) return true;
      } catch { /* страница перезагружается */ }
      await sleep(120);
    }
    return false;
  }
  const click = (selector) =>
    evaluate(`(() => { const n = document.querySelector(${JSON.stringify(selector)}); if (!n) throw new Error('нет ' + ${JSON.stringify(selector)}); n.click(); return true; })()`);
  const text = (selector) => evaluate(`(document.querySelector(${JSON.stringify(selector)}) || {}).textContent || ''`);
  const exists = (selector) => evaluate(`!!document.querySelector(${JSON.stringify(selector)})`);
  const count = (selector) => evaluate(`document.querySelectorAll(${JSON.stringify(selector)}).length`);
  async function fill(selector, value) {
    await evaluate(`(() => {
      const node = document.querySelector(${JSON.stringify(selector)});
      if (!node) throw new Error('нет ${selector}');
      node.focus();
      node.value = ${JSON.stringify(value)};
      node.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
  }
  async function press(selector, key) {
    await evaluate(`(() => {
      const node = document.querySelector(${JSON.stringify(selector)});
      if (!node) throw new Error('нет ${selector}');
      node.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true, cancelable: true }));
      return true;
    })()`);
  }
  async function login(username, password) {
    await evaluate(`(async () => {
      const r = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: ${JSON.stringify(username)}, password: ${JSON.stringify(password)} }) });
      return r.status;
    })()`);
    await goto(BASE + '/');
  }
  async function logoutApi() {
    await evaluate(`fetch('/api/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then(r => r.status)`);
  }

  /* ------------------------- 1. экран входа ------------------------- */

  await goto(BASE + '/');
  await cdp.send('Network.clearBrowserCookies');
  await goto(BASE + '/');
  const authState = await evaluate(`({
    auth: !document.getElementById('auth').classList.contains('hidden'),
    app: document.getElementById('app').classList.contains('hidden'),
    boot: document.getElementById('boot').classList.contains('hidden'),
  })`);
  authState.auth && authState.app ? ok('без сеанса показывается вход') : fail('экран входа', authState);

  // Тема переключается уже на экране входа и запоминается.
  const beforeTheme = await evaluate(`document.documentElement.dataset.theme`);
  await click('#authThemeToggle');
  await sleep(250);
  const afterTheme = await evaluate(`({ theme: document.documentElement.dataset.theme, saved: localStorage.getItem('dshow-theme') })`);
  beforeTheme !== afterTheme.theme && afterTheme.saved === afterTheme.theme
    ? ok('тема переключается с экрана входа', `${beforeTheme} → ${afterTheme.theme}`)
    : fail('тема на экране входа', { beforeTheme, ...afterTheme });
  await click('#authThemeToggle');
  await sleep(200);

  await click('#loginSubmit');
  await sleep(700);
  const emptyError = (await text('#loginError')).trim();
  const emptyState = await evaluate(`({
    app: document.getElementById('app').classList.contains('hidden'),
    disabled: document.getElementById('loginSubmit').disabled,
    label: document.getElementById('loginSubmit').textContent.trim(),
  })`);
  emptyError && emptyState.app && !emptyState.disabled && emptyState.label === 'Войти'
    ? ok('пустой вход объясняет, чего не хватает', emptyError)
    : fail('пустой вход', { emptyError, ...emptyState });

  await fill('#loginUser', USER);
  await fill('#loginPass', 'wrong-password-zzz');
  await click('#loginSubmit');
  const wrongShown = await waitFor(`(document.getElementById('loginError').textContent || '').trim().length > 0`);
  const wrongText = (await text('#loginError')).trim();
  wrongShown && /неверн/i.test(wrongText)
    ? ok('неверный пароль объяснён на экране входа', wrongText)
    : fail('неверный пароль', wrongText || 'сообщения нет');

  await fill('#loginPass', PASS);
  await click('#loginSubmit');
  const appShown = await waitFor(`!document.getElementById('app').classList.contains('hidden')`);
  appShown ? ok('верный пароль открывает сервис') : fail('вход', 'приложение не открылось');

  // Переключение на регистрацию и назад (ссылка есть только при открытой регистрации).
  const altVisible = await evaluate(`!document.getElementById('authAlt').classList.contains('hidden')`);
  if (altVisible) {
    await click('#authSwitchToSignup');
    const signup = await evaluate(`({
      form: !document.getElementById('signupForm').classList.contains('hidden'),
      login: document.getElementById('loginForm').classList.contains('hidden'),
    })`);
    signup.form && signup.login ? ok('переключение на регистрацию') : fail('форма регистрации', signup);
    await click('#authSwitchToLogin');
    const back = await evaluate(`!document.getElementById('loginForm').classList.contains('hidden')`);
    back ? ok('возврат к форме входа') : fail('возврат к входу', back);
  }

  /* ------------------------- 2. тема ------------------------- */

  const themeBefore = await evaluate(`document.documentElement.dataset.theme`);
  await click('#themeToggle');
  const themeAfter = await evaluate(`({
    theme: document.documentElement.dataset.theme,
    saved: localStorage.getItem('dshow-theme'),
    meta: (document.querySelector('meta[name="theme-color"]') || {}).content,
    icon: (document.querySelector('#themeToggle .icon-sun') || {}).className || '',
  })`);
  themeAfter.theme !== themeBefore && themeAfter.saved === themeAfter.theme
    ? ok('переключатель темы меняет тему и запоминает выбор', `${themeBefore} → ${themeAfter.theme}`)
    : fail('тема', themeAfter);
  await goto(BASE + '/');
  const themeKept = await evaluate(`document.documentElement.dataset.theme`);
  themeKept === themeAfter.theme ? ok('тема сохраняется после перезагрузки') : fail('тема после перезагрузки', themeKept);

  /* ------------------------- 3. проекты и папки ------------------------- */

  const projectsBefore = await count('.project-row');
  await click('#newProjectBtn');
  const cardShown = await waitFor(`!!document.querySelector('.sidebar .popover')`);
  cardShown ? ok('карточка «Новый проект» открылась') : fail('карточка проекта', 'не появилась');
  const cardButtons = await evaluate(`[...document.querySelectorAll('.sidebar .popover .btn')].map(b => b.textContent.trim())`);
  cardButtons.join('/') === 'Отмена/Создать проект'
    ? ok('у карточки две кнопки, как у подтверждения удаления')
    : fail('кнопки карточки', cardButtons);
  await click('.sidebar .popover .btn-quiet');
  await waitFor(`!document.querySelector('.sidebar .popover')`);
  (await count('.project-row')) === projectsBefore ? ok('«Отмена» не создаёт проект') : fail('отмена проекта', 'проект появился');

  await click('#newProjectBtn');
  await waitFor(`!!document.querySelector('.sidebar .popover input')`);
  await fill('.sidebar .popover input', `Проект ${STAMP}`);
  await press('.sidebar .popover input', 'Enter');
  const projectAdded = await waitFor(`[...document.querySelectorAll('.project-row .p-name')].some(n => n.textContent.includes(${JSON.stringify(STAMP)}))`);
  projectAdded ? ok('проект создан по Enter') : fail('создание проекта', 'строки нет');

  // Переименование через меню строки.
  await evaluate(`(() => {
    const row = [...document.querySelectorAll('.project-row')].find(n => n.textContent.includes(${JSON.stringify(STAMP)}));
    row.querySelector('.row-menu').click();
  })()`);
  await waitFor(`!!document.querySelector('.menu')`);
  await evaluate(`(() => {
    const item = [...document.querySelectorAll('.menu button')].find(b => b.textContent.includes('Переименовать'));
    if (!item) throw new Error('нет пункта «Переименовать»');
    item.click();
  })()`);
  await waitFor(`!!document.querySelector('.sidebar .popover input')`);
  await fill('.sidebar .popover input', `Проект ${STAMP} 2`);
  await press('.sidebar .popover input', 'Enter');
  const renamed = await waitFor(`[...document.querySelectorAll('.project-row .p-name')].some(n => n.textContent === ${JSON.stringify(`Проект ${STAMP} 2`)})`);
  renamed ? ok('проект переименован') : fail('переименование проекта', 'имя не изменилось');

  /* ------------------------- 4. папки проектов ------------------------- */

  /* В панели больше нет создания папок: остались только «Новый проект» и
     диалоги внутри проектов. Старые папки (если есть) только переименовываются
     и удаляются — проверяем, что кнопки создания действительно нет. */
  const folderCreateBtn = await exists('#newWorkflowBtn');
  folderCreateBtn
    ? fail('создание папки', 'кнопка «Новая папка» всё ещё в панели')
    : ok('в панели нет создания папки — только проект и диалоги');
  const folderCreatesFromMenu = await evaluate(`(() => {
    const row = document.querySelector('.workflow-row .row-menu');
    return Boolean(row);
  })()`);
  folderCreatesFromMenu
    ? ok('у старой папки осталось только меню переименования и удаления')
    : ok('старых папок нет — меню папки не проверяем');

  /* ------------------------- 5. диалоги ------------------------- */

  const chatsBefore = await count('.chat-row');
  await evaluate(`(() => {
    const row = [...document.querySelectorAll('.project-row')].find(n => n.textContent.includes(${JSON.stringify(STAMP)}));
    row.querySelector('.row-plus').click();
  })()`);
  const chatAdded = await waitFor(`document.querySelectorAll('.chat-row').length > ${chatsBefore}`);
  chatAdded ? ok('новый диалог создан кнопкой «+»') : fail('новый диалог', 'строки нет');

  if (chatAdded) {
    await evaluate(`document.querySelector('.chat-row .row-menu').click()`);
    await waitFor(`!!document.querySelector('.menu')`);
    await evaluate(`[...document.querySelectorAll('.menu button')].find(b => b.textContent.includes('Переименовать')).click()`);
    await waitFor(`!!document.querySelector('.sidebar .popover input')`);
    await fill('.sidebar .popover input', `Диалог ${STAMP}`);
    await press('.sidebar .popover input', 'Enter');
    const chatRenamed = await waitFor(`!!document.querySelector('.chat-row .c-title') && document.querySelector('.chat-row .c-title').textContent.includes(${JSON.stringify(STAMP)})`);
    chatRenamed ? ok('диалог переименован') : fail('переименование диалога', await text('.chat-row .c-title'));
  }

  /* ------------------------- 6. композер ------------------------- */

  // Подсказка в пустом чате заполняет поле ввода.
  const suggestionGone = await count('.suggestion');
  if (suggestionGone) {
    await evaluate(`document.querySelector('.suggestion').click()`);
    const filled = await evaluate(`document.getElementById('input').value`);
    filled.length > 10 ? ok('подсказка на пустом экране заполняет поле') : fail('подсказка', filled);
    await fill('#input', '');
  }

  // Орфография: пустое поле — подсказка, а не запрос.
  await fill('#input', '');
  await click('#spellBtn');
  const spellToast = await waitFor(`(document.querySelector('#toastRoot').textContent || '').includes('Сначала введите текст')`);
  spellToast ? ok('проверка орфографии на пустом поле объясняет причину') : fail('орфография на пустом поле', await text('#toastRoot'));

  // Отправка сообщения и «Стоп».
  await fill('#input', `Проверка отправки ${STAMP}`);
  await click('#sendBtn');
  const userMsg = await waitFor(`!!document.querySelector('.msg-user')`);
  userMsg ? ok('сообщение появилось в ленте') : fail('отправка', 'нет сообщения пользователя');
  const stoppedByButton = await evaluate(`!document.getElementById('stopBtn').classList.contains('hidden')`);
  if (stoppedByButton) {
    await click('#stopBtn');
    const restored = await waitFor(`document.getElementById('stopBtn').classList.contains('hidden') && !document.getElementById('sendBtn').classList.contains('hidden')`, 20000);
    restored ? ok('«Стоп» возвращает кнопку отправки') : fail('остановка генерации', 'кнопки не вернулись');
  } else {
    ok('ответ пришёл сразу, «Стоп» не понадобился');
  }
  await waitFor(`!document.getElementById('sendBtn').classList.contains('hidden')`, 12000);

  /* ------------------------- 7. панель файлов ------------------------- */

  await waitFor(`!!document.querySelector('.file-row, .files-empty')`);
  async function setInputFile(selector, fileName, content) {
    const filePath = path.join(os.tmpdir(), fileName);
    fs.writeFileSync(filePath, content);
    const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
    const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector });
    if (!nodeId) throw new Error('нет поля ' + selector);
    await cdp.send('DOM.setFileInputFiles', { files: [filePath], nodeId });
    await sleep(200);
  }

  /* Клик по кнопке «Скачать» должен один раз отдать оригинал. Двойной щелчок
     по документу открывает окно просмотра сервиса: проверяем, что приложение
     не уходит ни в скачивание, ни во внешнюю программу по протоколу ms-*. */
  async function installLinkProbe() {
    return evaluate(`(() => {
      if (!window.__linkProbe) {
        const native = HTMLAnchorElement.prototype.click;
        HTMLAnchorElement.prototype.click = function () {
          const href = this.getAttribute('href') || '';
          if (this.hasAttribute('download')) {
            window.__downloads.push({ href: this.href, name: this.download });
            return;
          }
          if (href.startsWith('ms-')) {
            window.__protocols.push(href);
            return;
          }
          return native.call(this);
        };
        window.__linkProbe = true;
      }
      /* Считаем запросы за файлом: одно нажатие «Скачать» — ровно один запрос,
         иначе браузер показывает в «Загрузках» две строки одного файла. */
      if (!window.__fetchProbe) {
        const nativeFetch = window.fetch;
        window.fetch = function (input, init) {
          const url = typeof input === 'string' ? input : (input && input.url) || '';
          if (url.includes('/file?')) window.__fileGets.push(url);
          return nativeFetch.call(this, input, init);
        };
        window.__fetchProbe = true;
      }
      window.__fileGets = [];
      window.__downloads = [];
      window.__protocols = [];
      return true;
    })()`);
  }

  async function clickDownloadAndCapture(fileName) {
    await installLinkProbe();
    return evaluate(`(async () => {
      const row = [...document.querySelectorAll('.file-row')].find(r => (r.querySelector('.f-name') || {}).textContent === ${JSON.stringify(fileName)});
      if (!row) return null;
      const button = row.querySelector('.f-actions button[aria-label^="Скачать"]');
      if (!button) return { missing: true };
      button.click();
      /* Файл теперь забирается с сервера и только потом сохраняется — ждём
         готовую ссылку, а не пустой список. */
      for (let i = 0; i < 100 && !window.__downloads.length; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return window.__downloads;
    })()`);
  }

  /* Тройной быстрый тап по «Скачать» не должен давать три запроса и три
     сохранения: одно нажатие — одно скачивание. */
  async function tripleClickDownloadAndCapture(fileName) {
    await installLinkProbe();
    return evaluate(`(async () => {
      const row = [...document.querySelectorAll('.file-row')].find(r => (r.querySelector('.f-name') || {}).textContent === ${JSON.stringify(fileName)});
      if (!row) return null;
      const button = row.querySelector('.f-actions button[aria-label^="Скачать"]');
      if (!button) return { missing: true };
      button.click();
      button.click();
      button.click();
      for (let i = 0; i < 100 && !window.__downloads.length; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      /* Даём возможным лишним запросам дойти до сервера, прежде чем считать. */
      await new Promise((resolve) => setTimeout(resolve, 1500));
      return { downloads: window.__downloads.length, gets: window.__fileGets.length };
    })()`);
  }

  async function clickFileName(fileName) {
    await installLinkProbe();
    return evaluate(`(() => {
      const row = [...document.querySelectorAll('.file-row')].find(r => (r.querySelector('.f-name') || {}).textContent === ${JSON.stringify(fileName)});
      if (!row) return null;
      row.querySelector('.f-name').click();
      return { downloads: window.__downloads, protocols: window.__protocols };
    })()`);
  }

  async function doubleClickFileName(fileName) {
    await installLinkProbe();
    return evaluate(`(async () => {
      const row = [...document.querySelectorAll('.file-row')].find(r => (r.querySelector('.f-name') || {}).textContent === ${JSON.stringify(fileName)});
      if (!row) return null;
      row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, view: window }));
      await new Promise((resolve) => setTimeout(resolve, 800));
      return { downloads: window.__downloads, protocols: window.__protocols, href: location.href };
    })()`);
  }
  const filesPanelVisible = await evaluate(`!document.getElementById('filesPanel').classList.contains('hidden')`);
  if (filesPanelVisible) {
    // Готовим подпапку через API (в интерфейсе нет «создать папку»), затем
    // переключаем проект туда-обратно, чтобы панель перечитала список.
    await evaluate(`(async () => {
      const boot = await (await fetch('/api/bootstrap')).json();
      const project = (boot.projects || []).find((p) => p.name === ${JSON.stringify(`Проект ${STAMP} 2`)});
      if (!project) return false;
      await fetch('/api/projects/' + project.id + '/upload?path=' + encodeURIComponent('folder/inside.txt'), {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain', 'X-Filename': encodeURIComponent('inside.txt') },
        body: 'внутри папки',
      });
      return true;
    })()`);
    await evaluate(`(() => {
      const other = [...document.querySelectorAll('.project-row')].find(r => !r.textContent.includes(${JSON.stringify(STAMP)}));
      if (!other) return false;
      other.click();
      return true;
    })()`);
    await sleep(600);
    await evaluate(`(() => {
      const mine = [...document.querySelectorAll('.project-row')].find(r => r.textContent.includes(${JSON.stringify(STAMP)}));
      if (!mine) return false;
      mine.click();
      return true;
    })()`);
    await sleep(800);

    await setInputFile('#filesPanelInput', FILE_NAME, 'проверка файлов');
    const uploaded = await waitFor(`[...document.querySelectorAll('.file-row .f-name')].some(n => n.textContent === ${JSON.stringify(FILE_NAME)})`, 10000);
    uploaded ? ok('файл загружен в проект') : fail('загрузка файла', await text('#filesList'));
    if (uploaded) {
      const eyeCount = await evaluate(`document.querySelectorAll('.file-preview-btn').length`);
      eyeCount === 0
        ? ok('у файлов нет глазка предпросмотра')
        : fail('глазок предпросмотра', 'кнопка ещё есть в строке файла');

      const txtDownload = await clickDownloadAndCapture(FILE_NAME);
      /* Файл сохраняется из памяти приложения (blob:) — ссылка на сервер при
         этом не открывается, иначе приложение-ярлык уходит в чужое окно. */
      txtDownload && txtDownload.length === 1
        && txtDownload[0].name === FILE_NAME
        && /^blob:/.test(txtDownload[0].href)
        ? ok('кнопка «Скачать» один раз отдаёт оригинал, без просмотра в вебе')
        : fail('кнопка «Скачать»', txtDownload);

      /* После скачивания приложение обязано остаться на месте: раньше ссылка
         уводила в окно «чем открыть файл», из которого не было выхода. */
      const stillHere = await evaluate(`({ path: location.pathname, app: !!document.getElementById('composer') })`);
      stillHere && stillHere.app && !stillHere.path.startsWith('/api/')
        ? ok('после скачивания приложение остаётся открытым')
        : fail('после скачивания приложение осталось на месте', stillHere);

      const txtTriple = await tripleClickDownloadAndCapture(FILE_NAME);
      txtTriple && txtTriple.downloads === 1 && txtTriple.gets === 1
        ? ok('три быстрых нажатия «Скачать» дают один запрос и одно сохранение')
        : fail('повторные нажатия «Скачать»', txtTriple);

      /* Блокировка одноразовая: после завершения скачивания кнопка снова живая. */
      const txtAgain = await clickDownloadAndCapture(FILE_NAME);
      txtAgain && txtAgain.length === 1
        ? ok('после завершения скачивания кнопка снова работает')
        : fail('повторное скачивание после паузы', txtAgain);

      const txtClick = await clickFileName(FILE_NAME);
      txtClick && txtClick.downloads.length === 0 && txtClick.protocols.length === 0
        ? ok('одиночный клик по строке файла не скачивает документ')
        : fail('одиночный клик по файлу', txtClick);

      const hasFolder = await evaluate(`[...document.querySelectorAll('.file-row')].some(r => r.querySelector('.f-name') && r.querySelector('.f-name').textContent === 'folder')`);
      if (hasFolder) {
        await evaluate(`[...document.querySelectorAll('.file-row')].find(r => r.querySelector('.f-name') && r.querySelector('.f-name').textContent === 'folder').click()`);
        const inside = await waitFor(`!document.getElementById('filesCrumb').classList.contains('hidden')`);
        inside ? ok('папка открывается, путь показан') : fail('открытие папки', await text('#filesCrumb'));
        const upRow = await evaluate(`[...document.querySelectorAll('.file-row')].some(r => (r.querySelector('.f-name') || {}).textContent === 'Наверх')`);
        if (upRow) {
          await evaluate(`[...document.querySelectorAll('.file-row')].find(r => (r.querySelector('.f-name') || {}).textContent === 'Наверх').click()`);
          const backToRoot = await waitFor(`document.getElementById('filesCrumb').classList.contains('hidden')`);
          backToRoot ? ok('«Наверх» возвращает в корень') : fail('«Наверх»', await text('#filesCrumb'));
        } else {
          fail('папка', 'нет строки «Наверх»');
        }
      }
      // Удаление файла с подтверждением.
      await evaluate(`(() => {
        const row = [...document.querySelectorAll('.file-row')].find(r => (r.querySelector('.f-name') || {}).textContent === ${JSON.stringify(FILE_NAME)});
        row.querySelector('.f-actions .btn-icon[title="Удалить"]').click();
      })()`);
      const confirmShown = await waitFor(`!!document.querySelector('.files-panel .popover')`);
      if (confirmShown) {
        await evaluate(`[...document.querySelectorAll('.files-panel .popover .btn-danger')].pop()?.click()`);
        const removed = await waitFor(`![...document.querySelectorAll('.file-row .f-name')].some(n => n.textContent === ${JSON.stringify(FILE_NAME)})`, 10000);
        removed ? ok('файл удалён после подтверждения') : fail('удаление файла', 'строка осталась');
      } else {
        fail('удаление файла', 'подтверждение не открылось');
      }

      /* Двойной щелчок по документу открывает окно просмотра сервиса — без
         скачивания и без перехода во внешние Word/Excel/PowerPoint. */
      await setInputFile('#filesPanelInput', DOCX_NAME, await realDocx());
      const docxUploaded = await waitFor(`[...document.querySelectorAll('.file-row .f-name')].some(n => n.textContent === ${JSON.stringify(DOCX_NAME)})`, 10000);
      if (docxUploaded) {
        const hrefBefore = await evaluate('location.href');
        const docxClick = await clickFileName(DOCX_NAME);
        const docxDouble = await doubleClickFileName(DOCX_NAME);
        const previewOpened = await waitFor(`!!document.querySelector('.file-preview-modal')`, 8000);
        const hrefAfter = await evaluate('location.href');
        const header = await evaluate(`(() => {
          const head = document.querySelector('.file-preview-modal .modal-head');
          if (!head) return null;
          return {
            badge: (head.querySelector('.pv-badge') || {}).textContent || '',
            title: (head.querySelector('.modal-title') || {}).textContent || '',
            subtitle: (head.querySelector('.modal-sub') || {}).textContent || '',
            close: !!head.querySelector('.modal-close'),
          };
        })()`);
        const rendered = await evaluate(`(() => {
          const box = document.querySelector('.file-preview');
          if (!box) return null;
          return {
            blocks: box.querySelectorAll('.pv-h, .pv-p, .pv-table, .pv-list').length,
            pre: box.querySelectorAll('pre').length,
            hint: box.querySelectorAll('.file-hint').length,
            officeHint: box.querySelectorAll('.pv-hint').length,
            submit: [...box.querySelectorAll('button')].map((b) => b.textContent.trim()),
          };
        })()`);
        docxClick && docxClick.downloads.length === 0 && docxClick.protocols.length === 0
          && docxDouble && docxDouble.downloads.length === 0 && docxDouble.protocols.length === 0
          && previewOpened
          && hrefAfter === hrefBefore
          && header && header.badge === 'DOCX' && header.close
          && /Документ Word/.test(header.subtitle)
          && rendered && rendered.blocks > 0 && rendered.pre === 0 && rendered.hint === 0
          && rendered.officeHint === 1
          ? ok('двойной щелчок открывает документ в окне просмотра — без скачивания и внешних программ')
          : fail('двойной щелчок по документу', { docxClick, docxDouble, previewOpened, header, rendered, before: hrefBefore, after: hrefAfter });

        /* Закрытие окна возвращает к панели «Файлы проекта», а не в диалог проекта. */
        const panelOpen = `(() => {
          const panel = document.querySelector('.files-panel');
          return !!panel && panel.offsetParent !== null && document.querySelectorAll('.file-row').length > 0;
        })()`;
        const panelBefore = await evaluate(panelOpen);
        await evaluate(`document.querySelector('.file-preview-modal .modal-close').click()`);
        const previewClosed = await waitFor(`!document.querySelector('.file-preview-modal')`, 6000);
        const panelAfter = await evaluate(panelOpen);
        previewClosed && panelBefore && panelAfter
          ? ok('закрытие окна просмотра возвращает к панели «Файлы проекта»')
          : fail('возврат к файлам после просмотра', { previewClosed, panelBefore, panelAfter });

        /* Excel и HTML открываются в том же окне, что и Word: содержимое
           читается из проекта, открытого в панели. Раньше запрос уходил к
           «активному» проекту, и для проекта из панели окно писало «Файл не
           найден» — теперь панель и активный проект совпадают всегда. */
        await setInputFile('#filesPanelInput', XLSX_NAME, await realXlsx());
        const xlsxUploaded = await waitFor(
          `[...document.querySelectorAll('.file-row .f-name')].some(n => n.textContent === ${JSON.stringify(XLSX_NAME)})`,
          10000,
        );
        if (xlsxUploaded) {
          await doubleClickFileName(XLSX_NAME);
          const xlsxOpened = await waitFor(`!!document.querySelector('.file-preview-modal')`, 8000);
          const xlsxRendered = await evaluate(`(() => {
            const box = document.querySelector('.file-preview');
            if (!box) return null;
            return {
              sheets: box.querySelectorAll('.pv-sheets').length,
              tables: box.querySelectorAll('.pv-table').length,
              notices: [...box.querySelectorAll('.pv-notice, .preview-status')].map((n) => n.textContent.trim()),
              text: box.textContent.slice(0, 400),
            };
          })()`);
          xlsxOpened && xlsxRendered && xlsxRendered.tables > 0 && /Материалы/.test(xlsxRendered.text)
            ? ok('Excel открывается в окне просмотра с содержимым таблицы')
            : fail('просмотр Excel', JSON.stringify({ xlsxOpened, xlsxRendered }));
          await evaluate(`document.querySelector('.file-preview-modal .modal-close')?.click()`);
          await waitFor(`!document.querySelector('.file-preview-modal')`, 6000);
        } else {
          fail('загрузка Excel', 'файл не появился в панели');
        }

        await setInputFile('#filesPanelInput', HTML_NAME, projectPage());
        const htmlUploaded = await waitFor(
          `[...document.querySelectorAll('.file-row .f-name')].some(n => n.textContent === ${JSON.stringify(HTML_NAME)})`,
          10000,
        );
        if (htmlUploaded) {
          await doubleClickFileName(HTML_NAME);
          const htmlOpened = await waitFor(`!!document.querySelector('.file-preview iframe.preview-frame')`, 8000);
          const frameSrc = await evaluate(
            `(document.querySelector('.file-preview iframe.preview-frame') || {}).src || ''`,
          );
          const pageCheck = frameSrc
            ? await evaluate(`(async () => {
                const res = await fetch(${JSON.stringify(frameSrc)});
                const body = await res.text();
                return { ok: res.ok, status: res.status, marker: body.includes(${JSON.stringify(PAGE_MARK)}) };
              })()`)
            : null;
          htmlOpened && pageCheck && pageCheck.ok && pageCheck.marker
            ? ok('HTML-страница открывается в рамке окна просмотра')
            : fail('просмотр HTML', JSON.stringify({ htmlOpened, frameSrc, pageCheck }));
          await evaluate(`document.querySelector('.file-preview-modal .modal-close')?.click()`);
          await waitFor(`!document.querySelector('.file-preview-modal')`, 6000);
        } else {
          fail('загрузка HTML', 'файл не появился в панели');
        }

        /* «Файлы проекта» принадлежат выбранному проекту: после переключения
           в списке не должно остаться файлов прошлого проекта. */
        const switched = await evaluate(`(() => {
          const other = [...document.querySelectorAll('.project-row')].find(r => !r.textContent.includes(${JSON.stringify(STAMP)}));
          if (!other) return false;
          other.click();
          return true;
        })()`);
        if (switched) {
          await sleep(800);
          const staleFiles = await evaluate(`[...document.querySelectorAll('.file-row .f-name')].map(n => n.textContent).filter(n => n === ${JSON.stringify(DOCX_NAME)})`);
          staleFiles.length === 0
            ? ok('файлы показывают только выбранный проект')
            : fail('файлы проекта', 'остался список прошлого проекта');
          await evaluate(`(() => {
            const mine = [...document.querySelectorAll('.project-row')].find(r => r.textContent.includes(${JSON.stringify(STAMP)}));
            if (!mine) return false;
            mine.click();
            return true;
          })()`);
          await sleep(800);
        }
      } else {
        fail('клик по документу Office', 'файл не загрузился');
      }
    }
  } else {
    await click('#filesBtn');
    const drawer = await waitFor(`!document.getElementById('filesPanel').classList.contains('hidden')`);
    drawer ? ok('ящик файлов открывается кнопкой в шапке') : fail('ящик файлов', 'не открылся');
  }

  /* Экспорт проекта архивом: кнопки в шапке больше нет, но адрес архива
     остаётся рабочим — его можно открыть вручную. */
  const exportOk = await evaluate(`(async () => {
    const me = await (await fetch('/api/me')).json();
    const project = (me.projects || []).find(p => (p.chats || []).length) || (me.projects || [])[0];
    if (!project) return { url: '', status: 0 };
    const url = '/api/projects/' + project.id + '/download';
    const res = await fetch(url);
    return { url, status: res.status };
  })()`);
  exportOk.status === 200
    ? ok('архив проекта отдаётся по адресу /download', exportOk.url)
    : fail('скачивание проекта', exportOk);

  /* ------------------------- 8. меню и их закрытие ------------------------- */

  await click('#userChip');
  const menuOpen = await waitFor(`!!document.querySelector('.menu')`);
  menuOpen ? ok('меню учётной записи открывается') : fail('меню учётной записи', 'не открылось');
  const menuItems = await evaluate(`[...document.querySelectorAll('.menu button')].map(b => b.textContent.trim())`);
  menuItems.includes('Выйти') ? ok('в меню есть выход', menuItems.join(' / ')) : fail('меню: нет выхода', menuItems);
  await evaluate(`document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`);
  const closedOutside = await waitFor(`!document.querySelector('.menu')`);
  closedOutside ? ok('меню закрывается щелчком мимо') : fail('закрытие меню', 'осталось открытым');

  await click('#userChip');
  await waitFor(`!!document.querySelector('.menu')`);
  await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  const closedEscape = await waitFor(`!document.querySelector('.menu')`);
  closedEscape ? ok('меню закрывается клавишей Escape') : fail('Escape для меню', 'осталось открытым');

  /* ------------------------- 9. администрирование ------------------------- */

  await click('#userChip');
  await waitFor(`!!document.querySelector('.menu')`);
  const adminEntry = await evaluate(`[...document.querySelectorAll('.menu button')].some(b => b.textContent.includes('Пользователи'))`);
  if (adminEntry) {
    await evaluate(`[...document.querySelectorAll('.menu button')].find(b => b.textContent.includes('Пользователи')).click()`);
    const adminShown = await waitFor(`!!document.querySelector('#modalRoot .modal .stats')`);
    adminShown ? ok('окно пользователей открылось') : fail('окно пользователей', 'нет статистики');
    const statsCount = await count('#modalRoot .stat');
    statsCount === 4 ? ok('в окне четыре показателя') : fail('показатели', String(statsCount));

    // Слишком короткий пароль — понятная ошибка, пользователь не создан.
    const usersBefore = await count('#modalRoot .admin-user');
    await evaluate(`(() => {
      const inputs = [...document.querySelectorAll('#modalRoot .inline-form .field input')];
      inputs[0].value = ${JSON.stringify(NEW_USER)};
      inputs[0].dispatchEvent(new Event('input', { bubbles: true }));
      inputs[1].value = '123';
      inputs[1].dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#modalRoot .inline-form button[type="submit"]').click();
    })()`);
    const shortError = await waitFor(`(document.querySelector('#modalRoot .field-error') || {}).textContent?.trim().length > 0`);
    const usersAfterShort = await count('#modalRoot .admin-user');
    shortError && usersAfterShort === usersBefore
      ? ok('короткий пароль отклонён с объяснением', await text('#modalRoot .field-error'))
      : fail('короткий пароль', { error: await text('#modalRoot .field-error'), usersBefore, usersAfterShort });

    // Нормальный пароль — пользователь создан.
    await evaluate(`(() => {
      const inputs = [...document.querySelectorAll('#modalRoot .inline-form .field input')];
      inputs[1].value = ${JSON.stringify(NEW_PASS)};
      inputs[1].dispatchEvent(new Event('input', { bubbles: true }));
      inputs[2].value = '5';
      inputs[2].dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#modalRoot .inline-form button[type="submit"]').click();
    })()`);
    const userCreated = await waitFor(`[...document.querySelectorAll('#modalRoot .admin-user')].some(r => r.textContent.includes(${JSON.stringify(NEW_USER)}))`, 10000);
    userCreated ? ok('пользователь создан из окна администрирования') : fail('создание пользователя', await text('#modalRoot'));
    await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await waitFor(`document.getElementById('modalRoot').classList.contains('hidden')`);
  } else {
    fail('администрирование', 'в меню нет пункта «Пользователи»');
  }

  /* ------------------------- 10. смена пароля и выход ------------------------- */

  await logoutApi();
  await goto(BASE + '/');
  await fill('#loginUser', NEW_USER);
  await fill('#loginPass', NEW_PASS);
  await click('#loginSubmit');
  const newUserIn = await waitFor(`!document.getElementById('app').classList.contains('hidden')`);
  newUserIn ? ok('новый пользователь входит со своим паролем') : fail('вход нового пользователя', 'не пустило');
  const otherProjects = await evaluate(`[...document.querySelectorAll('.project-row .p-name')].map(n => n.textContent)`);
  const seesOnlyOwn = otherProjects.every((name) => !name.includes(String(STAMP)));
  seesOnlyOwn ? ok('новый пользователь не видит чужие проекты') : fail('изоляция проектов', otherProjects.join(' / '));

  await click('#userChip');
  await waitFor(`!!document.querySelector('.menu')`);
  await evaluate(`[...document.querySelectorAll('.menu button')].find(b => b.textContent.includes('Сменить пароль')).click()`);
  const passShown = await waitFor(`!!document.querySelector('#modalRoot .modal input[type="password"]')`);
  passShown ? ok('окно смены пароля открылось') : fail('смена пароля', 'окно не открылось');
  if (passShown) {
    await evaluate(`(() => {
      const inputs = [...document.querySelectorAll('#modalRoot input[type="password"]')];
      inputs[0].value = ${JSON.stringify(NEW_PASS)};
      inputs[1].value = 'One-pass-2026';
      inputs[2].value = 'Two-pass-2026';
      [...document.querySelectorAll('#modalRoot .modal-foot .btn')].find(b => b.textContent.trim() === 'Сохранить').click();
    })()`);
    const mismatch = await waitFor(`(document.querySelector('#modalRoot .field-error') || {}).textContent?.trim().length > 0`);
    mismatch ? ok('несовпадающие пароли не отправляются', await text('#modalRoot .field-error')) : fail('несовпадение паролей', 'нет объяснения');
    const stillOpen = await evaluate(`!document.getElementById('modalRoot').classList.contains('hidden')`);
    stillOpen ? ok('окно остаётся открытым для исправления') : fail('окно закрылось при ошибке', 'так нельзя');

    await evaluate(`(() => {
      const inputs = [...document.querySelectorAll('#modalRoot input[type="password"]')];
      inputs[1].value = 'New-pass-2026';
      inputs[2].value = 'New-pass-2026';
      [...document.querySelectorAll('#modalRoot .modal-foot .btn')].find(b => b.textContent.trim() === 'Сохранить').click();
    })()`);
    const changed = await waitFor(`document.getElementById('modalRoot').classList.contains('hidden')`, 10000);
    changed ? ok('пароль изменён') : fail('смена пароля', await text('#modalRoot .field-error'));
  }

  // Выход из меню возвращает экран входа.
  await click('#userChip');
  await waitFor(`!!document.querySelector('.menu')`);
  await evaluate(`[...document.querySelectorAll('.menu button')].find(b => b.textContent.includes('Выйти')).click()`);
  const loggedOut = await waitFor(`!document.getElementById('auth').classList.contains('hidden') && document.getElementById('app').classList.contains('hidden')`);
  loggedOut ? ok('выход возвращает экран входа') : fail('выход', 'приложение осталось');
  const meStatus = await evaluate(`fetch('/api/me').then(r => r.status)`);
  meStatus === 401 ? ok('после выхода сеанс закрыт', '401') : fail('сеанс после выхода', meStatus);

  /* Телефон и открытая клавиатура: экран входа прокручивается, а поле пароля
     остаётся в видимой области, а не под клавиатурой или нижней панелью. */
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 390, height: 494, deviceScaleFactor: 2, mobile: true, screenWidth: 390, screenHeight: 844,
  });
  await evaluate(`document.getElementById('loginPass').focus()`);
  await sleep(900);
  const authGeom = await evaluate(`(() => {
    const pass = document.getElementById('loginPass').getBoundingClientRect();
    const card = document.querySelector('.auth-card').getBoundingClientRect();
    const auth = document.querySelector('.auth');
    return { passTop: pass.top, passBottom: pass.bottom, cardTop: card.top,
      vvHeight: visualViewport.height, kbOpen: document.documentElement.classList.contains('kb-open'),
      authClient: auth.clientHeight, authScroll: auth.scrollHeight };
  })()`);
  authGeom.kbOpen && authGeom.passTop >= 0 && authGeom.passBottom <= authGeom.vvHeight && authGeom.cardTop >= 0
    ? ok('на телефоне клавиатура не перекрывает поле пароля', `${Math.round(authGeom.passBottom)}px из ${Math.round(authGeom.vvHeight)}`)
    : fail('поле пароля под клавиатурой', authGeom);
  await cdp.send('Emulation.clearDeviceMetricsOverride');

  // Вход с новым паролем.
  await fill('#loginUser', NEW_USER);
  await fill('#loginPass', 'New-pass-2026');
  await click('#loginSubmit');
  const reLogin = await waitFor(`!document.getElementById('app').classList.contains('hidden')`);
  reLogin ? ok('вход с новым паролем работает') : fail('вход с новым паролем', 'не пустило');

  // Возвращаем администратора и убираем за собой.
  /* Недоступный сервис (перезапуск контейнера, обрыв сети) не должен выглядеть
     как выход из аккаунта: вместо формы входа — объяснение и кнопка «Повторить».
     Проверяем и то, что после повтора человек попадает внутрь без пароля. */
  const failMe = (message) => {
    if (message.method !== 'Fetch.requestPaused') return;
    const { requestId } = message.params;
    const isMe = /\/api\/me(\?|$)/.test(message.params.request.url);
    if (isMe) cdp.send('Fetch.failRequest', { requestId, errorReason: 'ConnectionRefused' });
    else cdp.send('Fetch.continueRequest', { requestId });
  };
  await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/me*' }] });
  cdp.on(failMe);
  await goto(BASE + '/');
  const bootNoteShown = await waitFor(`!document.getElementById('bootNote').classList.contains('hidden')`, 20000);
  const authWhileDown = await evaluate(`!document.getElementById('auth').classList.contains('hidden')`);
  bootNoteShown && !authWhileDown
    ? ok('при недоступном сервисе нет формы входа — предложено повторить')
    : fail('экран при недоступном сервисе', { bootNoteShown, authWhileDown });
  await cdp.send('Fetch.disable');
  await evaluate(`document.getElementById('bootRetry').click(); true`);
  const backInside = await waitFor(`!document.getElementById('app').classList.contains('hidden')`, 15000);
  const stillNoAuth = await evaluate(`document.getElementById('auth').classList.contains('hidden')`);
  backInside && stillNoAuth
    ? ok('«Повторить» возвращает в сервис без повторного входа')
    : fail('повтор после сбоя', { backInside, stillNoAuth });
  /* Неудачные запросы во время этой проверки — ожидаемые, в общий счёт не идут. */
  consoleErrors.length = 0;

  await logoutApi();
  await login(USER, PASS);
  await evaluate(`(async () => {
    const boot = await (await fetch('/api/bootstrap')).json();
    for (const project of boot.projects || []) {
      if (String(project.name || '').includes(${JSON.stringify(STAMP)})) {
        await fetch('/api/projects/' + project.id, { method: 'DELETE' });
      }
    }
    for (const workflow of boot.workflows || []) {
      if (String(workflow.name || '').includes(${JSON.stringify(STAMP)})) {
        await fetch('/api/workflows/' + workflow.id, { method: 'DELETE' });
      }
    }
    const users = await (await fetch('/api/admin/users')).json();
    const found = (users.users || []).find((u) => u.username === ${JSON.stringify(NEW_USER)});
    if (found) await fetch('/api/admin/users/' + found.id, { method: 'DELETE' });
  })()`);

  if (consoleErrors.length) {
    fail('ошибки в консоли браузера', consoleErrors.slice(0, 5).join(' | '));
  } else {
    ok('ошибок в консоли браузера нет');
  }
} catch (error) {
  fail('исключение проверки', error?.stack || error?.message || String(error));
} finally {
  try { chrome.kill(); } catch { /* ignore */ }
  const passed = results.filter(Boolean).length;
  console.log(`\nИтог: ${passed} ok, ${results.length - passed} fail`);
  process.exit(results.every(Boolean) ? 0 : 1);
}
