/* Проверка API напоминания о уведомлениях после регистрации.
   Поднимаем настоящий сервер на свободном порту во временной папке данных:
   рабочие данные и живая сборка не затрагиваются.

   Что проверяем:
   - после регистрации напоминание доступно сразу, а у старого админа его нет;
   - «показано» не сдвигает расписание;
   - «Отложить» ведёт к этапам 2 и 3, третье откладывание останавливает окно;
   - записи разных пользователей не смешиваются;
   - неизвестное действие отклоняется.

   Запуск: node test/notify-offer-api.mjs */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.DSHOW_TEST_PORT || 3291);
const BASE = `http://127.0.0.1:${PORT}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshow-notify-api-'));
const OFFERS_FILE = path.join(dataDir, 'notify-offers.json');

const env = {
  ...process.env,
  DSHOW_HOST: '127.0.0.1',
  DSHOW_PORT: String(PORT),
  DSHOW_DATA_DIR: dataDir,
  DSHOW_ADMIN_USER: 'tester',
  DSHOW_ADMIN_PASSWORD: 'Test12345',
  DSHOW_OPEN_SIGNUP: '1',
  DSHOW_SIGNUP_PER_HOUR: '20',
  DSHOW_TG_TOKEN: '',
  DSHOW_TG_CHAT: '',
  DSHOW_DEEPSEEK_KEY: '',
  OPENROUTER_API_KEY: '',
};

const server = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], {
  cwd: ROOT,
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
server.stdout.on('data', (chunk) => { log += chunk.toString(); });
server.stderr.on('data', (chunk) => { log += chunk.toString(); });

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitReady() {
  for (let i = 0; i < 100; i += 1) {
    try {
      const response = await fetch(`${BASE}/api/health`);
      if (response.ok) return true;
    } catch {
      /* сервер ещё поднимается */
    }
    await sleep(100);
  }
  return false;
}

function cookieFrom(response, name) {
  const headers = response.headers.getSetCookie ? response.headers.getSetCookie() : [];
  for (const header of headers) {
    const match = header.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
    if (match) return `${name}=${decodeURIComponent(match[1])}`;
  }
  return '';
}

async function call(pathname, { method = 'GET', body, cookie } = {}) {
  const init = { method, headers: {} };
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
    data = { raw: text };
  }
  return { status: response.status, data, response };
}

function forceDue(stage, dueAt) {
  const list = JSON.parse(fs.readFileSync(OFFERS_FILE, 'utf8'));
  const record = list.find((item) => item.status !== 'enabled' && item.status !== 'stopped' && item.status !== 'denied');
  if (!record) throw new Error('нет записи напоминания');
  record.status = 'scheduled';
  record.stage = stage;
  record.dueAt = dueAt;
  fs.writeFileSync(OFFERS_FILE, JSON.stringify(list, null, 2));
  return record.userId;
}

async function main() {
  const ready = await waitReady();
  if (!ready) {
    console.error('Сервер не поднялся');
    console.error(log);
    process.exitCode = 1;
    return;
  }

  const signup = await call('/api/signup', {
    method: 'POST',
    body: { username: 'notify_user', password: 'Test12345' },
  });
  check('регистрация проходит', signup.status === 200, `HTTP ${signup.status}`);
  const cookie = cookieFrom(signup.response, 'dshow_session');
  const userId = signup.data?.user?.id || '';
  check('сеанс выдан', Boolean(cookie) && Boolean(userId));

  const first = await call('/api/notify-offer', { cookie });
  check('после регистрации окно доступно сразу', first.status === 200 && first.data.show === true && first.data.stage === 1);

  const shown = await call('/api/notify-offer', { method: 'POST', cookie, body: { action: 'shown' } });
  check('отметка «показано» не сдвигает этап', shown.status === 200 && shown.data.show === true && shown.data.stage === 1);

  const second = await call('/api/notify-offer', { method: 'POST', cookie, body: { action: 'postpone' } });
  const monthLater = new Date(second.data.dueAt || 0);
  check(
    'первое «Отложить» — этап 2 через месяц',
    second.status === 200 && second.data.status === 'scheduled' && second.data.stage === 2 && monthLater > new Date(),
    second.data.dueAt || '',
  );

  const forcedStage2 = forceDue(2, '2020-01-01T00:00:00.000Z');
  check('запись принадлежит зарегистрированному пользователю', forcedStage2 === userId);
  const due2 = await call('/api/notify-offer', { cookie });
  check('просроченное напоминание этапа 2 показывается', due2.data.show === true && due2.data.stage === 2);

  const third = await call('/api/notify-offer', { method: 'POST', cookie, body: { action: 'postpone' } });
  const threeMonths = new Date(third.data.dueAt || 0);
  check(
    'второе «Отложить» — этап 3 через три месяца',
    third.status === 200 && third.data.status === 'scheduled' && third.data.stage === 3 && threeMonths > monthLater,
    third.data.dueAt || '',
  );

  forceDue(3, '2020-01-01T00:00:00.000Z');
  const due3 = await call('/api/notify-offer', { cookie });
  check('третье напоминание показывается', due3.data.show === true && due3.data.stage === 3);

  const stop = await call('/api/notify-offer', { method: 'POST', cookie, body: { action: 'postpone' } });
  check('третье «Отложить» выключает напоминания', stop.status === 200 && stop.data.status === 'stopped' && stop.data.show === false);
  const afterStop = await call('/api/notify-offer', { cookie });
  check('после остановки окно не возвращается', afterStop.data.show === false && afterStop.data.status === 'stopped');

  const bad = await call('/api/notify-offer', { method: 'POST', cookie, body: { action: 'что-то' } });
  check('неизвестное действие отклоняется', bad.status === 400, `HTTP ${bad.status}`);

  const secondSignup = await call('/api/signup', {
    method: 'POST',
    body: { username: 'notify_second', password: 'Test12345' },
  });
  const secondCookie = cookieFrom(secondSignup.response, 'dshow_session');
  const secondOffer = await call('/api/notify-offer', { cookie: secondCookie });
  check('у нового пользователя своё окно', secondOffer.data.show === true && secondOffer.data.stage === 1);

  const adminLogin = await call('/api/login', {
    method: 'POST',
    body: { username: 'tester', password: 'Test12345' },
  });
  const adminCookie = cookieFrom(adminLogin.response, 'dshow_session');
  const adminOffer = await call('/api/notify-offer', { cookie: adminCookie });
  check('старому пользователю окно не навязывается', adminLogin.status === 200 && adminOffer.data.eligible === false);

  const unauthorized = await call('/api/notify-offer');
  check('без входа напоминание недоступно', unauthorized.status === 401, `HTTP ${unauthorized.status}`);
}

try {
  await main();
} catch (error) {
  console.error(error);
  console.error(log);
  process.exitCode = 1;
} finally {
  server.kill();
  await sleep(150);
  fs.rmSync(dataDir, { recursive: true, force: true });
}

const failed = results.filter((item) => !item.ok);
console.log(`\n${results.length - failed.length}/${results.length} проверок прошло`);
if (failed.length) process.exitCode = 1;
