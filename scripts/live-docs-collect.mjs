/**
 * Собирает все четыре проверочных документа в один проект и убирает лишний
 * тестовый проект. Файлы берутся из .live-docs (уже скачанные копии).
 *
 *   $env:DSHOW_USER='...'; $env:DSHOW_PASS='...'; node scripts/live-docs-collect.mjs <id основного проекта> <id лишнего проекта>
 */
import fs from 'node:fs';
import path from 'node:path';

const BASE = (process.env.DSHOW_BASE || 'http://127.0.0.1:3123').replace(/\/$/, '');
const USERNAME = process.env.DSHOW_USER || '';
const PASSWORD = process.env.DSHOW_PASS || '';
const OUT = path.join(import.meta.dirname, '..', '.live-docs');

const [keepId, dropId] = process.argv.slice(2);
if (!keepId) throw new Error('укажите id проекта, в который собираем файлы');

let cookie = '';
async function call(p, { method = 'GET', body } = {}) {
  const init = { method, headers: {} };
  if (cookie) init.headers.cookie = cookie;
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const response = await fetch(`${BASE}${p}`, init);
  const setCookies = response.headers.getSetCookie ? response.headers.getSetCookie() : [];
  if (setCookies.length) cookie = setCookies.map((item) => item.split(';')[0]).join('; ');
  const type = response.headers.get('content-type') || '';
  const data = type.includes('application/json') ? await response.json() : await response.text();
  if (!response.ok) throw new Error(`${method} ${p} → ${response.status}: ${String(JSON.stringify(data)).slice(0, 250)}`);
  return data;
}

await call('/api/login', { method: 'POST', body: { username: USERNAME, password: PASSWORD } });

const existing = new Set(
  (await call(`/api/projects/${keepId}/files?path=.&depth=2`)).items.map((item) => item.name),
);

for (const entry of fs.readdirSync(OUT)) {
  if (!/\.(docx|xlsx|pptx|pdf)$/i.test(entry)) continue;
  if (existing.has(entry)) {
    console.log(`уже есть: ${entry}`);
    continue;
  }
  const response = await fetch(`${BASE}/api/projects/${keepId}/upload?path=${encodeURIComponent(entry)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': encodeURIComponent(entry), cookie },
    body: fs.readFileSync(path.join(OUT, entry)),
  });
  if (!response.ok) throw new Error(`загрузка ${entry} → ${response.status}`);
  console.log(`загружено: ${entry}`);
}

const list = (await call(`/api/projects/${keepId}/files?path=.&depth=2`)).items;
for (const item of list) console.log(`  ${item.path}  ${Math.round((Number(item.size) || 0) / 1024)} КБ`);

if (dropId) {
  await call(`/api/projects/${dropId}`, { method: 'DELETE' });
  console.log(`удалён лишний проект ${dropId.slice(0, 12)}…`);
}
console.log(`\nОткрыть: ${BASE}/?project=${keepId}`);
