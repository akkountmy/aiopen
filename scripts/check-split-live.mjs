/**
 * Живая проверка распределения шагов на облачном сервисе.
 *
 * Загружает файл на ~7 КБ, просит прочитать его инструментом и ответить одной
 * цифрой. Первый шаг — механика (read_file), данных больше порога, поэтому
 * второй шаг должен уйти на сильную модель: в логах сервиса появится строка
 * `[model] шаг на pro`. Ответ при этом должен быть верным.
 *
 * Запуск:
 *   $env:DSHOW_BASE='https://dshopen-vladimir00177.msk1.amvera.tech'
 *   $env:DSHOW_USER='...'; $env:DSHOW_PASS='...'
 *   node scripts/check-split-live.mjs
 */
const BASE = (process.env.DSHOW_BASE || 'http://127.0.0.1:3123').replace(/\/$/, '');
const USERNAME = process.env.DSHOW_USER || '';
const PASSWORD = process.env.DSHOW_PASS || '';

const sections = [
  'Раздел 1 — Заявки: 4 строки',
  'Раздел 2 — Договоры: 6 строк',
  'Раздел 3 — Оплаты: 9 строк',
  'Раздел 4 — Отгрузки: 5 строк',
  'Раздел 5 — Возвраты: 2 строки',
  'Раздел 6 — Претензии: 3 строки',
  'Раздел 7 — Сверка: 12 строк',
  'Раздел 8 — Архив: 7 строк',
];
const filler = 'Пояснение к разделу: значения сверены с выгрузкой учётной системы, расхождений нет. '.repeat(4);
const fileText = `# Выгрузка по разделам\n\n${sections
  .map((line, index) => `## ${line}\n\n${filler}Порядковый номер раздела: ${index + 1}.`)
  .join('\n\n')}\n`;

const ANSWER = '12';

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
  if (options.raw) init.body = options.body;
  else if (options.body !== undefined) {
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
  const { project } = await api('/api/projects', { method: 'POST', body: { name: 'Проверка разделения моделей' } });
  const { chat } = await api(`/api/projects/${project.id}/chats`, { method: 'POST', body: {} });
  await api(`/api/projects/${project.id}/upload?path=${encodeURIComponent('data.md')}`, {
    method: 'POST',
    raw: true,
    headers: { 'Content-Type': 'text/markdown; charset=utf-8', 'X-Filename': encodeURIComponent('data.md') },
    body: fileText,
  });

  const text =
    'В файле data.md выгрузка по разделам. Прочитай файл инструментом и ответь: сколько строк в «Раздел 7 — Сверка»? ' +
    'Ответь одной цифрой, без пояснений.';
  const started = Date.now();
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
  let finished = false;
  while (!finished) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const blocks = buffer.split('\n\n');
    buffer = blocks.pop() || '';
    for (const block of blocks) {
      for (const line of block.split('\n')) {
        if (!line.startsWith('data:')) continue;
        let event;
        try {
          event = JSON.parse(line.slice(5).trim());
        } catch {
          continue;
        }
        if (event.type === 'delta' && event.text) answer += event.text;
        if (event.type === 'tool' && event.name && event.status === 'run') tools.push(event.name);
        if (event.type === 'done') finished = true;
      }
    }
  }
  const seconds = Math.round((Date.now() - started) / 1000);
  const ok = answer.includes(ANSWER);
  console.log(`инструменты: ${tools.join(', ') || '—'}`);
  console.log(`ответ: ${answer.trim().slice(0, 200).replace(/\s+/g, ' ')}`);
  console.log(`${ok ? 'ok' : 'FAIL'}: ${seconds} с, ожидалось ${ANSWER}`);
  process.exit(ok ? 0 : 1);
}

main().catch((error) => {
  console.error('ошибка:', error.message);
  process.exit(1);
});
