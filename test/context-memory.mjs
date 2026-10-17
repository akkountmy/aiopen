/**
 * Регрессионный тест сохранения контекста.
 *
 * Проверяет главное свойство: когда история диалога переполняет бюджет, старые
 * реплики вырезаются, а их конспект («память») записывается в файл чата и
 * подставляется в следующий запрос к модели.
 *
 * Свой сервер не нужен: тест поднимает заглушку модели и сам сервис на
 * временной папке данных, поэтому не тратит деньги и ничего не портит:
 *   node test/context-memory.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STUB_PORT = 3211;
const APP_PORT = 3212;
const BASE = `http://127.0.0.1:${APP_PORT}`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dshow-ctx-'));
const LONG_TEXT = `${'Первый большой абзац контекста. '.repeat(110)}\n\nКлючевое число: 42.`;
const SUMMARY_MARK = 'СВОДКА:';

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
      const first = body.messages?.[0] || {};
      const firstText = typeof first.content === 'string' ? first.content : '';

      /* Заголовок диалога. */
      if (firstText.includes('название')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: 'Тестовый диалог' } }] }));
        return;
      }

      /* Конспект вырезанной истории — обычный нестримовый ответ. */
      if (firstText.includes('Сожми фрагмент')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            choices: [{ message: { content: `${SUMMARY_MARK} важный факт, решение, файл report.docx, число 42` } }],
            usage: { prompt_tokens: 20, completion_tokens: 10 },
          }),
        );
        return;
      }

      /* Ответ агента — поток SSE, как у настоящего API. */
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Ок.' } }] })}\n\n`);
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
      DSHOW_ADMIN_USER: 'ctxadmin',
      DSHOW_ADMIN_PASSWORD: 'ctx-pass-123456',
      DSHOW_DEEPSEEK_KEY: 'test-key',
      DSHOW_MODEL_BASE: `http://127.0.0.1:${STUB_PORT}`,
      DSHOW_MODEL: 'stub-model',
      /* Крошечный бюджет заставляет вырезать историю уже на третьем ходе. */
      DSHOW_HISTORY_TOKENS: '1',
      DSHOW_KEEP_RECENT: '1',
      DSHOW_TG_TOKEN: '',
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
      if (response.ok) return;
    } catch {
      /* ещё не поднялся */
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error('сервис не ответил на /api/health');
}

let cookie = '';

async function call(pathname, { method = 'GET', body } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (cookie) headers.cookie = cookie;
  const response = await fetch(`${BASE}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  for (const entry of response.headers.getSetCookie?.() || []) {
    cookie = entry.split(';')[0];
  }
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text.slice(0, 300) };
  }
  if (!response.ok) throw new Error(`${method} ${pathname} → ${response.status}: ${text.slice(0, 300)}`);
  return data;
}

async function sendMessage(chatId, text) {
  const response = await fetch(`${BASE}/api/chats/${chatId}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ text }),
  });
  if (!response.ok) throw new Error(`сообщение → ${response.status}: ${(await response.text()).slice(0, 300)}`);
  const raw = await response.text();
  const events = raw
    .split('\n\n')
    .map((block) => block.split('\n').find((line) => line.startsWith('data:')))
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line.slice(5).trim());
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  const error = events.find((event) => event.type === 'error');
  if (error) throw new Error(`ошибка ответа: ${error.message}`);
  if (!events.some((event) => event.type === 'done')) throw new Error('поток завершился без события done');
}

function readChatFile(chatId) {
  return JSON.parse(fs.readFileSync(path.join(TMP, 'chats', `${chatId}.json`), 'utf8'));
}

/* ---------- сценарий ---------- */

async function main() {
  const stub = await startStub();
  const app = startApp();
  let chatId = null;
  try {
    await waitForHealth();

    await call('/api/login', { method: 'POST', body: { username: 'ctxadmin', password: 'ctx-pass-123456' } });
    const project = await call('/api/projects', { method: 'POST', body: { name: 'Контекст' } });
    const chat = await call(`/api/projects/${project.project.id}/chats`, { method: 'POST', body: {} });
    chatId = chat.chat.id;

    await sendMessage(chatId, LONG_TEXT);
    await sendMessage(chatId, 'Короткий второй вопрос');

    const afterTwo = readChatFile(chatId);
    if (afterTwo.memory) throw new Error(`память появилась слишком рано: ${afterTwo.memory.slice(0, 60)}`);
    if (afterTwo.history.length !== 4) throw new Error(`история после двух ходов: ${afterTwo.history.length}`);
    ok('история копится, память пока пуста');

    await sendMessage(chatId, 'Короткий третий вопрос');

    const saved = readChatFile(chatId);
    const longGone = !saved.history.some((message) => String(message.content || '').includes('Первый большой абзац'));
    const memoryTokens = String(saved.memory || '').split('\n').filter(Boolean).length;

    if (!saved.memory || !saved.memory.includes(SUMMARY_MARK)) {
      throw new Error(`память не сохранилась в файл чата: ${JSON.stringify(saved.memory).slice(0, 120)}`);
    }
    ok('конспект записан в файл чата', `${saved.memory.length} символов`);

    /* Вырезается ровно предыдущая пара реплик; последняя остаётся границей. */
    if (!longGone) throw new Error('старая реплика осталась в истории');
    if (saved.history.length !== 4) throw new Error(`история после вырезания: ${saved.history.length} (ожидалось 4)`);
    if (String(saved.history[0]?.content || '') !== 'Короткий второй вопрос') {
      throw new Error(`начало истории: ${JSON.stringify(String(saved.history[0]?.content || '').slice(0, 60))}`);
    }
    ok('старая история вырезана', `history=${saved.history.length}, memory-строк=${memoryTokens}`);

    if (saved.messages.length !== 6) {
      throw new Error(`транскрипт интерфейса не должен теряться: ${saved.messages.length}`);
    }
    ok('транскрипт интерфейса цел', `${saved.messages.length} сообщений`);
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
