/* Проверка «тяжёлой задачи»: предупреждение, запрос админу, одобрение, продолжение.
   Запускается против локального сервера с крошечным лимитом (DSHOW_TASK_LIMIT_USD). */
const BASE = process.env.DSHOW_BASE || 'http://127.0.0.1:3323';
const ADMIN = process.env.DSHOW_USER || 'DSHOPENWEB';
const PASS = process.env.DSHOW_PASS;
const USERNAME = 'budgettest';
const PASSWORD = 'budget-check-2026';

if (!PASS) {
  console.error('нет DSHOW_PASS');
  process.exit(2);
}

function makeJar() {
  const jar = new Map();
  return {
    jar,
    async call(pathname, options = {}) {
      const res = await fetch(BASE + pathname, {
        method: options.method || 'GET',
        headers: {
          'content-type': 'application/json',
          cookie: [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; '),
        },
        body: options.body ? JSON.stringify(options.body) : undefined,
      });
      for (const entry of res.headers.getSetCookie?.() || []) {
        const [pair] = entry.split(';');
        const idx = pair.indexOf('=');
        if (idx > 0) jar.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
      }
      const text = await res.text();
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = { raw: text.slice(0, 200) };
      }
      return { status: res.status, data, text };
    },
  };
}

const admin = makeJar();
const results = [];
function check(label, ok, extra = '') {
  results.push({ label, ok, extra });
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}${extra ? ` — ${extra}` : ''}`);
}

const login = await admin.call('/api/login', { method: 'POST', body: { username: ADMIN, password: PASS } });
check('вход администратора', login.status === 200, `${login.status}`);

const users = await admin.call('/api/admin/users');
const stale = (users.data?.users || []).find((user) => user.username === USERNAME);
if (stale) await admin.call(`/api/admin/users/${stale.id}`, { method: 'DELETE' });

const created = await admin.call('/api/admin/users', {
  method: 'POST',
  body: { username: USERNAME, password: PASSWORD, displayName: 'Budget Test', role: 'user' },
});
check('временная учётка создана', created.status === 200, `${created.status}`);

const user = makeJar();
const ulogin = await user.call('/api/login', { method: 'POST', body: { username: USERNAME, password: PASSWORD } });
check('вход пользователя', ulogin.status === 200, `${ulogin.status}`);

const project = await user.call('/api/projects', { method: 'POST', body: { name: 'Проверка лимита' } });
check('проект создан', project.status === 200, `${project.status}`);
const projectId = project.data?.project?.id;

async function stream(pathname, body) {
  const res = await fetch(BASE + pathname, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: [...user.jar.entries()].map(([k, v]) => `${k}=${v}`).join('; '),
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const events = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith('data:')) continue;
    try {
      events.push(JSON.parse(line.slice(5).trim()));
    } catch {
      /* ignore */
    }
  }
  return { status: res.status, events, text };
}

const chat = await user.call(`/api/projects/${projectId}/chats`, { method: 'POST', body: {} });
const chatId = chat.data?.chat?.id;
check('диалог создан', Boolean(chatId), `${chatId || ''}`);

const turn = await stream(`/api/chats/${chatId}/messages`, {
  text: 'Привет! Коротко: что ты умеешь?',
});
const budgetEvent = turn.events.find((event) => event.type === 'budget');
const approvalEvent = turn.events.find((event) => event.type === 'approval');
check('событие budget пришло', Boolean(budgetEvent), budgetEvent ? `$${budgetEvent.spentUsd}` : '');
check('запрос админу создан', Boolean(approvalEvent), approvalEvent?.approval?.id || '');
check('предупреждение в тексте', turn.text.includes('больше лимита'));

const list = await admin.call('/api/admin/approvals');
const pending = (list.data?.approvals || []).find((item) => item.status === 'pending' && item.projectId === projectId);
check('запрос виден в панели', Boolean(pending), pending?.id || '');

if (pending) {
  const decided = await admin.call(`/api/admin/approvals/${pending.id}`, { method: 'POST', body: { action: 'approve' } });
  check('одобрение админом', decided.status === 200, decided.data?.budgetUsd ? `лимит $${decided.data.budgetUsd}` : '');
  const after = await admin.call('/api/admin/approvals');
  const updated = (after.data?.approvals || []).find((item) => item.id === pending.id);
  check('статус запроса обновлён', updated?.status === 'approved', updated?.status || '');
}

const second = await stream(`/api/chats/${chatId}/messages`, { text: 'Спасибо, продолжай.' });
check('продолжение после одобрения', second.status === 200 && !second.events.some((event) => event.type === 'budget'));
check('ответ пришёл', second.events.some((event) => event.type === 'done'), `${second.status}`);

await admin.call(`/api/admin/users/${created.data?.user?.id}`, { method: 'DELETE' });
const failed = results.filter((item) => !item.ok);
console.log(failed.length ? `\nИТОГ: провалов ${failed.length}` : '\nИТОГ: все проверки пройдены');
process.exit(failed.length ? 1 : 0);
