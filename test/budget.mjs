// Проверка порога «тяжёлой задачи»: платформа останавливает работу и пишет
// администратору только тогда, когда ОДНА задача стоит дороже порога (по умолчанию $10),
// и никогда не упирается в «лимит $0.00» из-за старых крошечных значений в проекте.
//
//   node test/budget.mjs        (поднимает заглушку модели и отдельный экземпляр сервиса)
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { taskLimitUsd } from '../src/config.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STUB_PORT = 3213;
const APP_PORT = 3214;
const BASE = `http://127.0.0.1:${APP_PORT}`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dshow-budget-'));
const ADMIN = { username: 'budgetadmin', password: 'budget-pass-123456' };
const USER = { username: 'budgetuser', password: 'budget-user-pass-123' };

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

/* -------------------- заглушка модели -------------------- */

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
      const expensive = raw.toLowerCase().includes('дорогая');
      if (process.env.DSHOW_TEST_DEBUG) console.error(`[stub] expensive=${expensive} stream=${body.stream}`);
      const usage = expensive
        ? { prompt_tokens: 40_000_000, completion_tokens: 20_000_000 }
        : { prompt_tokens: 1000, completion_tokens: 200 };
      /* генерация заголовка — обычный JSON, без потока */
      if (body.stream === false) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: 'Задача' } }], usage }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Готово.' } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  return new Promise((resolve) => server.listen(STUB_PORT, '127.0.0.1', () => resolve(server)));
}

/* -------------------- сервис -------------------- */

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
      DSHOW_TASK_LIMIT_USD: '10',
      DSHOW_TASK_STEP_USD: '10',
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
      /* ещё стартует */
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error('сервис не ответил на /api/health');
}

