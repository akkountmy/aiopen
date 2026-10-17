/**
 * Живая проверка сценария «лендинг»: агент должен создать index.html за отведённые шаги.
 * Требует запущенный сервер и ключи моделей.
 *   $env:DSHOW_USER='...'; $env:DSHOW_PASS='...'; node test/landing.mjs
 */
const BASE = (process.env.DSHOW_BASE || 'http://127.0.0.1:3123').replace(/\/$/, '');
const USERNAME = process.env.DSHOW_USER || '';
const PASSWORD = process.env.DSHOW_PASS || '';
const TASK = 'Сделай лендинг по продаже психологических сессий. Пришли локальную ссылку.';

let cookie = '';

async function login() {
  const response = await fetch(`${BASE}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
  });
  cookie = (response.headers.getSetCookie ? response.headers.getSetCookie() : [])
    .map((item) => item.split(';')[0])
    .join('; ');
  if (!response.ok) throw new Error(`вход ${response.status}`);
}

async function api(path, options = {}) {
  const init = { method: options.method || 'GET', headers: { cookie, ...(options.headers || {}) } };
  if (options.body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(options.body);
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
  const { project } = await api('/api/projects', { method: 'POST', body: { name: 'Лендинг-проверка' } });
  const { chat } = await api(`/api/projects/${project.id}/chats`, { method: 'POST', body: {} });

  const response = await fetch(`${BASE}/api/chats/${chat.id}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ text: TASK }),
  });
  if (!response.ok) throw new Error(`messages → ${response.status}`);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let answer = '';
  let steps = 0;
  let failures = 0;
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
          if (event.status === 'run') steps++;
          if (event.status === 'ok') console.log(`  ok   ${event.label} ${event.summary || ''}`);
          if (event.status === 'error') {
            failures++;
            console.log(`  FAIL ${event.label} — ${event.detail || event.summary || ''}`);
          }
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
  const hitLimit = /предел шагов/.test(answer);
  console.log(`\nОтвет за ${seconds} с, шагов: ${steps}, ошибок инструментов: ${failures}`);
  console.log(`Предел шагов: ${hitLimit ? 'ДОСТИГНУТ (плохо)' : 'нет'}`);
  console.log(`Текст: ${answer.trim().slice(0, 700)}`);

  const files = await api(`/api/projects/${project.id}/files?depth=4`);
  const landing = files.items.find((item) => item.path.endsWith('index.html'));
  console.log(`index.html: ${landing ? `${landing.size} Б` : 'НЕТ'}`);
  if (landing) {
    const preview = await fetch(
      `${BASE}/api/projects/${project.id}/preview?path=${encodeURIComponent(landing.path)}`,
      { headers: { cookie } },
    );
    const body = await preview.text();
    console.log(`preview: ${preview.status}, ${body.length} Б, CSP: ${preview.headers.get('content-security-policy') ? 'есть' : 'нет'}`);
    if (preview.status !== 200 || !/html/i.test(preview.headers.get('content-type') || '')) {
      console.log('ВНИМАНИЕ: страница не открывается');
    }
  }

  await api(`/api/projects/${project.id}`, { method: 'DELETE' });
  console.log('Уборка: ok');
  if (!landing || hitLimit) process.exitCode = 1;
}

main().catch((error) => {
  console.error('\nСбой проверки лендинга:', error.message);
  process.exit(1);
});
