import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../src/config.mjs';
import { hashPassword } from '../src/security.mjs';

const username = process.argv[2] || process.env.DSHOW_ADMIN_USER || 'DSH';
const password = process.argv[3] || process.env.DSHOW_ADMIN_PASSWORD;

if (!password) {
  console.error('Укажите пароль администратора: node scripts/seed-admin.mjs <логин> <пароль>');
  process.exit(1);
}

fs.mkdirSync(DATA_DIR, { recursive: true });
const file = path.join(DATA_DIR, 'admin-seed.json');
fs.writeFileSync(file, JSON.stringify({ username, password: hashPassword(password) }, null, 2), { mode: 0o600 });
console.log(`Создан ${file} для логина ${username} (пароль в файле не хранится).`);
