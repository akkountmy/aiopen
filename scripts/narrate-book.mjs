/**
 * Прогон озвучки настоящей книги через HTTP предпросмотра: логин, план частей,
 * запуск, ожидание. Нужен как доказательство для задачи #19 — 178 страниц
 * превращаются в части MP3 и один Word.
 *
 * Запуск: node scripts/narrate-book.mjs [base]
 */

const BASE = (process.env.DSHOW_BASE || process.argv[2] || 'http://127.0.0.1:3300').replace(/\/$/, '');
const USER = 'DSH';
const PASS = process.env.DSHOW_PREVIEW_PASSWORD || 'озвучка-2026';
const PROJECT = 'p_mvqxx8b100c814af2d';
const DOC = 'Белорусский рынок лизинга 2025 — обзор.pdf';

let cookie = '';

async function call(path, { method = 'GET', body } = {}) {
  const init = { method, headers: {} };
  if (cookie) init.headers.cookie = cookie;
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const response = await fetch(`${BASE}${path}`, init);
  const setCookies = response.headers.getSetCookie ? response.headers.getSetCookie() : [];
  if (setCookies.length) cookie = setCookies.map((item) => item.split(';')[0]).join('; ');
  const type = response.headers.get('content-type') || '';
  const data = type.includes('application/json') ? await response.json() : await response.text();
  return { status: response.status, data };
}

const login = await call('/api/login', { method: 'POST', body: { username: USER, password: PASS } });
if (login.status !== 200) throw new Error(`логин: ${login.status} ${JSON.stringify(login.data).slice(0, 200)}`);
console.log('вход выполнен');

const plan = await call(`/api/projects/${PROJECT}/tts-plan?path=${encodeURIComponent(DOC)}`);
if (!plan.data.ok) throw new Error(`план: ${plan.data.reason}`);
console.log(
  `план: ${plan.data.chars.toLocaleString('ru-RU')} знаков ≈ ${Math.round(plan.data.minutes)} мин, ` +
    `частей ${plan.data.parts.length}, Word «${plan.data.word}»`,
);
for (const part of plan.data.parts) console.log(`  часть ${part.index}: ${Math.round(part.minutes)} мин`);

const started = await call(`/api/projects/${PROJECT}/tts`, { method: 'POST', body: { path: DOC, voice: 'ru-RU-SvetlanaNeural', rate: '1' } });
if (started.status !== 200) throw new Error(`запуск: ${started.status} ${JSON.stringify(started.data).slice(0, 300)}`);
const jobId = started.data.job.id;
console.log(`задание ${jobId}, Word «${started.data.plan.word.name}»`);

const begin = Date.now();
let lastLine = '';
for (;;) {
  const { data } = await call(`/api/tts/jobs/${jobId}`);
  const job = data.job;
  const line = `${job.status} ${job.percent}% · ${job.stage} · частей ${job.files.length}/${job.parts.length}`;
  if (line !== lastLine) {
    console.log(`[${Math.round((Date.now() - begin) / 1000)} с] ${line}`);
    lastLine = line;
  }
  if (job.status === 'done') {
    for (const file of job.files) console.log(`  ✓ ${file.name} — ${file.duration}, ${Math.round(file.size / 1024)} КБ`);
    console.log(`готово за ${Math.round((Date.now() - begin) / 60)} мин`);
    break;
  }
  if (job.status === 'failed' || job.status === 'cancelled') throw new Error(`${job.status}: ${job.error}`);
  await new Promise((resolve) => setTimeout(resolve, 5000));
}
