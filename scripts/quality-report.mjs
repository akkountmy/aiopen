// Сводка качества ответов живого сервиса — без входа в панель руками.
//
//   node scripts/quality-report.mjs            // 7 дней
//   node scripts/quality-report.mjs 30         // 30 дней
//
// Пароль администратора берётся из хранилища DSH (C:\Users\33620\.dsh\secrets,
// запись `dshow-admin`) или из переменных DSHOW_ADMIN_USER / DSHOW_ADMIN_PASSWORD.
// В журнал пароль и cookie не печатаются: вывод — только цифры сводки.
//
// Вход помечен как служебный (User-Agent `DSH-OPEN-WEB-…`), поэтому он не
// занимает место живого браузера и не выбивает владельца из панели.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BASE = process.env.DSHOW_BASE || 'https://dshopen-vladimir00177.msk1.amvera.tech';
const VAULT = path.join(os.homedir(), '.dsh', 'secrets', '_vault.ps1');
const SERVICE_UA = 'DSH-OPEN-WEB-quality-report/1.0';

function fromVault(field) {
  const out = execFileSync(
    'powershell',
    ['-NoProfile', '-NonInteractive', '-Command', `& '${VAULT}' get dshow-admin -Field ${field}`],
    { encoding: 'utf8' },
  );
  return out.trim();
}

function creds() {
  if (process.env.DSHOW_ADMIN_USER && process.env.DSHOW_ADMIN_PASSWORD) {
    return { username: process.env.DSHOW_ADMIN_USER, password: process.env.DSHOW_ADMIN_PASSWORD };
  }
  if (!fs.existsSync(VAULT)) throw new Error('нет хранилища паролей: ' + VAULT);
  return { username: fromVault('login'), password: fromVault('password') };
}

const days = Math.max(1, Math.min(90, Number(process.argv[2]) || 7));

const { username, password } = creds();
const login = await fetch(`${BASE}/api/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'user-agent': SERVICE_UA, 'x-dshow-service': '1' },
  body: JSON.stringify({ username, password }),
});
if (!login.ok) {
  console.error(`вход не удался: HTTP ${login.status}`);
  process.exit(1);
}
const cookie = (login.headers.getSetCookie?.() || []).map((item) => item.split(';')[0]).join('; ');
const me = await login.json();
console.log(`вошёл как ${me.user?.username || username} (роль: ${me.user?.role || '?'})`);

const headers = { cookie, 'user-agent': SERVICE_UA, 'x-dshow-service': '1' };
const quality = await fetch(`${BASE}/api/admin/quality?days=${days}`, { headers });
if (!quality.ok) {
  console.error(`сводка недоступна: HTTP ${quality.status}`);
  process.exit(1);
}
const data = await quality.json();
console.log(`\n==== качество ответов за ${days} дн. ====`);
console.log(data.text || '(пусто)');
console.log(`\nстрок в сводке: ${(data.days || []).length}, проверено в ${data.checkedAt || '?'}`);

if (process.argv.includes('--json')) {
  console.log('\n==== json ====');
  console.log(JSON.stringify(data, null, 2));
}

const stats = await fetch(`${BASE}/api/admin/stats`, { headers });
if (stats.ok) {
  const body = await stats.json();
  const overview = body.overview || {};
  const users = Array.isArray(overview.users) ? overview.users.length : overview.users ?? '?';
  console.log(`\n==== обзор сервиса ====`);
  console.log(`пользователей: ${users}`);
  for (const [key, value] of Object.entries(overview)) {
    if (key === 'users') continue;
    if (Array.isArray(value)) console.log(`${key}: ${value.length} шт.`);
  }
}
