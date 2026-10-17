/**
 * Живая проверка диалога: вход, проект, вложение, поток ответа, инструменты.
 * Требует запущенный сервер и ключи моделей на сервере:
 *   $env:DSHOW_USER='...'; $env:DSHOW_PASS='...'; node test/live.mjs
 * Тратит токены — это не часть обычного дымового теста.
 */
const BASE = (process.env.DSHOW_BASE || 'http://127.0.0.1:3123').replace(/\/$/, '');
const USERNAME = process.env.DSHOW_USER || '';
const PASSWORD = process.env.DSHOW_PASS || '';

let cookie = '';

async function login() {
  const response = await fetch(`${BASE}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
  });
  const cookies = response.headers.getSetCookie ? response.headers.getSetCookie() : [];
  cookie = cookies.map((item) => item.split(';')[0]).join('; ');
  if (!response.ok) throw new Error(`вход ${response.status}`);
}

async function api(path, options = {}) {
  const init = { method: options.method || 'GET', headers: { cookie, ...(options.headers || {}) } };
  if (options.body !== undefined && !options.raw) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(options.body);
  } else if (options.raw) {
    init.body = options.body;
  }
  const response = await fetch(`${BASE}${path}`, init);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${path} → ${response.status} ${data.error || ''}`);
  return data;
}

async function main() {
  if (!USERNAME || !PASSWORD) {
    console.error('Задайте DSHOW_USER и DSHOW_PASS.');
    process.exit(2);
  }
  await login();
  const { project } = await api('/api/projects', { method: 'POST', body: { name: 'Проверка диалога' } });
  const { chat } = await api(`/api/projects/${project.id}/chats`, { method: 'POST', body: {} });

  const text = 'В файле demo.md записан секретный код. Прочитай файл инструментом и назови код одним словом.';
  const upload = await api(`/api/projects/${project.id}/upload?path=${encodeURIComponent('demo.md')}`, {
    method: 'POST',
    raw: true,
    headers: { 'Content-Type': 'text/markdown; charset=utf-8', 'X-Filename': encodeURIComponent('demo.md') },
    body: 'Секретный код: КЕДР-77',
  });

  const response = await fetch(`${BASE}/api/chats/${chat.id}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ text }),
  });
  if (!response.ok) throw new Error(`messages → ${response.status}`);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let answer = '';
  const tools = [];
  let done = false;
  const started = Date.now();
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
        if (event.type === 'tool') {
          if (event.status === 'run') tools.push(event.label);
          if (event.status === 'ok') console.log(`  инструмент ok: ${event.label} — ${event.summary || ''}`);
          if (event.status === 'error') console.log(`  инструмент fail: ${event.label} — ${event.summary || ''}`);
        }
        if (event.type === 'title') console.log(`  заголовок: ${event.title}`);
        if (event.type === 'error') console.log(`  ошибка сервера: ${event.message}`);
        if (event.type === 'done') {
          done = true;
          console.log(`  использование: ${JSON.stringify(event.usage || {})}`);
        }
      }
    }
  }
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`\nОтвет за ${seconds} с, инструментов: ${tools.length}`);
  console.log(`Текст: ${answer.trim().slice(0, 500)}`);
  if (!answer.trim()) throw new Error('пустой ответ');
  if (!/КЕДР-77/i.test(answer)) console.log('\nВНИМАНИЕ: код из файла в ответе не найден');

  const after = await api(`/api/chats/${chat.id}`);
  console.log(`История: ${after.chat.messages.length} сообщений`);

  const del = await api(`/api/projects/${project.id}`, { method: 'DELETE' });
  console.log(`Уборка: ${del.ok ? 'ok' : 'fail'}`);
}

main().catch((error) => {
  console.error('\nСбой живой проверки:', error.message);
  process.exit(1);
});
