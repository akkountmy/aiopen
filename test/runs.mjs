/**
 * Проверка «живых задач»: ответ выполняет сервис, а не вкладка.
 *
 * Что проверяем:
 *  - обрыв соединения (перезагрузка страницы, уход в другой проект) задачу не
 *    прерывает, а ответ всё равно сохраняется в диалог;
 *  - вкладка подключается к идущей задаче, получает уже готовый текст и
 *    догоняет остаток без повторов и потерь;
 *  - к одной задаче могут подключиться две вкладки (ноутбук и телефон);
 *  - задача останавливается кнопкой «Стоп», а не закрытием окна;
 *  - повторная отправка в занятый диалог получает 429 с идентификатором задачи;
 *  - после перезапуска сервиса незавершённая задача честно помечается прерванной.
 *
 * Поднимает поддельную модель (OpenAI-совместимый поток) и отдельный экземпляр
 * сервиса на временных данных, поэтому настоящие данные и ключи не нужны.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const MODEL_PORT = 3401;
const APP_PORT = 3402;
const BASE = `http://127.0.0.1:${APP_PORT}`;
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dshow-runs-'));
const ADMIN = { username: 'DSH', password: 'TestPass-12345' };
const UA = {
  laptop:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36',
  phone:
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.7827.137 Mobile Safari/537.36',
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const DEBUG = process.env.DSHOW_TEST_DEBUG === '1';
const trace = (...args) => {
  if (DEBUG) console.log('[подробно]', ...args);
};

let failures = 0;
function check(ok, label, extra = '') {
  console.log(`${ok ? '  ok ' : '  ПРОВАЛ '}${label}${extra ? ' — ' + extra : ''}`);
  if (!ok) failures += 1;
}

/* ------------------------- поддельная модель ------------------------- */

/* Ответ собирается из кусочков с паузой: этого хватает, чтобы успеть оборвать
   соединение на середине и проверить догон. */
const WORDS = ['Делимобиль ', '— ', 'это ', 'краткосрочная ', 'аренда ', 'машины ', 'по ', 'минутам. ', 'Поездка ', 'заняла ', 'двадцать ', 'минут.'];
let modelStreams = 0;

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
    trace('модель: запрос', body.stream === false ? 'заголовок диалога' : 'поток ответа');
    /* Заголовок диалога запрашивается без потока — отвечаем обычным JSON. */
    if (body.stream === false) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          choices: [{ message: { content: 'Аренда машин по минутам' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 20, completion_tokens: 6 },
        }),
      );
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    let index = 0;
    let closed = false;
    modelStreams += 1;
    /* Отмену работы ловим на ответе: req 'close' приходит сразу после чтения
       тела запроса, а не при обрыве соединения. */
    res.on('close', () => {
      closed = true;
    });
    const timer = setInterval(() => {
      if (closed) {
        clearInterval(timer);
        modelStreams -= 1;
        return;
      }
      if (index < WORDS.length) {
        const delta = { choices: [{ index: 0, delta: { content: WORDS[index] } }] };
        res.write(`data: ${JSON.stringify(delta)}\n\n`);
        index += 1;
        return;
      }
      clearInterval(timer);
      modelStreams -= 1;
      res.write(
        `data: ${JSON.stringify({
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 400, completion_tokens: 60 },
        })}\n\n`,
      );
      res.write('data: [DONE]\n\n');
      res.end();
    }, 90);
  });
});

/* --------------------------- экземпляр сервиса --------------------------- */

function startApp() {
  const child = spawn(process.execPath, ['server.mjs'], {
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
  child.stderr.on('data', (chunk) => {
    const line = String(chunk);
    if (!/ExperimentalWarning|localstorage/.test(line)) process.stderr.write(`[сервис] ${line}`);
  });
  return child;
}

let app = null;

async function waitReady() {
  for (let i = 0; i < 80; i += 1) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return;
    } catch {
      /* сервис ещё поднимается */
    }
    await sleep(250);
  }
  throw new Error('сервис не поднялся');
}

/* ------------------------------ запросы ------------------------------ */

