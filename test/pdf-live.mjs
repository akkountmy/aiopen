/**
 * Живая проверка PDF-запроса: «презентация на два слайда в PDF» должна дать .pdf.
 * Требует запущенный сервер: $env:DSHOW_USER / $env:DSHOW_PASS.
 */
const BASE = (process.env.DSHOW_BASE || 'http://127.0.0.1:3123').replace(/\/$/, '');
const USERNAME = process.env.DSHOW_USER || '';
const PASSWORD = process.env.DSHOW_PASS || '';
let cookie = '';

async function api(path, options = {}) {
  const init = { method: options.method || 'GET', headers: { cookie } };
  if (options.body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(options.body);
  }
  const response = await fetch(`${BASE}${path}`, init);
  if (!response.ok) throw new Error(`${path} → ${response.status}`);
  return response.json();
}

const login = await fetch(`${BASE}/api/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
});
if (!login.ok) throw new Error(`вход ${login.status}`);
cookie = login.headers.getSetCookie().map((item) => item.split(';')[0]).join('; ');

const { project } = await api('/api/projects', { method: 'POST', body: { name: 'Проверка PDF' } });
const { chat } = await api(`/api/projects/${project.id}/chats`, { method: 'POST', body: {} });

const prompt = 'Сделай мини презентацию на два слайда в пдф по продаже психологической сессии.';
const response = await fetch(`${BASE}/api/chats/${chat.id}/messages`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', cookie },
  body: JSON.stringify({ text: prompt }),
});

const reader = response.body.getReader();
const decoder = new TextDecoder();
let buffer = '';
let answer = '';
let done = false;
const tools = [];
while (!done) {
  const { done: finished, value } = await reader.read();
  if (finished) break;
  buffer += decoder.decode(value, { stream: true });
  const blocks = buffer.split('\n\n');
  buffer = blocks.pop() || '';
  for (const block of blocks) {
    for (const line of block.split('\n')) {
      if (!line.startsWith('data:')) continue;
      const event = JSON.parse(line.slice(5).trim());
      if (event.type === 'delta') answer += event.text;
      if (event.type === 'tool' && event.status === 'run') tools.push(event.label);
      if (event.type === 'tool' && event.status === 'ok') console.log(`ok: ${event.label} — ${event.summary || ''}`);
      if (event.type === 'tool' && event.status === 'error') console.log(`fail: ${event.label} — ${event.summary || ''}`);
      if (event.type === 'error') console.log(`ошибка: ${event.message}`);
      if (event.type === 'done') done = true;
    }
  }
}

const listing = await api(`/api/projects/${project.id}/files`);
const files = (listing.items || listing.files || []).map((item) => item.path || item.name);
console.log('\nФайлы проекта:', files.join(', ') || '(пусто)');
console.log('Инструменты:', tools.join(', ') || '(нет)');
console.log('Ответ:', answer.trim().slice(0, 400));

const pdf = files.find((file) => file.toLowerCase().endsWith('.pdf'));
if (!pdf) throw new Error('PDF не появился');
const file = await fetch(`${BASE}/api/projects/${project.id}/file?path=${encodeURIComponent(pdf)}`, { headers: { cookie } });
const bytes = Buffer.from(await file.arrayBuffer());
console.log(`\n${pdf}: ${bytes.length} байт, тип ${file.headers.get('content-type')}`);
console.log('PDF-заголовок:', bytes.subarray(0, 8).toString('latin1'));
if (bytes.subarray(0, 5).toString('latin1') !== '%PDF-') throw new Error('файл не PDF');

if (process.env.PDF_OUT) {
  const fs = await import('node:fs');
  fs.mkdirSync(process.env.PDF_OUT, { recursive: true });
  fs.writeFileSync(`${process.env.PDF_OUT}/live.pdf`, bytes);
  console.log(`сохранено: ${process.env.PDF_OUT}\\live.pdf`);
}

const cleanup = await api(`/api/projects/${project.id}`, { method: 'DELETE' });
console.log('Уборка:', cleanup.ok ? 'ok' : 'fail');
