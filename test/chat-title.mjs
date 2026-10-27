/**
 * Название нового диалога.
 *
 * Проверяет три вещи:
 *   1. по первой реплике диалог получает имя, а не остаётся «Новый диалог»;
 *   2. если модель названия недоступна, остаётся запасное имя из реплики;
 *   3. имя, данное человеком, автоматика не перезаписывает.
 *
 * Заглушка модели и временная папка данных: тест не тратит деньги и не трогает
 * рабочий сервис.
 *   node test/chat-title.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STUB_PORT = 3221;
const APP_PORT = 3222;
const BASE = `http://127.0.0.1:${APP_PORT}`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dshow-title-'));

let passed = 0;
const failures = [];
let failTitles = false;
let genericTitles = false;
let labelledTitles = false;
let cookie = '';

function ok(name, details = '') {
  passed += 1;
  console.log(`  ok  ${name}${details ? ` — ${details}` : ''}`);
}

function fail(name, error) {
  failures.push(`${name}: ${error}`);
  console.log(`  FAIL ${name} — ${error}`);
}

async function test(name, fn) {
  try {
    await fn();
  } catch (error) {
    fail(name, error.message);
  }
}

/* ---------- заглушка модели ---------- */

function startStub() {
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      let body = {};
      try {
        body = JSON.parse(raw || '{}');
      } catch {
        body = {};
      }
      const system = String(body.messages?.[0]?.content || '');

      /* Название диалога — обычный нестримовый ответ. */
      if (!body.stream && system.includes('Придумай короткое название')) {
        if (failTitles) {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'название недоступно' }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: genericTitles
                    ? 'Новый диалог'
                    : labelledTitles
                      ? 'Вот название:\nПроверка диалогов'
                      : 'Проверка диалогов',
                },
              },
            ],
          }),
        );
        return;
      }

      /* Конспект истории и прочие служебные вызовы. */
      if (!body.stream) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            choices: [{ message: { content: 'Ок.' } }],
            usage: { prompt_tokens: 10, completion_tokens: 2 },
          }),
        );
        return;
      }

      /* Ответ агента — поток SSE, как у настоящего API. */
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Готово.' } }] })}\n\n`);
      res.write(
        `data: ${JSON.stringify({
          choices: [{ delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 30, completion_tokens: 2 },
        })}\n\n`,
      );
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  return new Promise((resolve) => server.listen(STUB_PORT, '127.0.0.1', () => resolve(server)));
}

/* ---------- сервис ---------- */

function startApp() {
  const child = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], {
    cwd: ROOT,
    env: {
      ...process.env,
      DSHOW_HOST: '127.0.0.1',
      DSHOW_PORT: String(APP_PORT),
      DSHOW_DATA_DIR: TMP,
      DSHOW_ADMIN_USER: 'titleadmin',
      DSHOW_ADMIN_PASSWORD: 'title-pass-123456',
      DSHOW_DEEPSEEK_KEY: 'test-key',
      DSHOW_MODEL_BASE: `http://127.0.0.1:${STUB_PORT}`,
      DSHOW_MODEL: 'stub-model',
      DSHOW_MODEL_PRO: '',
      DSHOW_ESCALATE: '0',
      DSHOW_REVIEW: '0',
      DSHOW_TASK_STATE: '0',
    },
    stdio: 'ignore',
  });
  return child;
}

async function waitForApp() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`${BASE}/api/health`);
      if (response.ok) return;
    } catch {
      /* сервис ещё поднимается */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('сервис не поднялся');
}

async function api(pathname, { method = 'GET', body } = {}) {
  const init = { method, headers: { cookie } };
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const response = await fetch(`${BASE}${pathname}`, init);
  const setCookies = response.headers.getSetCookie ? response.headers.getSetCookie() : [];
  if (setCookies.length) cookie = setCookies.map((item) => item.split(';')[0]).join('; ');
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${method} ${pathname} → ${response.status} ${data.error || ''}`);
  return data;
}

async function login() {
  await api('/api/login', {
    method: 'POST',
    body: { username: 'titleadmin', password: 'title-pass-123456' },
  });
}

async function sendMessage(chatId, text) {
  const response = await fetch(`${BASE}/api/chats/${chatId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ text }),
  });
  if (!response.ok) throw new Error(`сообщение → ${response.status}`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const titles = [];
  let buffer = '';
  let ended = false;
  const deadline = Date.now() + 20000;
  while (!ended) {
    if (Date.now() > deadline) throw new Error('задача не завершилась за 20 с');
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const blocks = buffer.split('\n\n');
    buffer = blocks.pop() || '';
    for (const block of blocks) {
      for (const line of block.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const event = JSON.parse(line.slice(5).trim());
        if (event.type === 'title') titles.push(event.title);
        if (event.type === 'end') ended = true;
      }
    }
  }
  return titles;
}

