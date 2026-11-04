/**
 * Локальный предпросмотр озвучки: поднимает копию данных проекта, сбрасывает
 * пароль админа в КОПИИ (настоящие данные не трогаются) и запускает сервер.
 * Так можно открыть страницу и потрогать «Озвучить» до выкладки.
 *
 * Запуск: node scripts\preview-tts.mjs [порт]
 */
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { hashPassword } from '../src/security.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const DATA = path.join(ROOT, '.preview-data');
const PORT = Number(process.argv[2] || 3300);
const PASSWORD = process.env.DSHOW_PREVIEW_PASSWORD || 'озвучка-2026';

if (!fs.existsSync(path.join(DATA, 'index.json'))) {
  throw new Error('нет .preview-data/index.json — сначала скопируйте data в .preview-data');
}

const storePath = path.join(DATA, 'index.json');
const store = JSON.parse(fs.readFileSync(storePath, 'utf8'));
const admin = store.users.find((user) => user.role === 'admin');
if (!admin) throw new Error('в копии данных нет администратора');
admin.password = hashPassword(PASSWORD);
admin.disabled = false;
fs.writeFileSync(storePath, JSON.stringify(store, null, 2), 'utf8');
console.log(`админ ${admin.username} в копии данных готов (пароль задан, значение не печатаю)`);

const child = spawn(process.execPath, ['server.mjs'], {
  cwd: ROOT,
  env: {
    ...process.env,
    DSHOW_HOST: '127.0.0.1',
    DSHOW_PORT: String(PORT),
    DSHOW_DATA_DIR: DATA,
    DSHOW_ADMIN_USER: admin.username,
    DSHOW_ADMIN_PASSWORD: PASSWORD,
    DSHOW_TG_TOKEN: '',
    DSHOW_TG_CHAT: '',
  },
  stdio: 'inherit',
});
child.on('exit', (code) => {
  console.log('сервер предпросмотра завершился, код', code);
  process.exit(code ?? 0);
});
