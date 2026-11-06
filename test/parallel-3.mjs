/* Три задачи одного человека — одновременно.
   Жалоба: «проверь, чтобы можно было параллельно задавать не менее 3-х задач».
   Тест поднимает настоящий сервис с настройками по умолчанию и проверяет:
     — три задачи в трёх разных диалогах живут одновременно (в /api/runs их 3);
     — четвёртая в этот момент не теряется, а получает понятный отказ 429 с
       Retry-After и текстом «идёт 3 ответа»;
     — вторая задача в ТОМ ЖЕ диалоге не отказ, а очередь (202): диалог ведёт
       один ответ, но задача не теряется;
     — как только задачи освободились, сервис снова принимает работу.

   Запуск: node test/parallel-3.mjs */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.DSHOW_TEST_PORT || 3461);
const MOCK_PORT = Number(process.env.DSHOW_MOCK_PORT || 3462);
const BASE = `http://127.0.0.1:${PORT}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshow-parallel-'));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* Заглушка модели: один ответ идёт около 12 секунд — этого хватает, чтобы три
   задачи гарантированно пересеклись во времени. */
const mock = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => {
    raw += chunk.toString();
  });
  req.on('end', () => {
    if (!String(req.url || '').includes('/v1/')) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'только /v1' }));
      return;
    }
    let body = {};
    try {
      body = JSON.parse(raw || '{}');
    } catch {
      body = {};
    }
    if (body.stream === false) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Короткий ответ' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2 } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    let step = 0;
    const timer = setInterval(() => {
      step += 1;
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: `шаг ${step}. ` } }] })}\n\n`);
      if (step < 12) return;
      clearInterval(timer);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 40, completion_tokens: 20 } })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    }, 1000);
    res.on('close', () => clearInterval(timer));
  });
});
await new Promise((resolve) => mock.listen(MOCK_PORT, '127.0.0.1', resolve));

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
  DSHOW_TRUST_PROXY: '0',
  OPENROUTER_API_KEY: '',
};
/* Потолки не задаём: проверяем именно то, с чем работает сервис «из коробки». */
delete env.DSHOW_RUNS_PER_USER;
delete env.DSHOW_MAX_RUNS;

const app = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
app.stdout.on('data', (chunk) => {
  log += chunk.toString();
});
app.stderr.on('data', (chunk) => {
  log += chunk.toString();
});

for (let i = 0; i < 150; i += 1) {
  try {
    if ((await fetch(`${BASE}/api/health`)).ok) break;
  } catch {
    /* ещё поднимается */
  }
  await sleep(100);
}

const results = [];
const check = (name, good, detail = '') => {
  results.push({ name, ok: good, detail });
  console.log(`${good ? 'OK  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

function cookieHeader(response) {
  const headers = response.headers.getSetCookie ? response.headers.getSetCookie() : [];
  return headers.map((header) => header.split(';')[0]).filter(Boolean).join('; ');
}

const UA = 'Mozilla/5.0 (Windows NT 10.0) Chrome/131';
const login = await fetch(`${BASE}/api/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'user-agent': UA },
  body: JSON.stringify({ username: 'tester', password: 'Test12345' }),
});
const cookie = cookieHeader(login);
if (login.status !== 200 || !cookie) throw new Error(`вход не удался: ${login.status}`);

async function call(pathname, { method = 'GET', body } = {}) {
  const init = { method, headers: { 'user-agent': UA, cookie } };
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
    data = { raw: text.slice(0, 200) };
  }
  return { status: response.status, data, headers: response.headers };
}

/** Отправляет задачу и сразу отпускает поток: задача живёт на сервере. */
async function send(chatId, text = 'Посчитай, не торопясь.') {
  const response = await fetch(`${BASE}/api/chats/${chatId}/messages`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json', 'user-agent': UA },
    body: JSON.stringify({ text }),
  });
  const headers = response.headers;
  let data = {};
  if (response.status !== 200) {
    const raw = await response.text();
    try {
      data = JSON.parse(raw);
    } catch {
      data = { raw: raw.slice(0, 200) };
    }
  } else {
    /* Сокет не нужен: работа идёт на сервере независимо от него. */
    response.body?.cancel?.().catch(() => {});
  }
  return { status: response.status, runId: headers.get('x-dshow-run'), data, headers };
}

