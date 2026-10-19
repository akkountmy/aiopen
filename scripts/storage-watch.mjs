/**
 * Сторож места DSH OPEN WEB: раз в неделю спрашивает у облачного сервиса, сколько
 * занято на диске тарифа, и пишет в Telegram при заполнении выше порога (70%).
 *
 * Запускается задачей планировщика «DSH OPEN WEB Storage Watch» через
 * dshow-storage-hide.vbs → storage-watch.ps1 (пароль администратора берётся
 * из хранилища и в журнал не попадает).
 */
import fs from 'node:fs';
import path from 'node:path';

const BASE = (process.env.DSHOW_BASE || 'https://dshopen-vladimir00177.msk1.amvera.tech').replace(/\/+$/, '');
const HOME = 'D:\\DSHarness\\telegram';
const STATE_FILE = path.join(HOME, 'dshow-storage-state.json');
const LOG_FILE = path.join(HOME, 'dshow-storage.log');
const THRESHOLD_PCT = Number(process.env.DSHOW_STORAGE_ALERT_PCT || 70);
const REMIND_DAYS = Number(process.env.DSHOW_STORAGE_REMIND_DAYS || 28);
const FORCE_ALERT = process.env.DSHOW_STORAGE_FORCE_ALERT === '1';
const TIMEOUT_MS = 30000;
const USER = process.env.DSHOW_USER || 'DSHOPENWEB';
const PASS = process.env.DSHOW_PASS || '';

const GB = 1024 ** 3;
const MB = 1024 ** 2;

function stamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function log(line) {
  const text = `${stamp()} ${line}\n`;
  try {
    /* BOM при создании: иначе блокнот и PowerShell читают кириллицу как мусор */
    if (!fs.existsSync(LOG_FILE)) fs.writeFileSync(LOG_FILE, '\uFEFF');
    fs.appendFileSync(LOG_FILE, text);
    /* журнал не должен расти бесконечно: держим последние ~200 КБ */
    if (fs.statSync(LOG_FILE).size > 200 * 1024) {
      const rows = fs.readFileSync(LOG_FILE, 'utf8').split('\n').slice(-1500);
      const body = rows.join('\n');
      fs.writeFileSync(LOG_FILE, body.startsWith('\uFEFF') ? body : '\uFEFF' + body);
    }
  } catch {
    /* журнал не критичен */
  }
  process.stdout.write(text);
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return { alert: false, pct: null, lastAlertAt: null, failStreak: 0 };
  }
}

function writeState(state) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 1));
  } catch {
    /* состояние не критично */
  }
}

function botConfig() {
  const raw = fs.readFileSync(path.join(HOME, 'bot-config.json'), 'utf8').replace(/^\uFEFF/, '');
  const config = JSON.parse(raw);
  const chat = (config.allowedIds && config.allowedIds[0]) || 660339011;
  if (!config.token) throw new Error('в bot-config.json нет токена');
  return { token: config.token, chat };
}

async function sendTelegram(text) {
  try {
    const { token, chat } = botConfig();
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }),
    });
    const data = await response.json();
    if (!data.ok) throw new Error(data.description || 'Telegram отказал');
    log(`telegram: отправлено (message_id ${data.result.message_id})`);
    return true;
  } catch (error) {
    log(`telegram: не удалось отправить — ${error.message}`);
    return false;
  }
}

const size = (bytes) => {
  const n = Number(bytes) || 0;
  if (n >= GB) return `${(n / GB).toFixed(1).replace('.', ',')} ГБ`;
  if (n >= MB) return `${(n / MB).toFixed(1).replace('.', ',')} МБ`;
  return `${Math.round(n / 1024)} КБ`;
};

const PLAN_BY_GB = { 2: 'Пробный', 5: 'Начальный', 7: 'Начальный Плюс', 15: 'Стандартный', 25: 'Ультра', 35: 'Ультра Плюс' };

