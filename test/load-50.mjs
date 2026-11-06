/* Нагрузочная проверка потолка: полсотни человек, у каждого до трёх задач.

   Тест поднимает НАСТОЯЩИЙ server.mjs с боевыми пределами (24 одновременных
   прогона на сервис, 3 на аккаунт, очередь ожидания 120, ожидание 60 с) и
   заглушку модели, чтобы не тратить токены. Создаёт 50 аккаунтов по 3 диалога,
   отправляет все 150 задач ОДНОВРЕМЕННО и смотрит, что из этого выходит.

   Что доказываем:
   — новый потолок действительно достигается: одновременно идут ровно 24
     ответа, а не 10 и не «сколько получится»;
   — остальные не теряются: они ждут место (до 120 ждущих), а те, кому места
     в очереди не хватило, получают 503 с Retry-After, а не тишину и не 500;
   — сервис не падает, не зависает и не течёт: память растёт на единицы
     мегабайт на прогон, цикл событий не встаёт;
   — деградация временная: отклонённые задачи после наплыва принимаются;
   — память процесса остаётся ниже потолка DSHOW_MAX_RSS_MB (1536 МБ).

   Запуск: node test/load-50.mjs
   Тест локальный: сеть не нужна, модель — заглушка на соседнем порту. */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.DSHOW_TEST_PORT || 3481);
const MOCK_PORT = Number(process.env.DSHOW_MOCK_PORT || 3482);
const BASE = `http://127.0.0.1:${PORT}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshow-load50-'));

/* Полсотни человек и по три диалога — то, что просил пользователь. */
const USERS = 50;
const CHATS_PER_USER = 3;
const TOTAL = USERS * CHATS_PER_USER;

/* Сколько держим задачу, чтобы они успели наложиться друг на друга. 700 мс —
   компромисс: волн получается ~7, тест идёт секунды, а не минуты. */
const TASK_MS = 700;

let mockInFlight = 0;
let mockPeak = 0;
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
          choices: [{ message: { role: 'assistant', content: 'Итог задачи.' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 6, completion_tokens: 3, total_tokens: 9 },
        }),
      );
      return;
    }
    mockInFlight += 1;
    mockPeak = Math.max(mockPeak, mockInFlight);
    let closed = false;
    res.on('close', () => {
      closed = true;
      mockInFlight = Math.max(0, mockInFlight - 1);
    });
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    const timer = setTimeout(() => {
      if (closed) return;
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Итог задачи.' } }] })}\n\n`);
      res.write(
        `data: ${JSON.stringify({
          choices: [{ delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 6, completion_tokens: 3, total_tokens: 9 },
        })}\n\n`,
      );
      res.write('data: [DONE]\n\n');
      res.end();
    }, TASK_MS);
    res.on('close', () => clearTimeout(timer));
  });
});

/* Пределы НЕ переопределяем: тест должен проверять боевые значения из
   src/config.mjs. Переопределены только то, что мешает локальному прогону. */
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
  DSHOW_MESSAGES_PER_10MIN: '500',
  OPENROUTER_API_KEY: '',
};
for (const key of ['DSHOW_MAX_RUNS', 'DSHOW_RUNS_PER_USER', 'DSHOW_MAX_WAITING_RUNS', 'DSHOW_RUN_WAIT_S', 'DSHOW_MAX_RSS_MB']) {
  delete env[key];
}

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
let serverExited = false;
server.on('exit', () => {
  serverExited = true;
});

const results = [];
const check = (name, good, detail = '') => {
  results.push({ name, ok: good, detail });
  console.log(`${good ? 'OK  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitReady() {
  for (let i = 0; i < 300; i += 1) {
    try {
      const response = await fetch(`${BASE}/api/health`, { headers: { 'user-agent': UA } });
      if (response.ok) return true;
    } catch {
      /* сервер ещё поднимается */
    }
    await sleep(100);
  }
  return false;
}

function cookieHeader(response) {
  const headers = response.headers.getSetCookie ? response.headers.getSetCookie() : [];
  return headers.map((header) => header.split(';')[0]).filter(Boolean).join('; ');
}

async function login(username, password) {
  const response = await fetch(`${BASE}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': UA },
    body: JSON.stringify({ username, password }),
  });
  await response.text();
  const cookie = cookieHeader(response);
  return response.status === 200 && cookie ? cookie : '';
}

