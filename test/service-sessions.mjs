/**
 * Проверка семантики сеансов: телефон и компьютер живут параллельно,
 * второй компьютер выбивает первый, а служебный вход не выбивает никого.
 * Поднимает отдельный экземпляр сервиса на 3199 с временными данными.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = 3199;
const BASE = `http://127.0.0.1:${PORT}`;
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dshow-sessions-'));
const ADMIN = { username: 'DSHOPENWEB', password: 'TestPass-12345' };

const UAS = {
  desktop: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36',
  desktop2: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36 Edg/154.0',
  phone: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.7827.137 Mobile Safari/537.36',
  watch: 'DSH-OPEN-WEB-storage-watch/1.0',
};

const server = spawn(process.execPath, ['server.mjs'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    DSHOW_PORT: String(PORT),
    DSHOW_HOST: '127.0.0.1',
    DSHOW_DATA_DIR: DIR,
    DSHOW_ADMIN_USER: ADMIN.username,
    DSHOW_ADMIN_PASSWORD: ADMIN.password,
    DSHOW_TRUST_PROXY: '0',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stderr.on('data', (chunk) => {
  const line = String(chunk);
  if (!/ExperimentalWarning|localstorage/.test(line)) process.stderr.write(`[сервис] ${line}`);
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitReady() {
  for (let i = 0; i < 80; i += 1) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return;
    } catch {}
    await sleep(250);
  }
  throw new Error('сервис не поднялся');
}

let failures = 0;
function check(ok, label, extra = '') {
  console.log(`${ok ? '  ok ' : '  ПРОВАЛ '}${label}${extra ? ' — ' + extra : ''}`);
  if (!ok) failures += 1;
}

async function login(ua) {
  const r = await fetch(`${BASE}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': ua },
    body: JSON.stringify(ADMIN),
  });
  const cookies = (r.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]);
  return { status: r.status, cookie: cookies.join('; '), body: await r.json().catch(() => null) };
}

async function me(cookie) {
  const r = await fetch(`${BASE}/api/me`, { headers: { cookie } });
  return { status: r.status, body: await r.json().catch(() => null) };
}

try {
  await waitReady();

  const laptop = await login(UAS.desktop);
  check(laptop.status === 200, 'вход с ноутбука');

  const phone = await login(UAS.phone);
  check(phone.status === 200, 'вход с телефона');

  check((await me(laptop.cookie)).status === 200, 'ноутбук не выбит телефоном');
  check((await me(phone.cookie)).status === 200, 'телефон жив');

  const watch = await login(UAS.watch);
  check(watch.status === 200, 'служебный вход сторожа');
  check((await me(laptop.cookie)).status === 200, 'ноутбук не выбит сторожем');
  check((await me(phone.cookie)).status === 200, 'телефон не выбит сторожем');
  check((await me(watch.cookie)).status === 200, 'сеанс сторожа жив');

  const second = await login(UAS.desktop2);
  check(second.status === 200, 'второй вход с компьютера');
  check((await me(laptop.cookie)).status === 401, 'второй компьютер выбил первый');
  check((await me(second.cookie)).status === 200, 'второй компьютер работает');
  check((await me(phone.cookie)).status === 200, 'телефон по-прежнему жив');
  check((await me(watch.cookie)).status === 200, 'сеанс сторожа по-прежнему жив');

  const again = await login(UAS.watch);
  check((await me(laptop.cookie)).status === 401 && (await me(second.cookie)).status === 200, 'служебные входы не трогают людей');
  check(again.status === 200, 'повторный служебный вход');

  const sessions = await fetch(`${BASE}/api/admin/sessions`, { headers: { cookie: again.cookie } });
  const data = await sessions.json();
  const service = data.sessions.filter((s) => s.service);
  check(sessions.status === 200 && service.length >= 2, 'в отчёте видно два служебных сеанса', `всего ${data.sessions.length}`);
  const human = data.sessions.filter((s) => !s.service);
  check(human.length === 2, 'у людей ровно два живых сеанса (компьютер и телефон)', `их ${human.length}`);
  check(
    data.audit.every((a) => a.events.every((e) => !/DSH-OPEN-WEB-/.test(e.ua))),
    'служебные входы не попадают в историю подозрений',
  );
} catch (error) {
  console.error('ошибка проверки:', error.message);
  failures += 1;
} finally {
  server.kill();
  await sleep(300);
  try {
    fs.rmSync(DIR, { recursive: true, force: true });
  } catch {}
}

console.log(failures ? `\nПровалов: ${failures}` : '\nВсё прошло');
process.exit(failures ? 1 : 0);
