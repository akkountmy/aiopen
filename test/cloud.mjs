// Проверка облачного развёртывания: node test/cloud.mjs
import fs from 'node:fs';

const BASE = process.env.DSHOW_BASE || 'https://dshopen-vladimir00177.msk1.amvera.tech';
const USER = process.env.DSHOW_USER || 'DSHOPENWEB';
const PASS = process.env.DSHOW_PASS;
if (!PASS) throw new Error('нет DSHOW_PASS');

let cookie = '';
const log = [];
function ok(name, extra = '') {
  log.push(`  ok  ${name}${extra ? ' — ' + extra : ''}`);
  console.log(log.at(-1));
}
function fail(name, detail) {
  log.push(`  FAIL ${name}: ${detail}`);
  console.log(log.at(-1));
}

async function api(path, { method = 'GET', body, headers = {}, raw } = {}) {
  const init = { method, headers: { ...headers } };
  if (body !== undefined) {
    init.body = raw ? body : JSON.stringify(body);
    if (!raw) init.headers['Content-Type'] = 'application/json';
  }
  if (cookie) init.headers.Cookie = cookie;
  const res = await fetch(BASE + path, init);
  /* Печенек несколько (сеанс и метка устройства), поэтому складываем их в
     список, а не оставляем последнюю. */
  const setCookie = res.headers.getSetCookie?.() || [];
  for (const c of setCookie) {
    const pair = c.split(';')[0];
    if (!pair.includes('=')) continue;
    const name = pair.slice(0, pair.indexOf('='));
    const kept = cookie
      .split('; ')
      .filter((item) => item && item.slice(0, item.indexOf('=')) !== name);
    kept.push(pair);
    cookie = kept.join('; ');
  }
  const type = res.headers.get('content-type') || '';
  const data = type.includes('json') ? await res.json().catch(() => null) : await res.text();
  return { res, data, type };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 1. здоровье и вход
{
  const { res, data } = await api('/api/health');
  res.ok && data?.ok ? ok('health') : fail('health', res.status);
}
{
  const { res } = await api('/api/login', { method: 'POST', body: { username: USER, password: 'неверный-пароль-1' } });
  res.status === 401 ? ok('неверный пароль отклонён') : fail('неверный пароль', res.status);
}
let adminId = '';
{
  const { res, data, headers } = await api('/api/login', { method: 'POST', body: { username: USER, password: PASS } });
  const raw = res.headers.getSetCookie?.() || [];
  const flags = raw.join(' ');
  if (!res.ok) fail('вход', res.status + ' ' + JSON.stringify(data));
  else ok('вход', `HttpOnly=${/HttpOnly/.test(flags)} SameSite=${/SameSite=Strict/.test(flags)} Secure=${/Secure/.test(flags)}`);
  adminId = data?.user?.id || '';
}
{
  const { res, data } = await api('/api/bootstrap');
  res.ok && Array.isArray(data?.projects) ? ok('bootstrap', `${data.projects.length} проектов`) : fail('bootstrap', res.status);
}
{
  const { res, data } = await api('/api/admin/stats');
  res.ok ? ok('статистика администратора') : fail('статистика', res.status + JSON.stringify(data));
}

// 2. проект, диалог, файл, ответ модели
const marker = 'KOROBKA-7741';
let projectId = '';
let chatId = '';
{
  const { res, data } = await api('/api/projects', { method: 'POST', body: { name: 'Проверка облака' } });
  if (!res.ok) fail('проект', res.status);
  else ok('проект создан');
  projectId = data?.project?.id;
  const chat = await api(`/api/projects/${projectId}/chats`, { method: 'POST', body: { title: 'Облачная проверка' } });
  chatId = chat.data?.chat?.id;
  chatId ? ok('диалог создан') : fail('диалог', JSON.stringify(chat.data));
}
let attachmentId = '';
{
  const text = `Складская накладная № ${marker}\nТовар: коробки картонные, 12 шт.\nСумма: 8 400 руб.\n`;
  const form = new FormData();
  form.append('file', new Blob([text], { type: 'text/plain' }), 'nakladnaya.txt');
  const res = await fetch(BASE + '/api/attachments', {
    method: 'POST',
    headers: {
      Cookie: cookie,
      'x-filename': encodeURIComponent('nakladnaya.txt'),
      'x-project-id': projectId,
      'x-chat-id': chatId,
      'Content-Type': 'text/plain',
    },
    body: text,
  });
  const data = await res.json().catch(() => null);
  attachmentId = data?.attachment?.id;
  attachmentId ? ok('файл загружен') : fail('загрузка', res.status + JSON.stringify(data));
}
for (let i = 0; i < 40 && attachmentId; i++) {
  const { data } = await api(`/api/attachments/${attachmentId}`);
  if (data?.attachment?.status === 'ready') {
    ok('файл разобран', `${String(data.attachment.text || '').length} символов`);
    break;
  }
  await sleep(500);
}

async function chatTurn(text) {
  const t0 = Date.now();
  const res = await fetch(`${BASE}/api/chats/${chatId}/messages`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, attachmentIds: attachmentId ? [attachmentId] : [] }),
  });
  if (!res.ok) return { error: `${res.status} ${await res.text()}` };
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let answer = '';
  let events = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    for (const line of buf.split('\n')) {
      const s = line.trim();
      if (!s.startsWith('data:')) continue;
      const payload = s.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        const ev = JSON.parse(payload);
        events += 1;
        if (ev.type === 'delta' && ev.text) answer += ev.text;
        if (ev.type === 'error') return { error: ev.message };
      } catch {
        /* keepalive */
      }
    }
    const cut = buf.lastIndexOf('\n');
    if (cut >= 0) buf = buf.slice(cut + 1);
  }
  return { answer, events, ms: Date.now() - t0 };
}