const project = await call('/api/projects', { method: 'POST', body: { name: 'Параллельность' } });
const projectId = project.data?.project?.id;
if (!projectId) throw new Error(`проект не создался: ${JSON.stringify(project.data).slice(0, 200)}`);

const chats = [];
for (let i = 1; i <= 4; i += 1) {
  const created = await call(`/api/projects/${projectId}/chats`, { method: 'POST', body: {} });
  const chatId = created.data?.chat?.id;
  if (!chatId) throw new Error(`диалог ${i} не создался: ${JSON.stringify(created.data).slice(0, 200)}`);
  chats.push(chatId);
}

let failures = 0;
const finish = () => {
  const failed = results.filter((item) => !item.ok).length;
  console.log(failed ? `\n${failed} из ${results.length} не прошли` : `\nвсе ${results.length} прошли`);
  return failed;
};

try {
  const health = await call('/api/health');
  const perUser = Number(health.data?.load?.limits?.runsPerUser || 0);
  check('сервис из коробки разрешает 3 задачи на человека', perUser === 3, `load.limits.runsPerUser=${perUser}`);

  /* Три задачи уходят одновременно — как три вкладки или три диалога подряд. */
  const started = await Promise.all(chats.slice(0, 3).map((chatId) => send(chatId)));
  const accepted = started.filter((item) => item.status === 200 && item.runId);
  check('все три задачи приняты сразу', accepted.length === 3, started.map((item) => `${item.status}:${item.runId ? 'run' : '—'}`).join(', '));
  check('у задач разные идентификаторы', new Set(accepted.map((item) => item.runId)).size === 3, accepted.map((item) => item.runId).join(', '));

  /* Даём серверу зарегистрировать все три запуска. */
  let runs = [];
  for (let i = 0; i < 60; i += 1) {
    const live = await call('/api/runs');
    runs = live.data?.runs || [];
    if (runs.length >= 3) break;
    await sleep(150);
  }
  check('в живых задачах ровно три', runs.length === 3, `runs=${runs.length}`);
  check('все три в работе, а не в очереди', runs.every((run) => run.status === 'running'), runs.map((run) => run.status).join(', '));

  /* Четвёртая задача в новом диалоге упирается в потолок — и говорит об этом. */
  const fourth = await send(chats[3]);
  check('четвёртая задача получает 429', fourth.status === 429, `код ${fourth.status}`);
  check('есть Retry-After', Boolean(fourth.headers.get('retry-after')), `Retry-After ${fourth.headers.get('retry-after')}`);
  check('в отказе сказано, сколько уже идёт', /идёт 3 ответа/.test(String(fourth.data?.error || '')), String(fourth.data?.error || '').slice(0, 120));

  /* Вторая задача в уже занятом диалоге — не отказ, а очередь. */
  const queued = await send(chats[0], 'И ещё одна задача в тот же диалог.');
  check('вторая задача в том же диалоге встаёт в очередь (202)', queued.status === 202, `код ${queued.status}`);
  check('в очереди есть текст задачи', Boolean(queued.data?.queued?.text), JSON.stringify(queued.data?.queued || {}).slice(0, 120));

  /* Останавливаем три задачи — места освобождаются, четвёртая проходит. */
  for (const run of runs) {
    await call(`/api/runs/${run.id}/stop`, { method: 'POST', body: {} });
  }
  let left = runs.length;
  for (let i = 0; i < 80; i += 1) {
    const live = await call('/api/runs');
    left = (live.data?.runs || []).length;
    if (left === 0) break;
    await sleep(150);
  }
  check('после остановки живых задач не осталось', left === 0, `осталось ${left}`);

  const retry = await send(chats[3]);
  check('освободившееся место снова принимает задачу', retry.status === 200 && Boolean(retry.runId), `код ${retry.status}`);
  if (retry.runId) await call(`/api/runs/${retry.runId}/stop`, { method: 'POST', body: {} });
} finally {
  failures = finish();
  app.kill();
  mock.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
}

if (failures) {
  console.log('\n--- журнал сервиса ---');
  console.log(log.slice(-2000));
}
process.exit(failures ? 1 : 0);
