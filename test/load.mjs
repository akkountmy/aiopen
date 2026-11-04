/* Нагрузочная проверка: полсотни диалогов одновременно.
   Тест поднимает настоящий сервер и заглушку модели, создаёт несколько
   пользователей и разом отправляет 50 задач в разные диалоги.

   Что проверяем:
   — сервис не падает и не зависает под наплывом;
   — лишние задачи не теряются: они либо встают в короткую очередь, либо
     получают 503 с заголовком Retry-After (а не тишину и не 500);
   — /api/health показывает загрузку (счётчик прогонов, память, отставание
     цикла событий) и не утекает в бесконечность;
   — после наплыва счётчик одновременных задач возвращается к нулю, а новые
     сообщения снова принимаются — то есть деградация временная, а не поломка.

   Запуск: node test/load.mjs
   Тест не входит в быстрый набор (помечен как долгий), но участвует в check.mjs
   без --live: он полностью локальный, без сети и без настоящей модели. */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.DSHOW_TEST_PORT || 3311);
const MOCK_PORT = Number(process.env.DSHOW_MOCK_PORT || 3312);
const BASE = `http://127.0.0.1:${PORT}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshow-load-'));

const USERS = 5;
const CHATS_PER_USER = 10;
const TOTAL = USERS * CHATS_PER_USER;

/* Заглушка модели: отвечает через 700 мс, чтобы задачи успевали наложиться
   друг на друга, но тест не тянулся минутами. */
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
    }, 700);
    res.on('close', () => clearTimeout(timer));
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
  /* Пределы занижены специально: четыре места на весь сервис — это тот же
     механизм, что десять мест на боевом контейнере, только ошибку видно быстро.
     Ждать разрешено восемь секунд: большинство задач успевает пройти, а хвост
     честно получает отказ с Retry-After. */
  DSHOW_MAX_RUNS: '4',
  DSHOW_RUNS_PER_USER: '3',
  DSHOW_RUN_WAIT_S: '8',
  DSHOW_MAX_WAITING_RUNS: '40',
  DSHOW_MESSAGES_PER_10MIN: '500',
  DSHOW_SAVE_DEBOUNCE_MS: '0',
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
let serverExited = false;
server.on('exit', () => {
  serverExited = true;
});

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131';

async function waitReady() {
  for (let i = 0; i < 200; i += 1) {
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

async function login(username, password) {
  const response = await fetch(`${BASE}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': UA },
    body: JSON.stringify({ username, password }),
  });
  await response.text();
  return cookieValue(response, 'dshow_session');
}

async function api(cookie, pathname, { method = 'GET', body } = {}) {
  const init = { method, headers: { 'user-agent': UA } };
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
    data = { raw: text.slice(0, 200) };
  }
  return { status: response.status, data, headers: response.headers };
}

async function health() {
  const response = await fetch(`${BASE}/api/health`, { headers: { 'user-agent': UA } });
  const data = await response.json().catch(() => ({}));
  return { status: response.status, data };
}

/* Очередь отправки: задачи стартуют одновременно, а не по одной. */
async function burst(items, limit = 50) {
  const out = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      out[index] = await items[index]();
    }
  });
  await Promise.all(workers);
  return out;
}

