/**
 * Живая проверка в настоящем Chrome: задача переживает перезагрузку страницы и
 * переключение проекта.
 *
 * Сценарий повторяет жалобу пользователя:
 *   1. отправили задачу — пошёл ответ;
 *   2. перезагрузили страницу — ответ не пропал, а продолжился (вкладка
 *      подключилась к задаче на сервере);
 *   3. ушли в другой проект во время ответа — задача продолжилась, в списке
 *      горит точка «идёт», при возвращении ответ на месте.
 *
 * Поднимает поддельную модель (медленный поток), отдельный экземпляр сервиса и
 * headless Chrome через DevTools-протокол. Настоящие данные не трогаются.
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const MODEL_PORT = 3407;
const APP_PORT = 3408;
const CDP_PORT = 9433;
const BASE = `http://127.0.0.1:${APP_PORT}`;
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dshow-ui-runs-'));
const ADMIN = { username: 'DSH', password: 'TestPass-12345' };
const STAMP = Date.now().toString().slice(-6);
const SECOND_PROJECT = `Второй проект ${STAMP}`;

const CHROME_CANDIDATES = [
  path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
];
const CHROME = CHROME_CANDIDATES.find((candidate) => fs.existsSync(candidate));
if (!CHROME) {
  console.log('  --  Chrome/Edge не найден, живая проверка пропущена');
  process.exit(0);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let failures = 0;
function ok(label, extra = '') {
  console.log(`  ok  ${label}${extra ? ' — ' + extra : ''}`);
}
function fail(label, detail) {
  failures += 1;
  console.log(`  ПРОВАЛ ${label}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
}
const check = (good, label, detail) => (good ? ok(label, detail) : fail(label, detail));

/* ------------------------------ модель ------------------------------ */

/* Кусочки идут медленно: за время ответа успевает произойти перезагрузка
   страницы и переключение проекта. */
const WORDS = ['Делимобиль ', '— ', 'это ', 'краткосрочная ', 'аренда ', 'машины ', 'по ', 'минутам. ', 'Поездка ', 'заняла ', 'двадцать ', 'минут, ', 'машина ', 'вернулась ', 'на ', 'парковку.'];
const ANSWER = WORDS.join('');
const model = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    let body = {};
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      body = {};
    }
    if (body.stream === false) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: 'Аренда машин по минутам' }, finish_reason: 'stop' }] }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    let index = 0;
    const timer = setInterval(() => {
      if (res.writableEnded || res.destroyed) {
        clearInterval(timer);
        return;
      }
      if (index < WORDS.length) {
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: WORDS[index] } }] })}\n\n`);
        index += 1;
        return;
      }
      clearInterval(timer);
      res.write(
        `data: ${JSON.stringify({
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 400, completion_tokens: 60 },
        })}\n\n`,
      );
      res.write('data: [DONE]\n\n');
      res.end();
    }, 320);
  });
});
model.listen(MODEL_PORT, '127.0.0.1');

const app = spawn(process.execPath, ['server.mjs'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    DSHOW_PORT: String(APP_PORT),
    DSHOW_HOST: '127.0.0.1',
    DSHOW_DATA_DIR: DIR,
    DSHOW_ADMIN_USER: ADMIN.username,
    DSHOW_ADMIN_PASSWORD: ADMIN.password,
    DSHOW_TRUST_PROXY: '0',
    DSHOW_MODEL_BASE: `http://127.0.0.1:${MODEL_PORT}`,
    DSHOW_DEEPSEEK_KEY: 'test-key',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
app.stderr.on('data', (chunk) => {
  const line = String(chunk);
  if (!/ExperimentalWarning|localstorage/.test(line)) process.stderr.write(`[сервис] ${line}`);
});