{
  const r = await chatTurn('Прочитай вложенный файл и назови номер накладной и сумму. Ответь одной строкой.');
  if (r.error) fail('ответ модели', r.error);
  else {
    const hit = r.answer.includes(marker) || r.answer.includes('8 400') || r.answer.includes('8400');
    hit ? ok('модель прочитала файл', `${r.answer.trim().slice(0, 90)}… ${r.ms} мс`) : fail('модель не увидела файл', r.answer.slice(0, 160));
  }
}
{
  const { data } = await api(`/api/chats/${chatId}`);
  const n = data?.chat?.messages?.length || 0;
  n >= 2 ? ok('история диалога сохранена', `${n} сообщений`) : fail('история', n);
}
{
  const { res, data } = await api('/api/proofread', { method: 'POST', body: { text: 'привет как дела' } });
  res.ok && typeof data?.text === 'string' ? ok('проверка орфографии', JSON.stringify(data.text)) : fail('орфография', res.status + JSON.stringify(data));
}
{
  const wav = process.env.DSHOW_WAV;
  if (!wav || !fs.existsSync(wav)) {
    console.log('  --  голос: файл WAV не задан, пропуск');
  } else {
    const buf = fs.readFileSync(wav);
    const res = await fetch(BASE + '/api/transcribe', {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'audio/wav', 'X-Audio-Format': 'wav' },
      body: buf,
    });
    const data = await res.json().catch(() => null);
    if (res.ok && data?.text) ok('распознавание речи', `«${data.text}»`);
    else fail('распознавание речи', res.status + ' ' + JSON.stringify(data));
  }
}
{
  const res = await fetch(`${BASE}/api/projects/${projectId}/download`, { headers: { Cookie: cookie } });
  const buf = Buffer.from(await res.arrayBuffer());
  res.ok && buf.length > 100 && buf[0] === 0x50 ? ok('ZIP проекта', `${Math.round(buf.length / 1024)} КБ`) : fail('ZIP', res.status + ' ' + buf.length);
}

// 3. изоляция пользователей
let tempUser = '';
{
  const name = 'cloudcheck' + Date.now().toString().slice(-6);
  const { res, data } = await api('/api/admin/users', {
    method: 'POST',
    body: { username: name, password: 'Temp-pass-2026', displayName: 'Проверка' },
  });
  if (!res.ok) fail('создание пользователя', res.status + JSON.stringify(data));
  else {
    tempUser = data?.user?.id;
    ok('администратор создал пользователя', name);
  }
  if (tempUser) {
    const saved = cookie;
    cookie = '';
    const login = await api('/api/login', { method: 'POST', body: { username: name, password: 'Temp-pass-2026' } });
    if (!login.res.ok) fail('вход нового пользователя', login.res.status);
    else {
      ok('новый пользователь вошёл');
      const { data: boot } = await api('/api/bootstrap');
      /* Своё личное пространство новому человеку заводят при первом входе
         («Мой проект»). Чужого тестового проекта среди них быть не должно. */
      const seen = boot?.projects || [];
      const foreignSeen = seen.some((item) => item.id === projectId);
      seen.length === 1 && seen[0].name === 'Мой проект' && !foreignSeen
        ? ok('новый пользователь не видит чужие проекты')
        : fail('изоляция', `видит ${seen.length}: ${seen.map((item) => item.name).join(', ')}`);
      const foreign = await api(`/api/projects/${projectId}`);
      foreign.res.status === 404 ? ok('чужой проект недоступен') : fail('чужой проект', foreign.res.status);
    }
    cookie = saved;
    const del = await api(`/api/admin/users/${tempUser}`, { method: 'DELETE' });
    del.res.ok ? ok('временный пользователь удалён') : fail('удаление пользователя', del.res.status);
  }
}

// 4. уборка
{
  const del = await api(`/api/projects/${projectId}`, { method: 'DELETE' });
  del.res.ok ? ok('тестовый проект удалён') : fail('удаление проекта', del.res.status);
}

console.log(`\nИтого: ${log.filter((l) => l.trim().startsWith('ok')).length} ok, ${log.filter((l) => l.includes('FAIL')).length} fail`);
