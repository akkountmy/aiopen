/* Проверка очереди задач в диалоге.
   Тест поднимает настоящий сервер и маленькую заглушку модели: без неё первая
   задача заканчивалась бы раньше, чем вторая успевала встать в очередь.

   Что проверяем:
   — вторая просьба во время ответа не теряется, а получает 202 и встаёт в очередь;
   — очередь хранится в диалоге и переживает перезапрос;
   — текст задачи можно изменить и задачу можно убрать;
   — после «Стоп» очередь не запускается сама и ждёт ручной кнопки;
   — ручной запуск выполняет задачу, а следующая из очереди стартует после неё.

   Запуск: node test/queue.mjs */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.DSHOW_TEST_PORT || 3297);
const MOCK_PORT = Number(process.env.DSHOW_MOCK_PORT || 3298);
const BASE = `http://127.0.0.1:${PORT}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshow-queue-'));

/* Заглушка модели: отвечает потоком через полсекунды, чтобы задача жила
   достаточно долго. Короткие служебные запросы (заголовок, проверка) получают
   обычный JSON. */
const mock = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => {
    raw += chunk.toString();
  });
  req.on('end', () => {
    let body = {};
    try {
      body = JSON.parse(raw || '{}');
    } catch {
      body = {};
    }
    if (body.stream === false) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          choices: [{ message: { role: 'assistant', content: 'Короткий ответ' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
        }),
      );
      return;
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    const timer = setTimeout(() => {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Готово.' } }] })}\n\n`);
      res.write(
        `data: ${JSON.stringify({
          choices: [{ delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
        })}\n\n`,
      );
      res.write('data: [DONE]\n\n');
      res.end();
    }, 3500);
    res.on('close', () => {
      if (!res.writableEnded) clearTimeout(timer);
    });
  });
});

const env = {
  ...process.env,
  DSHOW_HOST: '127.0.0.1',
  DSHOW_PORT: String(PORT),
  DSHOW_DATA_DIR: dataDir,
  DSHOW_ADMIN_USER: 'tester',
  DSHOW_ADMIN_PASSWORD: 'Test12345',
  DSHOW_TG_TOKEN: '',
  DSHOW_TG_CHAT: '',
  DSHOW_DEEPSEEK_KEY: 'test-key',
  DSHOW_MODEL_BASE: `http://127.0.0.1:${MOCK_PORT}/v1`,
  DSHOW_DASHBOARD: '0',
  OPENROUTER_API_KEY: '',
};