const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshow-ui-runs-profile-'));
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    `--remote-debugging-port=${CDP_PORT}`,
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
  for (let i = 0; i < 80; i += 1) {
    try {
      const pages = (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()).filter((t) => t.type === 'page');
      if (pages.length) return pages[0].webSocketDebuggerUrl;
    } catch {
      /* ещё стартует */
    }
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
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
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
    on(listener) {
      listeners.add(listener);
    },
    close() {
      socket.close();
    },
  };
}

let cdp = null;
let loaded = false;
const pageErrors = [];
const apiLog = [];

async function evaluate(expression) {
  const result = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result.value;
}

async function goto(url) {
  loaded = false;
  await cdp.send('Page.navigate', { url });
  for (let i = 0; i < 140 && !loaded; i += 1) await sleep(70);
  await sleep(350);
}

/* Настоящая перезагрузка (F5), а не переход по адресу: приложение отличает
   новый запуск сайта — тогда показывается стартовый экран — от возврата на ту
   же страницу, когда открывается прежний диалог. Page.navigate даёт тип
   «navigate» и проверял бы не перезагрузку, а первый вход. */
async function reload() {
  loaded = false;
  await cdp.send('Page.reload', { ignoreCache: false });
  for (let i = 0; i < 140 && !loaded; i += 1) await sleep(70);
  await sleep(350);
}

async function waitFor(expression, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await evaluate(expression)) return true;
    } catch {
      /* страница перезагружается */
    }
    await sleep(120);
  }
  return false;
}

