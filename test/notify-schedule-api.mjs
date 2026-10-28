/* API расписания напоминания: администратор задаёт время, новый пользователь
   получает окно не раньше него. Поднимаем настоящий сервер во временной папке.

   Запуск: node test/notify-schedule-api.mjs */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.DSHOW_TEST_PORT || 3292);
const BASE = `http://127.0.0.1:${PORT}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshow-notify-schedule-api-'));

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
  results.push({ name, ok });
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

/* Время через N минут по Минску — чтобы окно гарантированно было в будущем. */
function minskTimeAfter(minutes) {
  const at = new Date(Date.now() + minutes * 60000);
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Europe/Minsk',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(at);
}

async function signup(username) {
  const response = await call('/api/signup', {
    method: 'POST',
    body: { username, password: 'Test12345' },
  });
  return { ...response, cookie: cookieFrom(response.response, 'dshow_session') };
}

async function main() {
  if (!(await waitReady())) {
    console.error('Сервер не поднялся');
    console.error(log);
    process.exitCode = 1;
    return;
  }

  const guest = await call('/api/admin/notify-schedule');
  check('расписание закрыто от гостя', guest.status === 401, `HTTP ${guest.status}`);

  const adminLogin = await call('/api/login', {
    method: 'POST',
    body: { username: 'tester', password: 'Test12345' },
  });
  const adminCookie = cookieFrom(adminLogin.response, 'dshow_session');
  const initial = await call('/api/admin/notify-schedule', { cookie: adminCookie });
  check(
    'по умолчанию панель видит режим «сразу»',
    initial.status === 200 && initial.data.mode === 'immediate' && initial.data.tz === 'Europe/Minsk',
    `HTTP ${initial.status}`,
  );

  const invalidMode = await call('/api/admin/notify-schedule', {
    method: 'POST',
    cookie: adminCookie,
    body: { mode: 'потом' },
  });
  check('неизвестный режим отклоняется', invalidMode.status === 400, `HTTP ${invalidMode.status}`);

  const invalidTime = await call('/api/admin/notify-schedule', {
    method: 'POST',
    cookie: adminCookie,
    body: { mode: 'time', time: '25:00' },
  });
  check('некорректное время отклоняется', invalidTime.status === 400, `HTTP ${invalidTime.status}`);

  const futureTime = minskTimeAfter(10);
  const saved = await call('/api/admin/notify-schedule', {
    method: 'POST',
    cookie: adminCookie,
    body: { mode: 'time', time: futureTime },
  });
  check(
    'администратор сохраняет время',
    saved.status === 200 && saved.data.mode === 'time' && saved.data.time === futureTime,
    `${saved.data.mode} ${saved.data.time}`,
  );

  const scheduled = await signup('schedule_time_user');
  const scheduledOffer = await call('/api/notify-offer', { cookie: scheduled.cookie });
  const dueAt = Date.parse(scheduledOffer.data.dueAt || '');
  check(
    'новый пользователь ждёт назначенного времени',
    scheduledOffer.status === 200 &&
      scheduledOffer.data.show === false &&
      scheduledOffer.data.status === 'scheduled' &&
      dueAt > Date.now() &&
      dueAt - Date.now() < 11 * 60000,
    scheduledOffer.data.dueAt || '',
  );
  check(
    'панель показывает ближайшее окно',
    saved.data.nextAt === scheduledOffer.data.dueAt && /:/.test(saved.data.preview),
    saved.data.preview,
  );

  const delay = await call('/api/admin/notify-schedule', {
    method: 'POST',
    cookie: adminCookie,
    body: { mode: 'delay', delayMinutes: 30, time: futureTime },
  });
  check('задержка сохраняется', delay.status === 200 && delay.data.delayMinutes === 30);

  const delayed = await signup('schedule_delay_user');
  const delayedOffer = await call('/api/notify-offer', { cookie: delayed.cookie });
  const delayMs = Date.parse(delayedOffer.data.dueAt || '') - Date.now();
  check(
    'задержка применяется к новой регистрации',
    delayedOffer.data.show === false &&
      delayedOffer.data.status === 'scheduled' &&
      delayMs > 29 * 60000 &&
      delayMs <= 30 * 60000,
    String(delayMs),
  );

  const immediate = await call('/api/admin/notify-schedule', {
    method: 'POST',
    cookie: adminCookie,
    body: { mode: 'immediate', time: futureTime },
  });
  const immediateUser = await signup('schedule_now_user');
  const immediateOffer = await call('/api/notify-offer', { cookie: immediateUser.cookie });
  check(
    'возврат к режиму «сразу» снова показывает окно',
    immediate.status === 200 && immediateOffer.data.show === true && immediateOffer.data.status === 'due',
  );
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