async function login(ua = UA.laptop) {
  const r = await fetch(`${BASE}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': ua },
    body: JSON.stringify(ADMIN),
  });
  const cookies = (r.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]);
  return cookies.join('; ');
}

async function api(path, { cookie, method = 'GET', body } = {}) {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  return { status: r.status, data };
}

/* Поток событий задачи: собираем всё до конца или до обрыва. */
async function readRunStream(response, { abortAfterEvents = 0 } = {}) {
  const events = [];
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let ended = false;
  while (true) {
    /* Ожидание данных ограничено: если поток замолчал, проверка должна упасть
       с понятным сообщением, а не зависнуть. */
    const chunk = await Promise.race([reader.read(), sleep(8000).then(() => 'timeout')]);
    if (chunk === 'timeout') break;
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    const blocks = buffer.split('\n\n');
    buffer = blocks.pop() || '';
    for (const block of blocks) {
      for (const line of block.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload) continue;
        let event;
        try {
          event = JSON.parse(payload);
        } catch {
          continue;
        }
        events.push(event);
        trace('событие', event.type, event.text || event.title || event.status || '');
        if (event.type === 'end') ended = true;
        if (abortAfterEvents && events.length >= abortAfterEvents) {
          /* Чтение не ждём: соединение всё равно сейчас оборвём. */
          try {
            reader.cancel();
          } catch {
            /* ignore */
          }
          return { events, ended: false };
        }
      }
    }
  }
  return { events, ended };
}

let chatId = '';

/* Запуск задачи в диалоге: возвращает идентификатор и открытое соединение. */
async function startRun(cookie, text) {
  const controller = new AbortController();
  const response = await fetch(`${BASE}/api/chats/${chatId}/messages`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json', 'user-agent': UA.laptop },
    body: JSON.stringify({ text, attachmentIds: [] }),
    signal: controller.signal,
  });
  return { response, controller, runId: response.headers.get('x-dshow-run') };
}

async function waitFinished(cookie, timeout = 12000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const { data } = await api('/api/runs', { cookie });
    if (!(data.runs || []).length) return true;
    await sleep(150);
  }
  return false;
}

function assistantOf(chat) {
  return (chat.messages || []).filter((m) => m.role === 'assistant');
}

/* -------------------------------- сценарий -------------------------------- */

model.listen(MODEL_PORT, '127.0.0.1');

try {
  app = startApp();
  await waitReady();

  const laptop = await login(UA.laptop);
  const phone = await login(UA.phone);

  const project = (await api('/api/projects', { cookie: laptop, method: 'POST', body: { name: 'Задачи' } })).data.project;
  const chat = (await api(`/api/projects/${project.id}/chats`, { cookie: laptop, method: 'POST', body: {} })).data.chat;
  chatId = chat.id;
  check(Boolean(chatId), 'диалог создан');

  /* 1. Обрыв соединения посреди ответа — задача продолжается. */
  const first = await startRun(laptop, 'Расскажи про Делимобиль');
  check(Boolean(first.runId), 'сервис вернул идентификатор задачи');
  const firstRead = await readRunStream(first.response, { abortAfterEvents: 4 });
  first.controller.abort();
  check(firstRead.events.some((e) => e.type === 'delta'), 'вкладка получила первые куски ответа');

  await sleep(250);
  const liveAfterDrop = (await api('/api/runs', { cookie: laptop })).data.runs;
  check(liveAfterDrop.some((r) => r.id === first.runId && r.status === 'running'), 'после обрыва задача идёт дальше');
  check(
    (await api('/api/runs', { cookie: phone })).data.runs.some((r) => r.id === first.runId),
    'задачу видно и с другого устройства',
  );

  check(await waitFinished(laptop), 'задача завершилась без вкладки');
  const firstChat = (await api(`/api/chats/${chatId}`, { cookie: laptop })).data.chat;
  const firstAnswer = assistantOf(firstChat).pop();
  check(Boolean(firstAnswer?.content?.includes('Делимобиль')), 'ответ сохранён в диалог после обрыва', `${firstAnswer?.content?.length || 0} символов`);

  /* 2. Подключение к идущей задаче: снимок + догон без потерь и повторов. */
  const second = await startRun(laptop, 'И снова про Делимобиль');
  await sleep(500);
  /* Соединение вкладки обрываем — так выглядит перезагрузка страницы. */
  second.controller.abort();

  const attach = await fetch(`${BASE}/api/runs/${second.runId}/stream`, { headers: { cookie: laptop } });
  check(attach.status === 200, 'подключение к идущей задаче принято', `HTTP ${attach.status}`);
  const attached = await readRunStream(attach);
  const snapshot = attached.events.find((e) => e.type === 'snapshot');
  check(Boolean(snapshot?.run?.text), 'снимок отдал уже готовый текст', `${snapshot?.run?.text?.length || 0} символов`);
  const streamed = attached.events.filter((e) => e.type === 'delta').map((e) => e.text).join('');
  const total = (snapshot?.run?.text || '') + streamed;
  check(
    attached.ended,
    'поток закрылся сам после завершения задачи',
    attached.events.map((e) => e.type).join(','),
  );

  const secondChat = (await api(`/api/chats/${chatId}`, { cookie: laptop })).data.chat;
  const secondAnswer = assistantOf(secondChat).pop();
  check(secondAnswer?.content === total, 'догон совпал с сохранённым ответом', `онлайн ${total.length}, в диалоге ${secondAnswer?.content?.length || 0}`);

  /* Повторное подключение к завершённой задаче: снимок полный, повторов нет. */
  const again = await fetch(`${BASE}/api/runs/${second.runId}/stream`, { headers: { cookie: laptop } });
  const againRead = await readRunStream(again);
  const againSnapshot = againRead.events.find((e) => e.type === 'snapshot');
  check(againSnapshot?.run?.text === secondAnswer?.content, 'повторный снимок отдал полный ответ');
  check(againRead.ended && !againRead.events.some((e) => e.type === 'delta'), 'завершённая задача не повторяет текст');

  /* 3. Две вкладки на одной задаче (ноутбук и телефон). */
  const third = await startRun(laptop, 'Делимобиль с телефона');
  await sleep(300);
  const phoneAttach = await fetch(`${BASE}/api/runs/${third.runId}/stream`, { headers: { cookie: phone } });
  const phoneRead = await readRunStream(phoneAttach);
  const phoneSnapshot = phoneRead.events.find((e) => e.type === 'snapshot');
  check(Boolean(phoneSnapshot?.run?.text), 'второе устройство получило тот же ответ');
  third.controller.abort();
  await waitFinished(laptop);

  /* 4. «Стоп» останавливает задачу на сервере. */
  const fourth = await startRun(laptop, 'Длинная задача');
  await sleep(400);
  fourth.controller.abort();
  const stopped = await api(`/api/runs/${fourth.runId}/stop`, { cookie: laptop, method: 'POST' });
  check(stopped.status === 200 && stopped.data.ok, 'стоп принят сервисом');
  check(await waitFinished(laptop), 'задача снялась с выполнения');
  const stoppedChat = (await api(`/api/chats/${chatId}`, { cookie: laptop })).data.chat;
  const stoppedAnswer = assistantOf(stoppedChat).pop();
  check(Boolean(stoppedAnswer), 'прерванный ответ всё равно попал в диалог');
  const stoppedRun = (await api(`/api/runs/${fourth.runId}`, { cookie: laptop })).data.run;
  check(stoppedRun?.status === 'stopped', 'задача помечена остановленной', stoppedRun?.status);

  /* 5. Повторная отправка в занятый диалог: 429 с идентификатором задачи. */
  const fifth = await startRun(laptop, 'Ещё одна задача');
  await sleep(300);
  fourth.controller.abort();
  fifth.controller.abort();
  const busy = await api(`/api/chats/${chatId}/messages`, {
    cookie: laptop,
    method: 'POST',
    body: { text: 'Вторая попытка', attachmentIds: [] },
  });
  check(busy.status === 429, 'второй ответ в занятом диалоге не запускается', `HTTP ${busy.status}`);
  check(busy.data.run?.id === fifth.runId, 'клиенту отдан идентификатор идущей задачи');
  await waitFinished(laptop);

  /* 6. Перезапуск сервиса посреди задачи: честная пометка вместо вечного «идёт». */
  const sixth = await startRun(laptop, 'Задача, которую прервёт перезапуск');
  await sleep(400);
  sixth.controller.abort();
  app.kill();
  await sleep(700);
  app = startApp();
  await waitReady();
  /* Как после перезагрузки страницы: сначала загрузка состояния — она же
     возвращает честные пометки о задачах, прерванных перезапуском сервиса. */
  const boot = await api('/api/me', { cookie: laptop });
  check(boot.status === 200, 'после перезапуска сервиса вход сохранился', `HTTP ${boot.status}`);
  const afterRestart = (await api(`/api/chats/${chatId}`, { cookie: laptop })).data.chat;
  const interrupted = assistantOf(afterRestart).pop();
  check(Boolean(interrupted?.interrupted), 'после перезапуска ответ помечен прерванным');
  check(
    (afterRestart?.messages || []).some((m) => m.role === 'user' && m.content.includes('перезапуск')),
    'человеческий вопрос остался в диалоге',
  );
  /* Список проектов приходит в загрузке состояния — так же, как его видит
     вкладка после перезагрузки страницы. */
  const projects = boot.data.projects || [];
  const tracked = projects.find((p) => p.id === project.id)?.chats || [];
  check(
    tracked.some((c) => c.id === chatId && !c.running),
    'признак «идёт работа» снят после перезапуска',
    `проектов ${projects.length}, диалогов ${tracked.length}, статус ${tracked.find((c) => c.id === chatId)?.running}`,
  );
} catch (error) {
  console.error('ошибка проверки:', error.stack || error.message);
  failures += 1;
} finally {
  if (app) app.kill();
  model.close();
  await sleep(300);
  try {
    fs.rmSync(DIR, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

console.log(failures ? `\nПровалов: ${failures}` : '\nВсё прошло');
process.exit(failures ? 1 : 0);
