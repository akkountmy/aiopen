// Получение токена для MCP Amvera: кладёт %TEMP%\amvera-token.json (как ждёт amvera-mcp.mjs).
//
// Пароль берётся из хранилища DSH (C:\Users\33620\.dsh\secrets, DPAPI) или из
// переменных окружения AMVERA_USER / AMVERA_PASSWORD — в журнал не печатается.
//
//   node scripts/amvera-login.mjs
//
// Токен живёт 1800 секунд. Кабинет Amvera логинится через Keycloak
// (id.amvera.ru/auth/realms/amvera, клиент amvera-web) — тем же путём получаем
// токен напрямую, не заходя в панель.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const VAULT = path.join(os.homedir(), '.dsh', 'secrets', '_vault.ps1');
const TOKEN_URL = 'https://id.amvera.ru/auth/realms/amvera/protocol/openid-connect/token';

function fromVault(field) {
  const out = execFileSync(
    'powershell',
    ['-NoProfile', '-NonInteractive', '-Command', `& '${VAULT}' get amvera -Field ${field}`],
    { encoding: 'utf8' },
  );
  return out.trim();
}

function creds() {
  if (process.env.AMVERA_USER && process.env.AMVERA_PASSWORD) {
    return { user: process.env.AMVERA_USER, password: process.env.AMVERA_PASSWORD };
  }
  if (!fs.existsSync(VAULT)) throw new Error('нет хранилища паролей: ' + VAULT);
  return { user: fromVault('login'), password: fromVault('password') };
}

const { user, password } = creds();
if (!user || !password) throw new Error('нет логина или пароля Amvera');

const res = await fetch(TOKEN_URL, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ grant_type: 'password', client_id: 'amvera-web', username: user, password }),
});
const text = await res.text();
if (!res.ok) throw new Error(`Keycloak ответил ${res.status}: ${text.slice(0, 200)}`);
const data = JSON.parse(text);
if (!data.access_token) throw new Error('в ответе нет access_token');

const file = path.join(os.tmpdir(), 'amvera-token.json');
fs.writeFileSync(file, JSON.stringify({ access_token: data.access_token, expires_in: data.expires_in }, null, 2));
console.log(`токен получен (${Math.round((data.expires_in || 0) / 60)} мин), файл: ${file}`);