async function main() {
  const stub = await startStub();
  const app = startApp();
  try {
    await waitForApp();
    await login();
    const { project } = await api('/api/projects', { method: 'POST', body: { name: 'Названия диалогов' } });

    await test('новый диалог начинается без имени', async () => {
      const { chat } = await api(`/api/projects/${project.id}/chats`, { method: 'POST', body: {} });
      if (chat.title !== 'Новый диалог') throw new Error(`title=${chat.title}`);
      ok('пустой диалог называется «Новый диалог»');
    });

    await test('первая реплика даёт название по теме', async () => {
      const { chat } = await api(`/api/projects/${project.id}/chats`, { method: 'POST', body: {} });
      const titles = await sendMessage(chat.id, 'Собери отчёт по продажам за март');
      const saved = await api(`/api/chats/${chat.id}`);
      if (!titles.length) throw new Error('сервер не прислал событие title');
      if (saved.chat.title !== 'Проверка диалогов') throw new Error(`title=${saved.chat.title}`);
      ok('название пришло от модели', titles.join(' → '));
    });

    await test('пометка «Вот название» не попадает в имя', async () => {
      labelledTitles = true;
      try {
        const { chat } = await api(`/api/projects/${project.id}/chats`, { method: 'POST', body: {} });
        await sendMessage(chat.id, 'Собери отчёт по продажам за март');
        const saved = await api(`/api/chats/${chat.id}`);
        if (saved.chat.title !== 'Проверка диалогов') throw new Error(`title=${saved.chat.title}`);
        ok('многострочный ответ модели разобран', saved.chat.title);
      } finally {
        labelledTitles = false;
      }
    });

    await test('сбой модели не оставляет диалог безымянным', async () => {
      failTitles = true;
      try {
        const { chat } = await api(`/api/projects/${project.id}/chats`, { method: 'POST', body: {} });
        const titles = await sendMessage(chat.id, 'Собери отчёт по продажам за март');
        const saved = await api(`/api/chats/${chat.id}`);
        if (!titles.length) throw new Error('нет запасного названия');
        if (saved.chat.title !== 'Отчёт по продажам за март') throw new Error(`title=${saved.chat.title}`);
        ok('запасное название по реплике', saved.chat.title);
      } finally {
        failTitles = false;
      }
    });

    await test('модель не может вернуть безымянный диалог', async () => {
      genericTitles = true;
      try {
        const { chat } = await api(`/api/projects/${project.id}/chats`, { method: 'POST', body: {} });
        await sendMessage(chat.id, 'Собери отчёт по продажам за март');
        const saved = await api(`/api/chats/${chat.id}`);
        if (saved.chat.title !== 'Отчёт по продажам за март') throw new Error(`title=${saved.chat.title}`);
        ok('ответ «Новый диалог» не затёр запасное имя', saved.chat.title);
      } finally {
        genericTitles = false;
      }
    });

    await test('имя, данное человеком, не перезаписывается', async () => {
      const { chat } = await api(`/api/projects/${project.id}/chats`, {
        method: 'POST',
        body: { title: 'Мой диалог' },
      });
      const titles = await sendMessage(chat.id, 'Собери отчёт по продажам за март');
      const saved = await api(`/api/chats/${chat.id}`);
      if (titles.length) throw new Error(`автоматика прислала title: ${titles.join(', ')}`);
      if (saved.chat.title !== 'Мой диалог') throw new Error(`title=${saved.chat.title}`);
      ok('ручное имя осталось', saved.chat.title);
    });
  } finally {
    app.kill();
    stub.close();
  }

  console.log(`\nИтого: ${passed} ok, ${failures.length} fail`);
  if (failures.length) {
    console.error(failures.join('\n'));
    process.exitCode = 1;
  }
}

main()
  .catch((error) => {
    fail('сценарий', error.message);
    console.log(`\nИтого: ${passed} ok, ${failures.length} fail`);
    process.exitCode = 1;
  })
  .finally(() => {
    setTimeout(() => {
      try {
        fs.rmSync(TMP, { recursive: true, force: true });
      } catch {
        /* временная папка могла не создаться */
      }
    }, 500);
  });
