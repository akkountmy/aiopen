/**
 * Проверка длинных задач: счётчик шагов больше не обрывает работу и не просит
 * человека «уточнить, что продолжить».
 *
 * Что проверяем:
 *  - задача, которой нужно больше шагов, чем один отрезок, продолжается сама:
 *    сервис подкладывает «продолжай», а не останавливается;
 *  - в ответе нет фразы про предел шагов — даже когда технический потолок
 *    действительно исчерпан (тогда ассистент просто подводит итог);
 *  - короткая задача, у которой хватило шагов, завершается своим ответом без
 *    лишних «продолжай»;
 *  - событий действий в ленте по-прежнему приходит столько, сколько было
 *    вызовов (интерфейс их не показывает, но данные для разбора остаются).
 *
 * Поднимает поддельную модель (OpenAI-совместимый поток) и отдельный экземпляр
 * сервиса на временных данных с уменьшенными пределами шагов.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const MODEL_PORT = 3411;
const APP_PORT = 3412;
const BASE = `http://127.0.0.1:${APP_PORT}`;
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dshow-steps-'));
const ADMIN = { username: 'DSH', password: 'TestPass-12345' };
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36';

/* Отрезок шагов и их число: 2 × 3 = 6 шагов на задачу. */
const SEGMENT = 2;
const SEGMENTS = 3;
const STEP_LIMIT = SEGMENT * SEGMENTS;

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

const FINAL_WORDS = ['Готово. ', 'Файлы ', 'созданы ', 'и ', 'проверены.'];
const WRAP_WORDS = ['Итог: ', 'работа ', 'остановлена ', 'на ', 'техническом ', 'пределе.'];
const CONTINUE_HINT = 'Продолжай выполнение задачи';

/* Как ведёт себя модель в текущей задаче: просит инструмент на каждом шаге,
   пока не наберёт toolBudget вызовов, затем отвечает текстом. */
let toolBudget = Number.POSITIVE_INFINITY;
let sawContinue = false;

function sendText(res, words, usage) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  for (const word of words) {
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: word } }] })}\n\n`);
  }
  res.write(
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage })}\n\n`,
  );
  res.write('data: [DONE]\n\n');
  res.end();
}

function sendToolCall(res, usage, id) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  const args = JSON.stringify({ path: '.' });
  res.write(
    `data: ${JSON.stringify({
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              { index: 0, id, type: 'function', function: { name: 'list_files', arguments: args } },
            ],
          },
        },
      ],
    })}\n\n`,
  );
  res.write(
    `data: ${JSON.stringify({
      choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
      usage,
    })}\n\n`,
  );
  res.write('data: [DONE]\n\n');
  res.end();
}

