/* Временная учётка на живом сервисе для визуальной проверки: create | delete. */
const BASE = process.env.DSHOW_BASE || 'https://dshopen-vladimir00177.msk1.amvera.tech';
const ADMIN = process.env.DSHOW_USER || 'DSHOPENWEB';
const PASS = process.env.DSHOW_PASS;
const USERNAME = 'uicheck';
const PASSWORD = 'ui-check-2026';

if (!PASS) {
  console.error('нет DSHOW_PASS');
  process.exit(2);
}

const jar = new Map();
async function call(pathname, options = {}) {
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
  return { status: res.status, data };
}

const login = await call('/api/login', { method: 'POST', body: { username: ADMIN, password: PASS } });
if (login.status !== 200) {
  console.log(`вход админа не удался: ${login.status}`);
  process.exit(1);
}

const list = await call('/api/admin/users');
const existing = (list.data?.users || []).find((user) => user.username === USERNAME);

if ((process.argv[2] || 'create') === 'create') {
  if (existing) {
    console.log(`уже есть: ${existing.id}`);
  } else {
    const created = await call('/api/admin/users', {
      method: 'POST',
      body: { username: USERNAME, password: PASSWORD, displayName: 'UI Check', role: 'user' },
    });
    console.log(created.status === 200 ? `создан: ${created.data?.user?.id}` : `ошибка: ${created.status} ${JSON.stringify(created.data)}`);
  }
} else if (existing) {
  const removed = await call(`/api/admin/users/${existing.id}`, { method: 'DELETE' });
  console.log(removed.status === 200 ? `удалён: ${existing.id}` : `ошибка удаления: ${removed.status}`);
} else {
  console.log('нет такой учётки');
}