const server = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], {
  cwd: ROOT,
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
server.stdout.on('data', (chunk) => {
  log += chunk.toString();
});
server.stderr.on('data', (chunk) => {
  log += chunk.toString();
});

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

async function waitReady() {
  for (let i = 0; i < 120; i += 1) {
    try {
      const response = await fetch(`${BASE}/api/health`);
      if (response.ok) return true;
    } catch {
      /* сервер ещё поднимается */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

function cookieValue(response, name) {
  const headers = response.headers.getSetCookie ? response.headers.getSetCookie() : [];
  for (const header of headers) {
    const match = header.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
    if (match) return decodeURIComponent(match[1]);
  }
  return '';
}

async function call(pathname, { method = 'GET', body, cookie } = {}) {
  const init = { method, headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0) Chrome/131' } };
  if (cookie) init.headers.cookie = cookie;
  if (body !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const response = await fetch(`${BASE}${pathname}`, init);
  const text = await response.text();
  let data = {};
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text.slice(0, 300) };
  }
  return { status: response.status, data };
}

async function login(username, password) {
  const response = await fetch(`${BASE}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': 'Mozilla/5.0 (Windows NT 10.0) Chrome/131' },
    body: JSON.stringify({ username, password }),
  });
  const text = await response.text();
  let data = {};
  try {
    data = JSON.parse(text);
  } catch {
    data = {};
  }
  return { status: response.status, data, session: cookieValue(response, 'dshow_session') };
}

async function waitFor(predicate, timeoutMs = 12000, stepMs = 150) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  return null;
}

async function postMessage(cookie, chatId, text) {
  const response = await fetch(`${BASE}/api/chats/${chatId}/messages`, {
    method: 'POST',
    headers: {
      cookie,
      'content-type': 'application/json',
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0) Chrome/131',
    },
    body: JSON.stringify({ text }),
  });
  return response;
}

async function stopRun(cookie, runId) {
  return call(`/api/runs/${runId}/stop`, { method: 'POST', cookie, body: {} });
}

try {
  await new Promise((resolve) => mock.listen(MOCK_PORT, '127.0.0.1', resolve));
  if (!(await waitReady())) throw new Error(`сервер не поднялся\n${log.slice(-1200)}`);

  const admin = await login('tester', 'Test12345');
  check('вход администратора', admin.status === 200 && Boolean(admin.session), `HTTP ${admin.status}`);
  const cookie = `dshow_session=${admin.session}`;

  const project = await call('/api/projects', { method: 'POST', cookie, body: { name: 'Очередь' } });
  const projectId = project.data.project?.id;
  check('проект создан', Boolean(projectId), String(projectId));
  const created = await call(`/api/projects/${projectId}/chats`, { method: 'POST', cookie, body: {} });
  const chatId = created.data.chat?.id;
  check('диалог создан', Boolean(chatId), String(chatId));

  /* Первая задача: держим её живой, пока ставим вторую. */
  const first = await postMessage(cookie, chatId, 'Первая задача');
  const firstRun = first.headers.get('x-dshow-run') || '';
  check('первая задача запущена', first.status === 200 && Boolean(firstRun), `HTTP ${first.status}`);
  const firstDone = first.text().catch(() => '');

  const second = await postMessage(cookie, chatId, 'Вторая задача');
  const secondData = await second.json().catch(() => ({}));
  check('вторая задача встала в очередь', second.status === 202 && secondData.queue?.length === 1, `HTTP ${second.status} ${JSON.stringify(secondData).slice(0, 160)}`);
  check('текст второй задачи сохранён', secondData.queue?.[0]?.text === 'Вторая задача', String(secondData.queue?.[0]?.text));
  const queuedId = secondData.queue?.[0]?.id || '';

  const chat = await call(`/api/chats/${chatId}`, { cookie });
  check('очередь видна при перезапросе', chat.data.chat?.queue?.length === 1, JSON.stringify(chat.data.chat?.queue || []));
  check('очередь не попала в сообщения', !(chat.data.chat?.messages || []).some((message) => message.content === 'Вторая задача'), '');
  check('живой запуск виден в диалоге', chat.data.chat?.run?.id === firstRun, String(chat.data.chat?.run?.id || ''));

  const edited = await call(`/api/chats/${chatId}/queue/${queuedId}`, {
    method: 'PATCH',
    cookie,
    body: { text: 'Вторая задача — уточнённая' },
  });
  check('текст в очереди редактируется', edited.status === 200 && edited.data.queue?.[0]?.text === 'Вторая задача — уточнённая', `HTTP ${edited.status}`);

  const removed = await call(`/api/chats/${chatId}/queue/${queuedId}`, { method: 'DELETE', cookie });
  check('задача убирается из очереди', removed.status === 200 && removed.data.queue?.length === 0, `HTTP ${removed.status}`);

  /* Две задачи, чтобы проверить и паузу после «Стоп», и автозапуск следующей. */
  const q1 = await postMessage(cookie, chatId, 'Вторая задача');
  const q1Data = await q1.json().catch(() => ({}));
  const q2 = await postMessage(cookie, chatId, 'Третья задача');
  const q2Data = await q2.json().catch(() => ({}));
  check('в очереди две задачи', q1Data.queue?.length === 1 && q2.status === 202 && q2Data.queue?.length === 2, JSON.stringify(q2Data.queue || []));

  const stopped = await stopRun(cookie, firstRun);
  check('задача останавливается', stopped.status === 200, `HTTP ${stopped.status}`);
  await firstDone;
  const paused = await waitFor(async () => {
    const fresh = await call(`/api/chats/${chatId}`, { cookie });
    return !fresh.data.chat?.run ? fresh.data.chat : null;
  }, 8000);
  check('после остановки запуск снят', Boolean(paused), '');
  await new Promise((resolve) => setTimeout(resolve, 900));
  const stillPaused = await call(`/api/chats/${chatId}`, { cookie });
  check('после «Стоп» очередь не стартует сама', !stillPaused.data.chat?.run && stillPaused.data.chat?.queue?.length === 2, `run=${stillPaused.data.chat?.run?.id || ''}, queue=${stillPaused.data.chat?.queue?.length || 0}`);

  const qid = stillPaused.data.chat.queue[0].id;
  const manual = await fetch(`${BASE}/api/chats/${chatId}/queue/${qid}/run`, {
    method: 'POST',
    headers: { cookie, 'user-agent': 'Mozilla/5.0 (Windows NT 10.0) Chrome/131' },
  });
  const manualRun = manual.headers.get('x-dshow-run') || '';
  check('задача из очереди запускается вручную', manual.status === 200 && Boolean(manualRun), `HTTP ${manual.status}`);
  const manualDone = manual.text().catch(() => '');

  const finished = await waitFor(async () => {
    const fresh = await call(`/api/chats/${chatId}`, { cookie });
    const texts = (fresh.data.chat?.messages || []).filter((message) => message.role === 'user').map((message) => message.content);
    if (fresh.data.chat?.run || (fresh.data.chat?.queue || []).length) return null;
    return texts.includes('Вторая задача') && texts.includes('Третья задача') ? texts : null;
  }, 20000);
  check('следующая задача стартовала автоматически', Boolean(finished), JSON.stringify(finished || []));
  await manualDone;

  const clean = await call(`/api/chats/${chatId}`, { cookie });
  check('очередь опустела', (clean.data.chat?.queue || []).length === 0, JSON.stringify(clean.data.chat?.queue || []));

  await call(`/api/chats/${chatId}`, { method: 'DELETE', cookie });
  await call(`/api/projects/${projectId}`, { method: 'DELETE', cookie });
} catch (error) {
  console.error('Сбой теста:', error.message);
  console.error(log.slice(-2000));
  results.push({ name: 'тест', ok: false, detail: error.message });
} finally {
  server.kill();
  mock.close();
}

const failed = results.filter((item) => !item.ok);
console.log(`\nИтого: ${results.length - failed.length} ok, ${failed.length} fail`);
if (failed.length) process.exit(1);