function client() {
  let cookie = '';
  async function call(pathname, { method = 'GET', body, raw = false } = {}) {
    const headers = { 'content-type': 'application/json' };
    if (cookie) headers.cookie = cookie;
    const response = await fetch(`${BASE}${pathname}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    if (raw) return response;
    const text = await response.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      data = { text };
    }
    return { status: response.status, data };
  }
  return { call, getCookie: () => cookie };
}

/* Разбор SSE-потока ответа ассистента. */
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
        /* пропускаем неполный кадр */
      }
    }
  }
  return { events, text };
}

let stub;
let app;

try {
  /* ---------- 1. чистая логика порога ---------- */
  taskLimitUsd(0.0005) === 10
    ? ok('устаревший крошечный бюджет не опускает порог', '$0.0005 → $10')
    : fail('крошечный бюджет', String(taskLimitUsd(0.0005)));
  taskLimitUsd(undefined) === 10 ? ok('пустой бюджет = порог по умолчанию', '$10') : fail('пустой бюджет', String(taskLimitUsd(undefined)));
  taskLimitUsd(25) === 25 ? ok('одобрение администратора поднимает порог', '$25') : fail('поднятый порог', String(taskLimitUsd(25)));

  /* ---------- 2. дешёвая задача: молча, без запроса ---------- */
  stub = await startStub();
  app = startApp();
  await waitForHealth();

  const admin = client();
  const login = await admin.call('/api/login', { method: 'POST', body: ADMIN });
  login.status === 200 ? ok('администратор вошёл') : fail('вход администратора', JSON.stringify(login));

  /* Баланс пополняем сразу: сама дорогая задача стоит около $20, а счётчик
     списывает с баланса вдвое больше — на стартовых $20 проверка упиралась бы
     в «закончились средства» вместо порога задачи. */
  const createdUser = await admin.call('/api/admin/users', { method: 'POST', body: { ...USER, role: 'user', creditUsd: 200 } });
  createdUser.status === 200 ? ok('создан обычный пользователь') : fail('создание пользователя', JSON.stringify(createdUser));

  const user = client();
  const userLogin = await user.call('/api/login', { method: 'POST', body: USER });
  userLogin.status === 200 ? ok('обычный пользователь вошёл') : fail('вход пользователя', JSON.stringify(userLogin));

  const project = await user.call('/api/projects', { method: 'POST', body: { name: 'Проект с порогом' } });
  project.status === 200 ? ok('проект создан') : fail('проект', JSON.stringify(project));
  const projectId = project.data.project.id;

  const chat = await user.call(`/api/projects/${projectId}/chats`, { method: 'POST', body: { title: 'Задачи' } });
  chat.status === 200 ? ok('диалог создан') : fail('диалог', JSON.stringify(chat));
  const chatId = chat.data.chat.id;

  const cheap = await user.call(`/api/chats/${chatId}/messages`, { method: 'POST', body: { text: 'Обычная небольшая задача' }, raw: true });
  const cheapStream = await readStream(cheap);
  const cheapApproval = cheapStream.events.filter((event) => event.type === 'approval' || event.type === 'budget');
  cheapApproval.length === 0
    ? ok('дешёвая задача прошла без остановки')
    : fail('дешёвая задача', JSON.stringify(cheapApproval));
  cheapStream.text.includes('порог') ? fail('дешёвая задача', 'в ответе лишнее предупреждение о пороге') : ok('в ответе нет предупреждения о деньгах');

  const approvalsAfterCheap = await admin.call('/api/admin/approvals');
  const cheapRequests = (approvalsAfterCheap.data.approvals || []).filter((item) => item.projectId === projectId);
  cheapRequests.length === 0
    ? ok('запрос администратору не создан')
    : fail('лишний запрос', JSON.stringify(cheapRequests.map((item) => ({ spent: item.spentUsd, limit: item.limitUsd }))));

  /* ---------- 3. дорогая задача: пауза и запрос с порогом $10 ---------- */
  const pricey = await user.call(`/api/chats/${chatId}/messages`, { method: 'POST', body: { text: 'Дорогая задача на весь бюджет' }, raw: true });
  const priceyStream = await readStream(pricey);
  const approvalEvent = priceyStream.events.find((event) => event.type === 'approval');
  if (!approvalEvent) {
    fail('дорогая задача', 'нет события approval');
  } else {
    ok('дорогая задача остановлена', `$${approvalEvent.approval.spentUsd}`);
    Number(approvalEvent.approval.limitUsd) === 10
      ? ok('в запросе порог $10 за задачу', `$${approvalEvent.approval.limitUsd}`)
      : fail('порог в запросе', String(approvalEvent.approval.limitUsd));
    Number(approvalEvent.approval.spentUsd) > 10
      ? ok('стоимость задачи показана честно', `$${approvalEvent.approval.spentUsd}`)
      : fail('стоимость задачи', String(approvalEvent.approval.spentUsd));
  }
  priceyStream.text.includes('выше порога')
    ? ok('пользователю объяснили остановку')
    : fail('пояснение в ответе', priceyStream.text.slice(-120));

  const approvals = await admin.call('/api/admin/approvals');
  const pending = (approvals.data.approvals || []).filter((item) => item.projectId === projectId && item.status === 'pending');
  pending.length === 1 ? ok('запрос виден администратору') : fail('список запросов', JSON.stringify((approvals.data.approvals || []).length));
  if (pending.length === 1) {
    Number(pending[0].limitUsd) === 10
      ? ok('в карточке запроса порог $10')
      : fail('порог в карточке', String(pending[0].limitUsd));
    const decided = await admin.call(`/api/admin/approvals/${pending[0].id}`, { method: 'POST', body: { action: 'approve' } });
    decided.status === 200 && Number(decided.data.budgetUsd) > 10
      ? ok('одобрение поднимает порог', `$${decided.data.budgetUsd}`)
      : fail('одобрение', JSON.stringify(decided));
  }

  /* ---------- 4. следующая задача после одобрения не упирается в $0 ---------- */
  const after = await user.call(`/api/chats/${chatId}/messages`, { method: 'POST', body: { text: 'Ещё одна обычная задача' }, raw: true });
  if (after.status === 200) {
    const againStream = await readStream(after);
    againStream.events.some((event) => event.type === 'approval')
      ? fail('задача после одобрения', 'снова остановлена')
      : ok('после одобрения дешёвая задача идёт дальше');
  } else {
    fail('задача после одобрения', `HTTP ${after.status}`);
  }
} catch (error) {
  fail('выполнение', error?.stack || String(error));
} finally {
  app?.kill();
  stub?.close();
  fs.rmSync(TMP, { recursive: true, force: true });
}

console.log(`\nИтого: ${passed} ok, ${failures.length} fail`);
process.exit(failures.length ? 1 : 0);
