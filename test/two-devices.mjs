/* Проверка совместной работы с компьютера и телефона под одним аккаунтом:
   два устройства держат сеансы одновременно и могут вести РАЗНЫЕ диалоги
   параллельно. Внутри одного диалога ответ всегда один, а третий параллельный
   ответ упирается в потолок на аккаунт.

   Модель заменена заглушкой, поэтому токены не тратятся. Запуск:
   node test/two-devices.mjs */
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';

const STUB_PORT = 3291;
const APP_PORT = 3292;
const BASE = `http://127.0.0.1:${APP_PORT}`;
const ROOT = path.resolve(import.meta.dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dshow-twodev-'));
const ADMIN = { username: 'twodev', password: 'TwoDev-12345' };
const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
/* Заглушка отвечает медленно — чтобы два ответа гарантированно пересеклись. */
const SLOW_MS = 900;

let passed = 0;
const failures = [];

function ok(name, details = '') {
  passed += 1;
  console.log(`  ok  ${name}${details ? ` — ${details}` : ''}`);
}

function fail(name, error) {
  failures.push(`${name}: ${error}`);
  console.log(`  FAIL ${name} — ${error}`);
}

function startStub() {
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      let body = {};
      try {
        body = JSON.parse(raw || '{}');
      } catch {
        body = {};
      }
      const delay = body.stream === false ? 20 : SLOW_MS;
      setTimeout(() => {
        if (res.writableEnded) return;
        if (body.stream === false) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ choices: [{ message: { content: 'Диалог' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
          return;
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Готово.' } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 10 } })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      }, delay);
    });
  });
  return new Promise((resolve) => server.listen(STUB_PORT, '127.0.0.1', () => resolve(server)));
}

function startApp() {
  const child = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], {
    cwd: ROOT,
    env: {
      ...process.env,
      DSHOW_HOST: '127.0.0.1',
      DSHOW_PORT: String(APP_PORT),
      DSHOW_DATA_DIR: TMP,
      DSHOW_ADMIN_USER: ADMIN.username,
      DSHOW_ADMIN_PASSWORD: ADMIN.password,
      DSHOW_DEEPSEEK_KEY: 'test-key',
      DSHOW_MODEL_BASE: `http://127.0.0.1:${STUB_PORT}`,
      DSHOW_MODEL: 'stub-model',
      DSHOW_TASK_LIMIT_USD: '5',
      DSHOW_TASK_STEP_USD: '5',
      DSHOW_TG_TOKEN: '',
      DSHOW_TG_CHAT: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (chunk) => process.stderr.write(`[сервис] ${chunk}`));
  return child;
}

async function waitForHealth(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BASE}/api/health`);
      if (response.ok) return await response.json();
    } catch {
      /* ещё стартует */
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('сервис не ответил на /api/health');
}

async function api(cookie, ua, pathname, { method = 'GET', body } = {}) {
  const headers = { 'user-agent': ua };
  if (cookie) headers.cookie = cookie;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(`${BASE}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = { text };
  }
  const setCookie = response.headers.getSetCookie ? response.headers.getSetCookie()[0] || '' : '';
  return { status: response.status, data, text, cookie: setCookie.split(';')[0] };
}

async function login(ua) {
  const result = await api('', ua, '/api/login', { method: 'POST', body: ADMIN });
  return { status: result.status, cookie: result.cookie, data: result.data };
}

