/**
 * Проверка того, что вход не «выпадает» у ярлыка-приложения.
 *
 *  - cookie сеанса долгоживущая (30 дней по умолчанию), SameSite=Lax — переход
 *    по ссылке из другого приложения не выглядит как выход из аккаунта;
 *  - срок жизни скользящий и доходит до браузера: при продлении сервер снова
 *    присылает Set-Cookie, иначе браузер стирает cookie в день, отсчитанный от
 *    входа, как бы долго человек ни работал;
 *  - после продления обращение по-прежнему проходит авторизацию.
 *
 * Поднимает два отдельных экземпляра сервиса: первый — с обычным сроком (флаги
 * и длительность cookie), второй — с крошечным сроком, чтобы продление
 * случалось за секунды, а не за две недели.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ADMIN = { username: 'DSHOPENWEB', password: 'TestPass-12345' };
const UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Mobile Safari/537.36 DSH-OPEN-WEB-standalone';

let ok = 0;
let fail = 0;
const check = (name, condition, extra = '') => {
  if (condition) {
    ok += 1;
    console.log(`  ok   ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ''}`);
  }
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* Поднимает сервис на свободном порту с временными данными и нужным сроком входа. */
async function startServer(port, sessionDays) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshow-session-keep-'));
  const env = {
    ...process.env,
    DSHOW_PORT: String(port),
    DSHOW_HOST: '127.0.0.1',
    DSHOW_DATA_DIR: dir,
    DSHOW_ADMIN_USER: ADMIN.username,
    DSHOW_ADMIN_PASSWORD: ADMIN.password,
    DSHOW_TRUST_PROXY: '0',
  };
  if (sessionDays) env.DSHOW_SESSION_DAYS = String(sessionDays);
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: process.cwd(),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (chunk) => {
    const line = String(chunk);
    if (!/ExperimentalWarning|localstorage/.test(line)) process.stderr.write(`[сервис ${port}] ${line}`);
  });
  const base = `http://127.0.0.1:${port}`;
  let up = false;
  for (let i = 0; i < 120 && !up; i += 1) {
    try {
      const r = await fetch(`${base}/api/health`);
      up = r.ok;
    } catch {
      /* сервис ещё поднимается */
    }
    if (!up) await sleep(250);
  }
  const stop = () => {
    child.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  if (!up) {
    stop();
    throw new Error(`сервис на ${port} не поднялся`);
  }
  return { base, stop };
}

const cookieValue = (header) => {
  const match = /(^|;\s*)dshow_session=([^;]*)/.exec(header || '');
  return match ? decodeURIComponent(match[2]) : '';
};

async function login(base) {
  const response = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
    body: JSON.stringify(ADMIN),
  });
  const setCookie = (response.headers.getSetCookie?.() || [])[0] || '';
  return { status: response.status, setCookie, token: cookieValue(setCookie) };
}

async function get(base, pathname, token) {
  const headers = { 'User-Agent': UA };
  if (token) headers.Cookie = `dshow_session=${encodeURIComponent(token)}`;
  const response = await fetch(`${base}${pathname}`, { headers });
  return {
    status: response.status,
    setCookie: (response.headers.getSetCookie?.() || []).join('\n'),
    body: await response.json().catch(() => null),
  };
}

async function ordinarySession() {
  console.log('обычный срок входа');
  const { base, stop } = await startServer(3196);
  try {
    const entry = await login(base);
    check('вход принят', entry.status === 200, `код ${entry.status}`);
    check('cookie сеанса пришла', !!entry.token, entry.setCookie.slice(0, 40));
    check('срок cookie — 30 дней', /Max-Age=2592000\b/.test(entry.setCookie), entry.setCookie);
    check('SameSite=Lax — переход по ссылке не выбивает', /SameSite=Lax/i.test(entry.setCookie), entry.setCookie);
    check('HttpOnly — токен не читается скриптом страницы', /HttpOnly/i.test(entry.setCookie), entry.setCookie);
    check('Path=/ — работает и на вложенных адресах', /Path=\//i.test(entry.setCookie), entry.setCookie);

    const inside = await get(base, '/api/bootstrap', entry.token);
    check('с сеансом пускают внутрь', inside.status === 200, `код ${inside.status}`);
    check('сразу после входа продление не шлётся зря', !/dshow_session=/.test(inside.setCookie), inside.setCookie);

    const bogus = await get(base, '/api/bootstrap', 'подделка');
    check('чужой токен не пускает', bogus.status === 401, `код ${bogus.status}`);
  } finally {
    stop();
  }
}

async function slidingSession() {
  console.log('скользящее продление');
  /* 0,00003 суток ≈ 2,6 с: половина срока наступает через 1,3 с. */
  const { base, stop } = await startServer(3197, 0.00003);
  try {
    const entry = await login(base);
    check('короткий срок применился из окружения', /Max-Age=2\b/.test(entry.setCookie), entry.setCookie);
    const first = await get(base, '/api/bootstrap', entry.token);
    check('первое обращение принято', first.status === 200, `код ${first.status}`);

    await sleep(1700);
    const renewal = await get(base, '/api/bootstrap', entry.token);
    check('после половины срока приходит новый Set-Cookie', /dshow_session=/.test(renewal.setCookie), 'нет Set-Cookie');
    check('новый срок снова полный', /Max-Age=2\b/.test(renewal.setCookie), renewal.setCookie);

    /* Ждём дольше исходного срока: без продления сеанс был бы уже закрыт. */
    await sleep(1400);
    const after = await get(base, '/api/bootstrap', entry.token);
    check('продлённый сеанс жив дольше исходного срока', after.status === 200, `код ${after.status}`);
  } finally {
    stop();
  }
}

try {
  await ordinarySession();
  await slidingSession();
  console.log(`\n${ok} ok, ${fail} fail`);
} catch (error) {
  fail += 1;
  console.error('ОШИБКА:', error.message);
}
process.exit(fail ? 1 : 0);