try {
  await new Promise((resolve) => mock.listen(MOCK_PORT, '127.0.0.1', resolve));
  if (!(await waitReady())) throw new Error(`сервер не поднялся\n${log.slice(-1500)}`);

  const admin = await login('tester', 'Test12345');
  check('вход администратора', Boolean(admin));
  const adminCookie = `dshow_session=${admin}`;

  /* Пять пользователей — чтобы предел на аккаунт не был узким местом и
     проверялся именно общий счётчик сервиса. */
  const people = [];
  for (let index = 0; index < USERS; index += 1) {
    const username = `load${index + 1}`;
    const created = await api(adminCookie, '/api/admin/users', {
      method: 'POST',
      body: { username, password: 'Load12345', role: 'user', creditUsd: 5 },
    });
    if (created.status !== 200) throw new Error(`пользователь ${username} не создан: ${JSON.stringify(created.data)}`);
    const session = await login(username, 'Load12345');
    const cookie = `dshow_session=${session}`;
    const project = await api(cookie, '/api/projects', { method: 'POST', body: { name: `Нагрузка ${index + 1}` } });
    const projectId = project.data.project?.id;
    if (!projectId) throw new Error(`проект у ${username} не создан: ${JSON.stringify(project.data)}`);
    const chats = [];
    for (let n = 0; n < CHATS_PER_USER; n += 1) {
      const chat = await api(cookie, `/api/projects/${projectId}/chats`, { method: 'POST', body: {} });
      const chatId = chat.data.chat?.id;
      if (!chatId) throw new Error(`диалог у ${username} не создан: ${JSON.stringify(chat.data)}`);
      chats.push(chatId);
    }
    people.push({ username, cookie, chats });
  }
  check(`подготовлено ${TOTAL} диалогов у ${USERS} пользователей`, people.length === USERS && people.every((p) => p.chats.length === CHATS_PER_USER));

  const before = await health();
  check('health отдаёт загрузку', Boolean(before.data.load?.runs) && typeof before.data.load?.memory?.rssMb === 'number', JSON.stringify(before.data.load || {}).slice(0, 200));
  check('предел одновременных задач из окружения', before.data.load?.limits?.maxRuns === 4, String(before.data.load?.limits?.maxRuns));

  /* ---- главный наплыв: 50 задач одновременно ---- */
  const started = Date.now();
  const targets = people.flatMap((person) => person.chats.map((chatId) => ({ person, chatId })));
  const responses = await burst(
    targets.map(({ person, chatId }, index) => async () => {
      const response = await fetch(`${BASE}/api/chats/${chatId}/messages`, {
        method: 'POST',
        headers: { cookie: person.cookie, 'content-type': 'application/json', 'user-agent': UA },
        body: JSON.stringify({ text: `Задача номер ${index + 1}` }),
      });
      const retryAfter = Number(response.headers.get('retry-after') || 0);
      /* Тело дочитываем: поток задачи должен закрыться, иначе прогон останется
         висеть живым и тест покажет ложное «занято». */
      await response.text().catch(() => '');
      return { status: response.status, retryAfter };
    }),
  );
  const elapsed = Date.now() - started;

  const okCount = responses.filter((item) => item.status === 200).length;
  const busyCount = responses.filter((item) => item.status === 503).length;
  const limitedCount = responses.filter((item) => item.status === 429).length;
  const otherCount = responses.filter((item) => ![200, 429, 503].includes(item.status)).length;
  check('ни один запрос не потерялся', responses.length === TOTAL, `${responses.length} из ${TOTAL}`);
  check(
    'каждый ответ понятен: выполнен, в очереди, «занято» или «много сразу»',
    otherCount === 0 && responses.every((item) => item.status === 200 || item.retryAfter > 0),
    `200: ${okCount}, 503: ${busyCount}, 429: ${limitedCount}, прочие: ${otherCount}`,
  );
  check('под наплывом большая часть задач всё же выполнилась', okCount >= Math.ceil(TOTAL / 2), `${okCount} из ${TOTAL} за ${Math.round(elapsed / 1000)} с`);
  check('сверх пределов приходит честный отказ с Retry-After', busyCount + limitedCount > 0, `503: ${busyCount}, 429: ${limitedCount}`);

  const during = await health();
  check('сервис отвечает во время наплыва', during.status === 200, `HTTP ${during.status}`);
  check('счётчик отказов виден в health', (during.data.load?.runs?.rejected || 0) >= busyCount, JSON.stringify(during.data.load?.runs || {}).slice(0, 200));
  check('отставание цикла событий в разумных пределах', (during.data.load?.loopLagMs || 0) < 2000, `${during.data.load?.loopLagMs} мс`);
  check('память процесса не разъехалась', (during.data.load?.memory?.rssMb || 0) < 1500, `${during.data.load?.memory?.rssMb} МБ`);
  check('заглушка модели не получила больше мест, чем разрешено', mockPeak <= 4, `пик ${mockPeak}`);

  /* ---- восстановление после наплыва ---- */
  let drained = null;
  for (let i = 0; i < 120; i += 1) {
    const now = await health();
    if ((now.data.load?.activeRuns || 0) === 0) {
      drained = now;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  check('после наплыва одновременных задач не осталось', Boolean(drained), drained ? 'все завершились' : 'задачи не завершились за минуту');

  const repeat = await fetch(`${BASE}/api/chats/${people[0].chats[0]}/messages`, {
    method: 'POST',
    headers: { cookie: people[0].cookie, 'content-type': 'application/json', 'user-agent': UA },
    body: JSON.stringify({ text: 'Проверка после наплыва' }),
  });
  await repeat.text().catch(() => '');
  check('после наплыва сервис снова принимает задачи', repeat.status === 200 || repeat.status === 202, `HTTP ${repeat.status}`);

  const after = await health();
  check('health после наплыва отвечает', after.status === 200);
  check('память не выросла в разы', (after.data.load?.memory?.rssMb || 0) < (before.data.load?.memory?.rssMb || 0) * 4 + 400, `было ${before.data.load?.memory?.rssMb} МБ, стало ${after.data.load?.memory?.rssMb} МБ`);

  check('сервер не упал', !serverExited && server.exitCode === null);
  check('в журнале нет необработанных исключений', !/UnhandledPromiseRejection|uncaughtException/i.test(log), log.match(/UnhandledPromiseRejection|uncaughtException[^\n]*/i)?.[0] || 'чисто');
} catch (error) {
  check('тест дошёл до конца', false, String(error?.message || error));
} finally {
  server.kill('SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 500));
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