function openStream(cookie, ua, chatId, text) {
  return fetch(`${BASE}/api/chats/${chatId}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': ua, cookie },
    body: JSON.stringify({ text }),
  });
}

async function readStream(response) {
  const events = [];
  let text = '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index = buffer.indexOf('\n\n');
    while (index !== -1) {
      const chunk = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 2);
      index = buffer.indexOf('\n\n');
      if (!chunk.startsWith('data:')) continue;
      const payload = chunk.slice(5).trim();
      if (payload === '[DONE]') continue;
      try {
        const event = JSON.parse(payload);
        events.push(event);
        if (event.type === 'delta' && event.text) text += event.text;
      } catch {
        /* неполный кадр */
      }
    }
  }
  return { events, text };
}

let stub;
let app;

try {
  stub = await startStub();
  app = startApp();
  const health = await waitForHealth();
  ok('сервис поднялся', `сеансы: ${JSON.stringify(health.sessions)}`);

  const desktop = await login(DESKTOP_UA);
  desktop.status === 200 ? ok('вход с компьютера') : fail('вход с компьютера', JSON.stringify(desktop.data));
  const mobile = await login(MOBILE_UA);
  mobile.status === 200 ? ok('вход с телефона') : fail('вход с телефона', JSON.stringify(mobile.data));

  const deskMe = await api(desktop.cookie, DESKTOP_UA, '/api/me');
  const mobMe = await api(mobile.cookie, MOBILE_UA, '/api/me');
  deskMe.status === 200 && mobMe.status === 200
    ? ok('оба сеанса живут одновременно')
    : fail('одновременные сеансы', `компьютер ${deskMe.status}, телефон ${mobMe.status}`);

  const project = await api(desktop.cookie, DESKTOP_UA, '/api/projects', { method: 'POST', body: { name: 'Два устройства' } });
  const projectId = project.data?.project?.id;
  projectId ? ok('проект создан') : fail('проект', JSON.stringify(project.data));

  const chats = [];
  for (const title of ['Ноутбук', 'Телефон', 'Резерв']) {
    const chat = await api(desktop.cookie, DESKTOP_UA, `/api/projects/${projectId}/chats`, { method: 'POST', body: { title } });
    chats.push(chat.data?.chat?.id);
  }
  chats.every(Boolean) ? ok('три диалога созданы') : fail('диалоги', JSON.stringify(chats));

  /* Компьютер ведёт диалог A, телефон — диалог B, оба одновременно. */
  const streamA = openStream(desktop.cookie, DESKTOP_UA, chats[0], 'Задача с ноутбука');
  const streamB = openStream(mobile.cookie, MOBILE_UA, chats[1], 'Задача с телефона');

  const [responseA, responseB] = await Promise.all([streamA, streamB]);
  responseA.status === 200 && responseB.status === 200
    ? ok('оба устройства начали ответ одновременно')
    : fail('параллельный запуск', `компьютер ${responseA.status}, телефон ${responseB.status}`);

  /* Пока идут два ответа: повтор в тот же диалог и третий диалог. */
  const sameChat = await api(desktop.cookie, DESKTOP_UA, `/api/chats/${chats[0]}/messages`, {
    method: 'POST',
    body: { text: 'Ещё раз в тот же диалог' },
  });
  sameChat.status === 429 && /этом диалоге/.test(sameChat.data?.error || '')
    ? ok('второй ответ в том же диалоге заблокирован', String(sameChat.status))
    : fail('блокировка одного диалога', `${sameChat.status} ${JSON.stringify(sameChat.data)}`);

  const third = await api(mobile.cookie, MOBILE_UA, `/api/chats/${chats[2]}/messages`, {
    method: 'POST',
    body: { text: 'Третий параллельный ответ' },
  });
  third.status === 429 && /Сейчас идёт 2/.test(third.data?.error || '')
    ? ok('потолок на аккаунт — два ответа', String(third.status))
    : fail('потолок на аккаунт', `${third.status} ${JSON.stringify(third.data)}`);

  const [doneA, doneB] = await Promise.all([readStream(responseA), readStream(responseB)]);
  doneA.events.some((event) => event.type === 'done') && doneB.events.some((event) => event.type === 'done')
    ? ok('оба ответа дошли до конца')
    : fail('завершение ответов', JSON.stringify(doneA.events.slice(-2)));
  doneA.text.includes('Готово.') && doneB.text.includes('Готово.')
    ? ok('каждое устройство получило свой ответ')
    : fail('текст ответов', `${doneA.text} / ${doneB.text}`);

  const chatA = await api(desktop.cookie, DESKTOP_UA, `/api/chats/${chats[0]}`);
  const chatB = await api(mobile.cookie, MOBILE_UA, `/api/chats/${chats[1]}`);
  const savedA = (chatA.data?.chat?.messages || []).some((m) => m.role === 'assistant' && /Готово/.test(m.content || ''));
  const savedB = (chatB.data?.chat?.messages || []).some((m) => m.role === 'assistant' && /Готово/.test(m.content || ''));
  savedA && savedB ? ok('ответы сохранены в своих диалогах') : fail('сохранение', `${savedA} / ${savedB}`);

  /* Освободившиеся места снова доступны. */
  const afterFree = await openStream(mobile.cookie, MOBILE_UA, chats[2], 'Одна задача после освобождения');
  if (afterFree.status !== 200) {
    fail('повтор после завершения', `${afterFree.status} ${await afterFree.text()}`.slice(0, 160));
  } else {
    const doneC = await readStream(afterFree);
    doneC.events.some((event) => event.type === 'done')
      ? ok('после завершения новая задача идёт')
      : fail('повтор после завершения', JSON.stringify(doneC.events.slice(-2)));
  }

  const stillOk = await api(desktop.cookie, DESKTOP_UA, '/api/me');
  stillOk.status === 200 ? ok('сеанс компьютера не пострадал') : fail('сеанс компьютера', String(stillOk.status));
} catch (error) {
  fail('тест выполнился без исключений', String(error?.message || error));
} finally {
  if (app) app.kill();
  if (stub) stub.close();
  await new Promise((resolve) => setTimeout(resolve, 200));
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\nИтог: ${passed} ok, ${failures.length} провалов`);
  process.exitCode = failures.length ? 1 : 0;
}

function addressOf(result) {
  return JSON.stringify(result.data).slice(0, 160);
}
