// Смоук-проверка потока ответа (SSE): логин, проект, диалог, короткое сообщение.
// Запуск: DSHOW_BASE=http://127.0.0.1:3123 DSHOW_USER=... DSHOW_PASS=... node scripts/_sse-smoke.mjs
const base = process.env.DSHOW_BASE || 'http://127.0.0.1:3123';
const user = process.env.DSHOW_USER;
const pass = process.env.DSHOW_PASS;
if (!user || !pass) {
  console.error('нет DSHOW_USER/DSHOW_PASS');
  process.exit(1);
}

let cookie = '';
async function call(path, { method = 'GET', body } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const set = res.headers.getSetCookie?.() || [];
  if (set.length) cookie = set.map((c) => c.split(';')[0]).join('; ');
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* не JSON */
  }
  if (!res.ok) throw new Error(`${path} → ${res.status} ${text.slice(0, 200)}`);
  return json;
}

const login = await call('/api/login', { method: 'POST', body: { username: user, password: pass } });
if (!login?.user) throw new Error('логин не вернул пользователя');
console.log('OK вход', login.user.role);

const boot = await call('/api/me');
const project = boot.projects?.[0] || (await call('/api/projects', { method: 'POST', body: { name: 'Смоук' } })).project;
console.log('OK проект', project.name);

const { chat } = await call(`/api/projects/${project.id}/chats`, { method: 'POST', body: {} });
console.log('OK диалог', chat.id);

const started = Date.now();
const res = await fetch(`${base}/api/chats/${chat.id}/messages`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Cookie: cookie },
  body: JSON.stringify({ text: 'Ответь одним словом: готово' }),
});
if (!res.ok) throw new Error(`SSE ${res.status} ${await res.text()}`);
const reader = res.body.getReader();
const decoder = new TextDecoder();
let buffer = '';
let answer = '';
const events = [];
const deadline = Date.now() + 90000;
while (Date.now() < deadline) {
  const { value, done } = await reader.read();
  if (done) break;
  buffer += decoder.decode(value, { stream: true });
  const chunks = buffer.split('\n\n');
  buffer = chunks.pop() || '';
  for (const chunk of chunks) {
    const data = /^data: (.+)$/m.exec(chunk)?.[1];
    if (!data) continue;
    let payload = null;
    try {
      payload = JSON.parse(data);
    } catch {
      continue;
    }
    const type = payload.type;
    if (type) events.push(type);
    if (type === 'delta' && payload.text) answer += payload.text;
    if (type === 'done') {
      await reader.cancel().catch(() => {});
      console.log('OK поток', [...new Set(events)].join(','), '| ответ:', answer.trim().slice(0, 120));
      console.log('OK время, мс:', Date.now() - started, '| токены:', JSON.stringify(payload.usage || {}));
      process.exit(0);
    }
    if (type === 'error') throw new Error(`SSE error: ${data}`);
  }
}
throw new Error(`нет события done; события: ${[...new Set(events)].join(',')}; текст: ${answer.slice(0, 120)}`);