const jar = new Map();
function cookieHeader() {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

async function call(pathname, options = {}) {
  const response = await fetch(BASE + pathname, {
    ...options,
    headers: {
      'content-type': 'application/json',
      'user-agent': 'DSH-OPEN-WEB-storage-watch/1.0',
      ...(jar.size ? { cookie: cookieHeader() } : {}),
      ...(options.headers || {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  for (const entry of response.headers.getSetCookie?.() || []) {
    const [pair] = entry.split(';');
    const idx = pair.indexOf('=');
    if (idx > 0) jar.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
  }
  return { status: response.status, data: await response.json().catch(() => null) };
}

/* ---------- проверка ---------- */

const state = readState();
const nowIso = new Date().toISOString();

async function tell(lines, kind) {
  const sent = await sendTelegram(lines.join('\n'));
  if (sent) log(`telegram: ${kind}`);
  return sent;
}

if (!PASS) {
  log('нет пароля администратора (DSHOW_PASS) — проверка не запускалась');
  await tell(
    ['DSH OPEN WEB: проверка места не запустилась.', '', 'Нет пароля администратора в окружении задачи.', `Время: ${nowIso}`],
    'тревога: нет пароля',
  );
  process.exit(1);
}

let report = null;
let failure = null;
try {
  const login = await call('/api/login', { method: 'POST', body: { username: USER, password: PASS } });
  if (login.status !== 200 || !login.data?.user) {
    failure = `вход не удался (HTTP ${login.status})`;
  } else if (login.data.user.role !== 'admin') {
    failure = 'учётная запись не администратор';
  } else {
    const storage = await call('/api/admin/storage');
    if (storage.status !== 200 || !storage.data) {
      failure = `ответ /api/admin/storage — HTTP ${storage.status}`;
    } else if (!storage.data.plan) {
      failure = 'сервис отвечает старой версией — нет данных о тарифе';
    } else {
      report = storage.data;
    }
  }
} catch (error) {
  failure = error.name === 'TimeoutError' ? 'сервис не ответил за 30 с' : error.message;
}

if (failure) {
  log(`проверка не удалась: ${failure}`);
  writeState({ ...state, failStreak: (state.failStreak || 0) + 1, lastCheck: nowIso });
  await tell(
    [
      'DSH OPEN WEB: не смог проверить занятое место.',
      '',
      `Адрес: ${BASE}`,
      `Причина: ${failure}`,
      `Время: ${nowIso}`,
      '',
      'Проверки идут раз в неделю, следующая — через неделю.',
    ],
    'тревога: проверка не удалась',
  );
  process.exit(1);
}

const capBytes = Number(report.plan?.capBytes) || null;
const usedBytes = Number(report.data?.totalBytes) || 0;
const pct = capBytes ? Number(((usedBytes / capBytes) * 100).toFixed(2)) : null;
const capGb = capBytes ? Math.round(capBytes / GB) : null;
const planName = capGb ? PLAN_BY_GB[capGb] || `тариф ${capGb} ГБ` : 'тариф неизвестен';
const parts = report.data?.parts || {};
const overview = report.overview || {};
const top = Object.entries(parts)
  .filter(([key]) => key !== 'index')
  .sort((a, b) => b[1] - a[1])
  .slice(0, 3)
  .map(([key, bytes]) => {
    const label =
      { workspaces: 'файлы проектов', uploads: 'вложения', chats: 'диалоги', logs: 'журналы', other: 'прочее', index: 'состояние' }[key] || key;
    return `${label} — ${size(bytes)}`;
  });

log(
  pct === null
    ? `проверка: потолок тарифа неизвестен, данные сервиса ${size(usedBytes)}`
    : `проверка: занято ${pct}% тарифа (${size(usedBytes)} из ${size(capBytes)}), ${planName}`,
);

if (pct === null) {
  writeState({ ...state, failStreak: 0, lastCheck: nowIso, pct: null });
  await tell(
    [
      'DSH OPEN WEB: не смог определить потолок места по тарифу.',
      '',
      `Сервис ответил без размера диска (${BASE}).`,
      `Данные сервиса сейчас: ${size(usedBytes)}`,
      `Лимит памяти контейнера: ${report.plan?.memoryBytes ? size(report.plan.memoryBytes) : 'неизвестен'}`,
      `Время: ${nowIso}`,
      '',
      'Скажи, какой у сервиса тариф (или сколько ГБ диска), — впишу его вручную.',
    ],
    'тревога: потолок неизвестен',
  );
  process.exit(1);
}

const above = FORCE_ALERT || pct >= THRESHOLD_PCT;
const lastAlertAt = state.lastAlertAt ? new Date(state.lastAlertAt).getTime() : 0;
const remind = above && (!state.alert || Date.now() - lastAlertAt >= REMIND_DAYS * 24 * 60 * 60 * 1000);

if (remind) {
  const head = FORCE_ALERT
    ? `Проверка связи: сторож места работает, порог — ${THRESHOLD_PCT}%.`
    : `Место на сервере DSH OPEN WEB занято на ${String(pct).replace('.', ',')}% — это выше порога ${THRESHOLD_PCT}%.`;
  const lines = [
    head,
    '',
    `Данные сервиса: ${size(usedBytes)} из ${size(capBytes)} (${planName})`,
    top.length ? top.join(' · ') : 'данных пока нет',
    `Учётные записи: ${overview.users ?? '—'} · проекты: ${overview.projects ?? '—'} · диалоги: ${overview.chats ?? '—'}`,
    `Проверка: ${stamp()} (раз в неделю)`,
    '',
    'Что делать: удалить ненужные файлы в проектах или перейти на тариф с большим диском. ' +
      `Отдельно про запас узла: сервис перестанет принимать файлы, когда на диске останется меньше ${size(report.reserveBytes)}.`,
  ];
  const sent = await tell(lines, above && !FORCE_ALERT ? 'тревога: место выше порога' : 'проверка связи');
  if (sent) {
    state.alert = above;
    state.lastAlertAt = nowIso;
  }
} else if (!above && state.alert) {
  await tell(
    [
      `Место на сервере DSH OPEN WEB вернулось в норму: ${String(pct).replace('.', ',')}%.`,
      '',
      `Данные сервиса: ${size(usedBytes)} из ${size(capBytes)} (${planName})`,
      `Порог тревоги — ${THRESHOLD_PCT}%. Проверка: ${stamp()}.`,
    ],
    'место вернулось в норму',
  );
  state.alert = false;
}

writeState({
  alert: above,
  pct,
  capBytes,
  planName,
  lastAlertAt: state.lastAlertAt || null,
  lastCheck: nowIso,
  failStreak: 0,
});

log(above ? `итог: ${pct}% — выше порога ${THRESHOLD_PCT}%` : `итог: ${pct}% — в норме`);
