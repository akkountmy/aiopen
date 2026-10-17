/* Лёгкая проверка облака: вход, список проектов и файлов. Без обращений к модели. */
const BASE = process.env.DSHOW_BASE || 'https://dshopen-vladimir00177.msk1.amvera.tech';
const USER = process.env.DSHOW_USER;
const PASS = process.env.DSHOW_PASS;

const jar = new Map();
function cookieHeader() {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}
function storeCookies(res) {
  const list = res.headers.getSetCookie?.() || [];
  for (const entry of list) {
    const [pair] = entry.split(';');
    const idx = pair.indexOf('=');
    if (idx > 0) jar.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
  }
}
async function call(pathname, options = {}) {
  const res = await fetch(BASE + pathname, {
    ...options,
    headers: { 'content-type': 'application/json', cookie: cookieHeader(), ...(options.headers || {}) },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  storeCookies(res);
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text.slice(0, 200) };
  }
  return { status: res.status, data };
}

const results = [];
const check = (name, ok, extra = '') => results.push(`${ok ? 'OK  ' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);

const login = await call('/api/login', { method: 'POST', body: { username: USER, password: PASS } });
check('вход', login.status === 200 && !!login.data?.user, String(login.status));
check('роль администратора', login.data?.user?.role === 'admin', login.data?.user?.role || '—');
check('cookie сессии', jar.size > 0, `${jar.size} шт.`);

const me = await call('/api/me');
check('/api/me', me.status === 200 && !!me.data?.user);
const projects = me.data?.projects || [];
check('проекты получены', Array.isArray(projects), `${projects.length} шт.`);

const first = projects[0];
if (first) {
  const files = await call(`/api/projects/${first.id}/files?path=.&depth=3`);
  const items = files.data?.items || [];
  check('файлы проекта', files.status === 200 && Array.isArray(items), `${items.length} шт.`);
  const chats = first.chats || [];
  check('диалоги проекта', Array.isArray(chats), `${chats.length} шт.`);
}

console.log(results.join('\n'));
const failed = results.filter((line) => line.startsWith('FAIL')).length;
console.log(failed ? `\nПРОВАЛОВ: ${failed}` : '\nВсё прошло');
process.exit(failed ? 1 : 0);