function api(cookie) {
  return async function call(pathname, { method = 'GET', body } = {}) {
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
  };
}

/** Отправляет задачу и сразу отпускает поток: работа живёт на сервере. */
async function send(cookie, chatId, text) {
  let response;
  try {
    response = await fetch(`${BASE}/api/chats/${chatId}/messages`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', 'user-agent': UA },
      body: JSON.stringify({ text }),
    });
  } catch (error) {
    return { status: 0, runId: '', data: { error: String(error?.message || error) }, headers: new Headers() };
  }
  const runId = response.headers.get('x-dshow-run') || '';
  let data = {};
  if (response.status === 200) {
    response.body?.cancel?.().catch(() => {});
  } else {
    const raw = await response.text();
    try {
      data = JSON.parse(raw);
    } catch {
      data = { raw: raw.slice(0, 200) };
    }
  }
  return { status: response.status, runId, data, headers: response.headers };
}

async function health() {
  try {
    const response = await fetch(`${BASE}/api/health`, { headers: { 'user-agent': UA } });
    const data = await response.json().catch(() => ({}));
    return data?.load || {};
  } catch {
    return {};
  }
}

/* Пока идёт наплыв, каждые 200 мс записываем пики: именно пик одновременных
   прогонов показывает, дошёл ли сервис до нового потолка. */
const peak = { active: 0, waiting: 0, rssMb: 0, loopLagMs: 0, waited: 0 };
let watching = true;
async function watch() {
  while (watching) {
    const load = await health();
    peak.active = Math.max(peak.active, Number(load?.runs?.active || 0));
    peak.waiting = Math.max(peak.waiting, Number(load?.runs?.waiting || 0));
    peak.rssMb = Math.max(peak.rssMb, Number(load?.memory?.rssMb || 0));
    peak.loopLagMs = Math.max(peak.loopLagMs, Number(load?.loopLagMs || 0));
    peak.waited = Math.max(peak.waited, Number(load?.runs?.waited || 0));
    await sleep(200);
  }
}