const fill = (selector, value) =>
  evaluate(`(() => {
    const node = document.querySelector(${JSON.stringify(selector)});
    if (!node) throw new Error('нет ${selector}');
    node.focus();
    node.value = ${JSON.stringify(value)};
    node.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);

const click = (selector) =>
  evaluate(`(() => {
    const node = document.querySelector(${JSON.stringify(selector)});
    if (!node) throw new Error('нет ${selector}');
    node.click();
    return true;
  })()`);

const count = (selector) => evaluate(`document.querySelectorAll(${JSON.stringify(selector)}).length`);
/* Длина последнего показанного ответа — выражение для страницы, чтобы ждать
   роста текста, не перечитывая его целиком. */
const ANSWER_LEN = `(() => {
    const nodes = [...document.querySelectorAll('#thread .msg-assistant .md')];
    return nodes.length ? nodes[nodes.length - 1].textContent.length : 0;
  })()`;
const answerText = () =>
  evaluate(`(() => {
    const nodes = [...document.querySelectorAll('#thread .msg-assistant .md')];
    return nodes.length ? nodes[nodes.length - 1].textContent : '';
  })()`);

const projectRow = (name) =>
  `[...document.querySelectorAll('.project-row')].find((row) => (row.querySelector('.p-name') || {}).textContent?.includes(${JSON.stringify(name)}))`;

/* Диагностика при провале: что видно на странице в этот момент. */
async function dumpPage(tag) {
  const info = await evaluate(`(() => ({
    thread: ((document.querySelector('#thread') || {}).textContent || '').slice(0, 260),
    toasts: [...document.querySelectorAll('.toast')].map((n) => n.textContent.trim()).slice(0, 4),
    chats: document.querySelectorAll('.chat-row').length,
    projects: document.querySelectorAll('.project-row').length,
    input: (document.querySelector('#input') || {}).value,
    sendHidden: Boolean((document.querySelector('#sendBtn') || {}).classList?.contains('hidden')),
    projectClasses: [...document.querySelectorAll('.project')].map((n) => n.className),
    chatLive: document.querySelectorAll('.chat-row .c-live').length,
  }))()`);
  console.log(`  [${tag}]`, JSON.stringify(info));
  console.log(`  [${tag}] api:`, apiLog.slice(-30).join(' | ') || 'нет запросов');
}

async function clickProject(name) {
  await evaluate(`(() => {
    const row = ${projectRow(name)};
    if (!row) throw new Error('нет проекта ' + ${JSON.stringify(name)});
    row.click();
    return true;
  })()`);
}

async function openFirstChatOf(name) {  await evaluate(`(() => {
    const project = [...document.querySelectorAll('.project')].find((p) =>
      (p.querySelector('.p-name') || {}).textContent?.includes(${JSON.stringify(name)}));
    if (!project) throw new Error('нет проекта ' + ${JSON.stringify(name)});
    const row = project.querySelector('.chat-row');
    if (!row) throw new Error('нет диалога в проекте ' + ${JSON.stringify(name)});
    row.click();
    return true;
  })()`);
}

try {
  for (let i = 0; i < 80; i += 1) {
    try {
      if ((await fetch(`${BASE}/api/health`)).ok) break;
    } catch {
      /* поднимается */
    }
    await sleep(250);
  }

  cdp = connect(await pageWs());
  await cdp.ready;
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Network.enable');
  cdp.on((msg) => {
    if (msg.method === 'Page.loadEventFired') loaded = true;
    if (msg.method === 'Runtime.exceptionThrown') {
      pageErrors.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
    }
    if (msg.method === 'Network.requestWillBeSent') {
      const request = msg.params.request;
      if (request.url.includes('/api/')) {
        apiLog.push(`#${msg.params.requestId} -> ${request.method} ${request.url.replace(BASE, '')}`);
      }
    }
    if (msg.method === 'Network.responseReceived') {
      const response = msg.params.response;
      if (response.url.includes('/api/')) apiLog.push(`#${msg.params.requestId} <- ${response.status}`);
    }
  });

  await goto(BASE);
  await waitFor(`!!document.querySelector('#loginUser')`);
  await fill('#loginUser', ADMIN.username);
  await fill('#loginPass', ADMIN.password);
  await click('#loginSubmit');
  check(await waitFor(`!!document.querySelector('#input')`, 15000), 'вход через интерфейс выполнен');
  await waitFor(`document.querySelectorAll('.project-row').length > 0`, 8000);
  const firstProject = ((await evaluate(`(document.querySelector('.project-row .p-name') || {}).textContent || ''`)) || '').trim();
  check(Boolean(firstProject), 'рабочий проект найден', firstProject);
  if (process.env.DSHOW_TEST_DEBUG) console.log('  [вход] api:', apiLog.join(' | '));

  /* ---------------- 1. ответ идёт, страницу перезагружаем ---------------- */

  await fill('#input', 'Расскажи про Делимобиль');
  await click('#sendBtn');
  const streaming = await waitFor(`!!document.querySelector('#thread .msg-assistant.streaming')`, 15000);
  check(streaming, 'ответ пошёл');
  if (!streaming) await dumpPage('нет ответа');
  const typed = await waitFor(`${ANSWER_LEN} > 5`, 15000);
  const beforeReload = typed ? await answerText() : '';
  check(beforeReload.length > 0, 'в ответе уже есть текст', `${beforeReload.length} символов`);
  check((await count('.chat-row .c-live')) === 1, 'в списке диалогов горит точка «идёт задача»');

  /* Сама перезагрузка: как F5 в браузере. */
  await reload();
  const restored = await waitFor(`document.querySelectorAll('#thread .msg-assistant .md').length > 0`, 15000);
  check(restored, 'после перезагрузки открылся тот же диалог с ответом');
  const afterReload = await answerText();
  check(afterReload.length > 0, 'уже полученный текст на месте', `${afterReload.length} символов`);
  const stillLive = await waitFor(`!!document.querySelector('.chat-row .c-live')`, 4000);
  check(stillLive, 'вкладка снова подключилась к идущей задаче');

  const grew = await waitFor(`${ANSWER_LEN} > ${afterReload.length + 5}`, 12000);
  check(grew, 'ответ продолжил печататься после перезагрузки');

  const finished = await waitFor(`!document.querySelector('#thread .msg-assistant.streaming')`, 20000);
  check(finished, 'задача дошла до конца');
  check(await waitFor(`!document.querySelector('#stopBtn') || document.querySelector('#stopBtn').classList.contains('hidden')`, 4000), 'кнопка «Стоп» снова спрятана');
  check((await count('.chat-row .c-live')) === 0, 'точка «идёт задача» погасла');
  const finalText = await answerText();
  check(finalText.includes('парковку'), 'в диалоге полный ответ', `${finalText.trim().slice(0, 48)}…`);

  const saved = await evaluate(`(async () => {
    const boot = await (await fetch('/api/me')).json();
    for (const project of boot.projects) {
      for (const chat of project.chats) {
        const data = await (await fetch('/api/chats/' + chat.id)).json();
        const answers = (data.chat.messages || []).filter((m) => m.role === 'assistant' && m.content);
        if (answers.length) return answers[answers.length - 1].content;
      }
    }
    return '';
  })()`);
  check(saved === finalText, 'показанный ответ совпадает с сохранённым на сервере');
  check(pageErrors.length === 0, 'ошибок в консоли страницы нет', pageErrors.slice(0, 2).join(' | '));

  /* ------------- 2. во время ответа уходим в другой проект ------------- */

  await click('#newProjectBtn');
  await waitFor(`!!document.querySelector('.sidebar .popover input')`);
  await fill('.sidebar .popover input', SECOND_PROJECT);
  await evaluate(`(() => {
    const input = document.querySelector('.sidebar .popover input');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    return true;
  })()`);
  check(
    await waitFor(`!!${projectRow(SECOND_PROJECT)}`, 8000),
    'второй проект создан',
  );

  /* Возвращаемся в первый проект и запускаем задачу. */
  await clickProject(firstProject);
  await openFirstChatOf(firstProject);
  check(await waitFor(`!!document.querySelector('#input')`), 'рабочий диалог открыт');
  await fill('#input', 'И ещё раз про Делимобиль');
  await click('#sendBtn');
  check(await waitFor(`!!document.querySelector('#thread .msg-assistant.streaming')`, 12000), 'вторая задача пошла');

  /* Уходим в другой проект, пока ответ печатается. */
  await clickProject(SECOND_PROJECT);
  check(
    await waitFor(`(document.querySelector('.project.active .p-name') || {}).textContent?.includes(${JSON.stringify(SECOND_PROJECT)})`, 6000),
    'открылся другой проект',
  );
  /* Точка появляется, как только сервис принял задачу и вкладка её отметила, —
     поэтому ждём её, а не заглядываем один раз. */
  const markedLive = await waitFor(`document.querySelectorAll('.project.live').length === 1`, 8000);
  check(markedLive, 'у первого проекта видна точка «идёт задача»', `проектов ${await count('.project')}`);
  if (!markedLive) await dumpPage('нет точки у проекта');
  check((await count('.msg-assistant.streaming')) === 0, 'в другом проекте ответ не показывается');
  check((await evaluate(`document.querySelector('#sendBtn').classList.contains('hidden')`)) === false, 'поле ввода доступно в другом проекте');

  /* Возвращаемся в первый проект: ответ должен быть на месте. */
  await clickProject(firstProject);
  await openFirstChatOf(firstProject);
  check(
    await waitFor(`document.querySelector('#thread .msg-assistant .md') && document.querySelector('#thread .msg-assistant .md').textContent.length > 0`, 8000),
    'в первом проекте ответ на месте после возвращения',
  );
  check(await waitFor(`!document.querySelector('#thread .msg-assistant.streaming')`, 20000), 'вторая задача завершилась');
  const secondFinal = await answerText();
  check(secondFinal.includes('парковку'), 'второй ответ полный', `${secondFinal.trim().slice(0, 40)}…`);
} catch (error) {
  fail('сценарий', error.stack || error.message);
} finally {
  if (cdp) cdp.close();
  chrome.kill();
  app.kill();
  model.close();
  await sleep(400);
  for (const dir of [DIR, profileDir]) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

console.log(failures ? `\nПровалов: ${failures}` : '\nВсё прошло');
process.exit(failures ? 1 : 0);