let toolCalls = 0;

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
      res.end(
        JSON.stringify({
          choices: [{ message: { content: 'Длинная задача' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 20, completion_tokens: 6 },
        }),
      );
      return;
    }
    const messages = Array.isArray(body.messages) ? body.messages : [];
    if (messages.some((m) => m.role === 'user' && String(m.content || '').includes(CONTINUE_HINT))) {
      sawContinue = true;
    }
    trace('модель: шаг', toolCalls, 'инструментов в запросе', Array.isArray(body.tools) ? body.tools.length : 0);
    /* Финальная просьба «подведи итог» приходит без инструментов. */
    const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
    if (hasTools && toolCalls < toolBudget) {
      toolCalls += 1;
      sendToolCall(res, { prompt_tokens: 400, completion_tokens: 40 }, `call_${toolCalls}`);
      return;
    }
    sendText(res, hasTools ? FINAL_WORDS : WRAP_WORDS, { prompt_tokens: 400, completion_tokens: 40 });
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
      DSHOW_MAX_STEPS: String(SEGMENT),
      DSHOW_MAX_SEGMENTS: String(SEGMENTS),
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

async function login() {
  const r = await fetch(`${BASE}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': UA },
    body: JSON.stringify(ADMIN),
  });
  const cookies = (r.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]);
  return cookies.join('; ');
}

async function api(route, { cookie, method = 'GET', body } = {}) {
  const r = await fetch(`${BASE}${route}`, {
    method,
    headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  return { status: r.status, data };
}

async function readRunStream(response) {
  const events = [];
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let ended = false;
  while (true) {
    const chunk = await Promise.race([reader.read(), sleep(15000).then(() => 'timeout')]);
    if (chunk === 'timeout' || chunk.done) break;
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
        if (event.type === 'end') ended = true;
      }
    }
  }
  return { events, ended };
}

async function startRun(cookie, chatId, text) {
  const response = await fetch(`${BASE}/api/chats/${chatId}/messages`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json', 'user-agent': UA },
    body: JSON.stringify({ text, attachmentIds: [] }),
  });
  return { response, runId: response.headers.get('x-dshow-run') };
}

async function newChat(cookie, projectId, name) {
  const chat = (await api(`/api/projects/${projectId}/chats`, { cookie, method: 'POST', body: {} })).data.chat;
  check(Boolean(chat?.id), `диалог «${name}» создан`);
  return chat.id;
}

function answerOf(chat) {
  return (chat.messages || []).filter((m) => m.role === 'assistant').pop();
}

/* -------------------------------- сценарий -------------------------------- */

model.listen(MODEL_PORT, '127.0.0.1');

try {
  app = startApp();
  await waitReady();
  const cookie = await login();

  const project = (await api('/api/projects', { cookie, method: 'POST', body: { name: 'Счётчик шагов' } })).data.project;
  check(Boolean(project?.id), 'проект создан');

  /* 1. Задача длиннее одного отрезка: инструмент просится на каждом шаге.
     Сервис обязан продолжить работу сам, а когда исчерпан технический
     потолок — подвести итог, а не просить «уточнить, что продолжить». */
  toolBudget = Number.POSITIVE_INFINITY;
  toolCalls = 0;
  sawContinue = false;
  const chatLong = await newChat(cookie, project.id, 'длинная');
  const longRun = await startRun(cookie, chatLong, 'Сделай большой отчёт по проекту «Квартира МСК»');
  check(Boolean(longRun.runId), 'сервис вернул идентификатор задачи');
  const longRead = await readRunStream(longRun.response);
  const longText = longRead.events.filter((e) => e.type === 'delta').map((e) => e.text).join('');
  check(longRead.ended, 'длинная задача завершилась сама', longRead.events.map((e) => e.type).join(','));
  check(!/предел шагов/i.test(longText), 'в ответе нет фразы про предел шагов', longText.slice(-80));
  check(!/уточните, что продолжить/i.test(longText), 'человека не просят уточнять продолжение');
  check(sawContinue, 'агент получил «продолжай» и работал дальше');
  /* Событие «продолжение» и предупреждение «осталось N шагов» — оба типа progress,
     но означают разное. Считаем только продолжения: предупреждение приходит на
     последнем шаге и к числу отрезков отношения не имеет (иначе тест падал на 3
     событиях вместо 2 — так было с тех пор, как появилось предупреждение). */
  const progress = longRead.events.filter((e) => e.type === 'progress' && !e.note);
  check(
    progress.length === SEGMENTS - 1,
    'отрезков ровно столько, сколько задано настройками',
    `событий продолжения ${progress.length}`,
  );
  const warnings = longRead.events.filter((e) => e.type === 'progress' && e.note);
  check(warnings.length === 1, 'перед пределом показано одно предупреждение о шагах',
    warnings.map((e) => e.note).join(', ') || 'предупреждений нет');
  /* На каждый вызов сервис присылает два события (старт и итог) — считаем
     вызовы по идентификатору, а не по числу событий. */
  const longTools = new Set(longRead.events.filter((e) => e.type === 'tool').map((e) => e.id));
  check(
    longTools.size >= STEP_LIMIT,
    'шагов выполнено не меньше технического потолка',
    `вызовов ${longTools.size}, потолок ${STEP_LIMIT}`,
  );
  check(/Итог/i.test(longText), 'на техническом потолке подведён итог', longText.slice(0, 80));
  const longChat = (await api(`/api/chats/${chatLong}`, { cookie })).data.chat;
  const longAnswer = answerOf(longChat);
  check(longAnswer?.content === longText, 'сохранённый ответ совпал с потоком', `${longAnswer?.content?.length || 0} символов`);

  /* 2. Задача, которой шагов хватило: она заканчивается своим ответом, без
     лишних «продолжай» и без итогового обрыва. */
  toolBudget = 3;
  toolCalls = 0;
  sawContinue = false;
  const chatShort = await newChat(cookie, project.id, 'короткая');
  const shortRun = await startRun(cookie, chatShort, 'Посмотри файлы проекта');
  const shortRead = await readRunStream(shortRun.response);
  const shortText = shortRead.events.filter((e) => e.type === 'delta').map((e) => e.text).join('');
  check(shortRead.ended, 'короткая задача завершилась');
  check(!/предел шагов/i.test(shortText), 'в коротком ответе нет фразы про предел шагов');
  check(/Готово/i.test(shortText), 'короткая задача ответила своим текстом', shortText.slice(0, 60));
  check(sawContinue, 'продолжение понадобилось и здесь');
  const shortProgress = shortRead.events.filter((e) => e.type === 'progress');
  check(shortProgress.length === 1, 'одно продолжение вместо остановки', `событий ${shortProgress.length}`);
  const shortTools = new Set(shortRead.events.filter((e) => e.type === 'tool').map((e) => e.id));
  check(shortTools.size === 3, 'все запрошенные действия выполнены', `вызовов ${shortTools.size}`);
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
