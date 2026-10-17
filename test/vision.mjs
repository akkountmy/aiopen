/**
 * Проверка распознавания изображения: загрузка и разбор через сервер.
 *   $env:DSHOW_USER='...'; $env:DSHOW_PASS='...'; node test/vision.mjs <путь-к-картинке>
 */
import fs from 'node:fs';
import path from 'node:path';

const BASE = (process.env.DSHOW_BASE || 'http://127.0.0.1:3123').replace(/\/$/, '');
const USERNAME = process.env.DSHOW_USER || '';
const PASSWORD = process.env.DSHOW_PASS || '';
const filePath = process.argv[2];

if (!USERNAME || !PASSWORD || !filePath) {
  console.error('Нужны DSHOW_USER, DSHOW_PASS и путь к изображению.');
  process.exit(2);
}

let cookie = '';

async function login() {
  const response = await fetch(`${BASE}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
  });
  if (!response.ok) throw new Error(`вход ${response.status}`);
  cookie = response.headers.getSetCookie().map((item) => item.split(';')[0]).join('; ');
}

async function api(pathName, options = {}) {
  const init = { method: options.method || 'GET', headers: { cookie, ...(options.headers || {}) } };
  if (options.json !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(options.json);
  } else if (options.body) {
    init.body = options.body;
  }
  const response = await fetch(`${BASE}${pathName}`, init);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${pathName} → ${response.status} ${data.error || ''}`);
  return data;
}

async function main() {
  await login();
  const { project } = await api('/api/projects', { method: 'POST', json: { name: 'Проверка распознавания' } });
  const { chat } = await api(`/api/projects/${project.id}/chats`, { method: 'POST', json: {} });
  const buffer = fs.readFileSync(filePath);
  const uploaded = await api('/api/attachments', {
    method: 'POST',
    headers: {
      'Content-Type': 'image/png',
      'X-Filename': encodeURIComponent(path.basename(filePath)),
      'X-Project-Id': project.id,
      'X-Chat-Id': chat.id,
    },
    body: buffer,
  });
  let att = uploaded.attachment;
  console.log(`загружено: ${att.id} ${att.status}`);
  const started = Date.now();
  while (att.status === 'processing' && Date.now() - started < 180000) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const data = await api(`/api/attachments/${att.id}`);
    att = data.attachment;
  }
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`статус: ${att.status} за ${seconds} с`);
  if (att.status !== 'ready') {
    console.log('предупреждения:', (att.warnings || []).join('; ') || '(нет)');
    await api(`/api/projects/${project.id}`, { method: 'DELETE' });
    process.exit(1);
  }

  // Проверяем, что распознанный текст реально доходит до модели.
  const response = await fetch(`${BASE}/api/chats/${chat.id}/messages`, {
    method: 'POST',
    headers: { cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'Что написано в документе? Назови клиента, сумму и срок оплаты.', attachmentIds: [att.id] }),
  });
  if (!response.ok) throw new Error(`сообщение → ${response.status}`);
  await response.text();
  const after = await api(`/api/chats/${chat.id}`);
  const last = [...after.chat.messages].reverse().find((item) => item.role === 'assistant');
  const answer = String(last?.content || '');
  console.log('ответ модели:\n---\n' + answer.slice(0, 1200) + '\n---');
  const ok = /КЕДР-?77/i.test(answer) && /128\s?450/.test(answer);
  console.log(ok ? 'ПРОВЕРКА: текст дошёл до модели' : 'ПРОВЕРКА: в ответе нет данных из картинки');
  await api(`/api/projects/${project.id}`, { method: 'DELETE' });
  process.exit(ok ? 0 : 1);
}

main().catch((error) => {
  console.error('Сбой:', error.message);
  process.exit(1);
});