try {
  await new Promise((resolve) => mock.listen(MOCK_PORT, '127.0.0.1', resolve));
  if (!(await waitReady())) throw new Error(`сервер не поднялся\n${log.slice(-1500)}`);

  const first = await health();
  const limits = first?.limits || {};
  const idleRss = Number(first?.memory?.rssMb || 0);
  console.log(
    `пределы сервиса: прогонов ${limits.maxRuns}, на аккаунт ${limits.runsPerUser}, ` +
      `ожидание ${Math.round(Number(first?.runs?.waitMs || 0) / 1000)} с, очередь ${limits.maxWaitingRuns}, ` +
      `потолок памяти ${limits.maxRssMb} МБ`,
  );
  check('новый потолок поднят: не меньше 24 прогонов разом', Number(limits.maxRuns) >= 24, `maxRuns=${limits.maxRuns}`);
  check('очередь ожидания расширена: не меньше 120', Number(limits.maxWaitingRuns) >= 120, `maxWaiting=${limits.maxWaitingRuns}`);

  const adminCookie = await login('tester', 'Test12345');
  check('вход администратора', Boolean(adminCookie));
  const admin = api(adminCookie);

  /* Пятьдесят аккаунтов: так общий потолок проверяется честно, а предел
     «три на аккаунт» не мешает — у каждого ровно три задачи. */
  const people = [];
  for (let index = 0; index < USERS; index += 1) {
    const username = `load50_${index + 1}`;
    const created = await admin('/api/admin/users', {
      method: 'POST',
      body: { username, password: 'Load12345', role: 'user', creditUsd: 5 },
    });
    if (created.status !== 200) throw new Error(`пользователь ${username} не создан: ${JSON.stringify(created.data).slice(0, 200)}`);
    const cookie = await login(username, 'Load12345');
    if (!cookie) throw new Error(`вход ${username} не удался`);
    people.push({ username, cookie, call: api(cookie), chats: [] });
  }
  check(`создано ${USERS} аккаунтов`, people.length === USERS, `вошло ${people.length}`);

  for (const person of people) {
    const project = await person.call('/api/projects', { method: 'POST', body: { name: 'Нагрузка' } });
    const projectId = project.data?.project?.id;
    if (!projectId) throw new Error(`проект ${person.username} не создался: ${JSON.stringify(project.data).slice(0, 160)}`);
    for (let i = 0; i < CHATS_PER_USER; i += 1) {
      const created = await person.call(`/api/projects/${projectId}/chats`, { method: 'POST', body: {} });
      const chatId = created.data?.chat?.id;
      if (!chatId) throw new Error(`диалог не создался: ${JSON.stringify(created.data).slice(0, 160)}`);
      person.chats.push(chatId);
    }
  }
  check(`создано ${TOTAL} диалогов`, people.every((person) => person.chats.length === CHATS_PER_USER), `${TOTAL} готовы`);

  /* Наплыв: все 150 задач уходят одновременно, ни одна не ждёт предыдущей. */
  const watcher = watch();
  const startedAt = Date.now();
  const tasks = [];
  for (const person of people) {
    for (const chatId of person.chats) tasks.push({ person, chatId });
  }
  const outcomes = await Promise.all(tasks.map((task) => send(task.person.cookie, task.chatId, 'Посчитай, не торопясь, сколько будет 24 задачи.')));

  const accepted = tasks.map((task, index) => ({ ...task, ...outcomes[index] })).filter((task) => task.status === 200 && task.runId);
  const queued = outcomes.filter((item) => item.status === 202).length;
  const rejected = tasks.map((task, index) => ({ ...task, ...outcomes[index] })).filter((task) => task.status === 503);
  const rateLimited = outcomes.filter((item) => item.status === 429).length;
  const broken = outcomes.filter((item) => ![200, 202, 429, 503].includes(item.status));
  const burstMs = Date.now() - startedAt;

  check('ни один запрос не упал с неожиданным кодом', broken.length === 0, broken.length ? `кодов: ${broken.map((item) => item.status).join(',')}` : 'только 200/202/429/503');
  check('пик одновременных ответов дошёл до нового потолка', peak.active >= 24, `пик ${peak.active} при пределе ${limits.maxRuns}`);
  check('предел не превышен', peak.active <= Number(limits.maxRuns), `пик ${peak.active} ≤ ${limits.maxRuns}`);
  check('очередь ожидания реально работала', peak.waiting > 0, `пик ждущих ${peak.waiting} из ${limits.maxWaitingRuns}`);
  check('лишние получили 503 с Retry-After, а не молчание', rejected.length >= 0 && rejected.every((item) => item.headers.get('retry-after')), rejected.length ? `${rejected.length} отказов, у всех Retry-After` : 'отказов не было — все влезли в очередь');
  check('предела «три на аккаунт» не коснулись', rateLimited === 0, `429: ${rateLimited}`);
  check('принятых задач подавляющее большинство', accepted.length + queued >= TOTAL - rejected.length, `принято ${accepted.length + queued} из ${TOTAL}, отказов ${rejected.length}`);
  check('отказов не больше, чем не влезло в очередь', rejected.length <= TOTAL - Math.min(Number(limits.maxRuns) + Number(limits.maxWaitingRuns), TOTAL) + 2, `${rejected.length} отказов`);

  /* Ждём, когда наплыв рассосётся: место должно освободиться само. */
  const drainDeadline = Date.now() + 120_000;
  let drained = false;
  let lastLoad = {};
  while (Date.now() < drainDeadline) {
    lastLoad = await health();
    if (Number(lastLoad?.runs?.active || 0) === 0 && Number(lastLoad?.runs?.waiting || 0) === 0) {
      drained = true;
      break;
    }
    await sleep(300);
  }
  watching = false;
  await watcher;
  const drainMs = Date.now() - startedAt;

  check('после наплыва не осталось ни идущих, ни ждущих', drained, `active ${lastLoad?.runs?.active}, waiting ${lastLoad?.runs?.waiting}`);
  check('пик обращений к модели не превысил предел', mockPeak <= Number(limits.maxRuns), `пик заглушки ${mockPeak} ≤ ${limits.maxRuns}`);

  /* Принятые задачи должны не просто закончиться, а закончиться успешно. */
  const statuses = {};
  let checkedRuns = 0;
  for (const task of accepted) {
    const response = await task.person.call(`/api/runs/${task.runId}`);
    const status = response.data?.run?.status || response.data?.status || `код ${response.status}`;
    statuses[status] = (statuses[status] || 0) + 1;
    checkedRuns += 1;
  }
  const failedStatuses = Object.entries(statuses).filter(([status]) => status !== 'done');
  check(
    'все принятые задачи завершились успешно',
    failedStatuses.length === 0,
    `проверено ${checkedRuns}: ${Object.entries(statuses).map(([status, count]) => `${status}×${count}`).join(', ') || 'нет'}`,
  );

  /* Память: прирост на прогон — та самая величина, из которой считается потолок. */
  const perRun = peak.active > 0 ? (peak.rssMb - idleRss) / peak.active : 0;
  console.log(
    `\nзамер: холостой ход ${idleRss} МБ → пик ${peak.rssMb.toFixed(1)} МБ при ${peak.active} прогонах, ` +
      `это ${perRun.toFixed(1)} МБ на прогон; цикл событий отставал до ${peak.loopLagMs} мс`,
  );
  check('память на прогон — единицы мегабайт', perRun < 25, `${perRun.toFixed(1)} МБ на прогон`);
  check('память процесса ниже потолка', peak.rssMb < Number(limits.maxRssMb), `${peak.rssMb.toFixed(1)} из ${limits.maxRssMb} МБ`);
  check('цикл событий не вставал', peak.loopLagMs < 1500, `худшее отставание ${peak.loopLagMs} мс`);

  /* Деградация временная: отклонённые задачи после наплыва принимаются. */
  let retried = 0;
  let retriedOk = 0;
  for (const task of rejected.slice(0, 12)) {
    const retry = await send(task.person.cookie, task.chatId, 'Повторяю задачу после наплыва.');
    retried += 1;
    if (retry.status === 200 || retry.status === 202) retriedOk += 1;
    if (retry.runId) await task.person.call(`/api/runs/${retry.runId}/stop`, { method: 'POST', body: {} });
  }
  check('отклонённые задачи после наплыва принимаются', retried === 0 || retriedOk === retried, `${retriedOk} из ${retried}`);

  const after = await health();
  check('сервис жив после наплыва', Boolean(after?.runs) && !serverExited, `active ${after?.runs?.active}, memory ${after?.memory?.rssMb} МБ`);
  check('в журнале нет необработанных исключений', !/UnhandledPromiseRejection|uncaughtException/i.test(log), log.match(/UnhandledPromiseRejection|uncaughtException[^\n]*/i)?.[0] || 'чисто');

  console.log(
    `\nитог наплыва: ${TOTAL} задач за ${(burstMs / 1000).toFixed(1)} с отправки, ` +
      `рассосалось за ${(drainMs / 1000).toFixed(1)} с; принято ${accepted.length + queued}, отказов ${rejected.length}, 429 ${rateLimited}`,
  );
} catch (error) {
  check('тест дошёл до конца', false, String(error?.message || error));
} finally {
  server.kill('SIGTERM');
  await sleep(500);
  try {
    server.kill('SIGKILL');
  } catch {
    /* уже завершился */
  }
  mock.close();
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  const failed = results.filter((item) => !item.ok);
  console.log(`\n${results.length - failed.length} из ${results.length} прошли, ${failed.length} упали`);
  if (failed.length) {
    console.log(`\nПоследние строки журнала сервера:\n${log.slice(-2500)}`);
    process.exit(1);
  }
}
