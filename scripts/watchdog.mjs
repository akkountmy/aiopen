/**
 * Сторож доступности DSH OPEN WEB: раз в час проверяет облачный сервис.
 * Пишет в Telegram только при аварии и при восстановлении, в обычном режиме — молчит.
 * Запускается задачей планировщика «DSH OPEN WEB Watchdog» через watchdog-hide.vbs.
 */
import fs from 'node:fs';
import path from 'node:path';

const URL_HEALTH = process.env.DSH_WATCHDOG_URL || 'https://dshopen-vladimir00177.msk1.amvera.tech/api/health';
const SITE = new URL(URL_HEALTH).origin;
const HOME = 'D:\\DSHarness\\telegram';
const STATE_FILE = path.join(HOME, 'dshow-watchdog-state.json');
const LOG_FILE = path.join(HOME, 'dshow-watchdog.log');
const TIMEOUT_MS = 20000;
const RETRY_DELAY_MS = 25000;

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
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { ok: true, since: null, fails: 0 };
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
  } catch (error) {
    log(`telegram: не удалось отправить — ${error.message}`);
  }
}

async function probe() {
  const started = Date.now();
  try {
    const response = await fetch(`${URL_HEALTH}?t=${Date.now()}`, {
      headers: { 'user-agent': 'DSH-OPEN-WEB-watchdog/1.0' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await response.text();
    let ok = response.ok;
    /* сервис должен отвечать именно своим health-ом, а не страницей-заглушкой прокси */
    if (ok) {
      try {
        ok = JSON.parse(text).ok === true;
      } catch {
        ok = false;
      }
    }
    return { ok, status: response.status, elapsed: Date.now() - started, detail: text.slice(0, 120) };
  } catch (error) {
    const reason = error.name === 'TimeoutError' ? 'таймаут 20 с' : error.message;
    return { ok: false, status: 0, elapsed: Date.now() - started, detail: reason };
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const state = readState();
let result = await probe();
log(`проверка: ${result.ok ? 'ok' : 'СБОЙ'} (${result.status || 'нет ответа'}, ${result.elapsed} мс)`);

/* одна повторная попытка через 25 с: не будим человека из-за разового сбоя сети */
if (!result.ok) {
  await sleep(RETRY_DELAY_MS);
  const second = await probe();
  log(`повтор: ${second.ok ? 'ok' : 'СБОЙ'} (${second.status || 'нет ответа'}, ${second.elapsed} мс)`);
  result = { ...second, firstFailed: true };
}

const now = new Date().toISOString();
const wasDown = state.ok === false;

if (!result.ok) {
  state.fails = (state.fails || 0) + 1;
  /* тревога — сразу, пока сервис не вернулся; повторно не спамим */
  if (!wasDown) {
    await sendTelegram(
      [
        'DSH OPEN WEB не отвечает.',
        '',
        `Адрес: ${SITE}`,
        `Что именно: HTTP ${result.status || '—'}, ${result.detail}`,
        `Проверено: ${now} (две попытки с интервалом 25 с)`,
        '',
        'Загляну сам при следующей проверке через час: напишу, если сервис вернулся.',
      ].join('\n'),
    );
  }
  writeState({ ok: false, since: state.since || now, fails: state.fails, lastCheck: now });
} else {
  if (wasDown) {
    await sendTelegram(
      [
        'DSH OPEN WEB снова доступен.',
        '',
        `Адрес: ${SITE}`,
        `Простой с ${state.since || 'неизвестно'} по ${now} (проверки раз в час, мог быть короче).`,
      ].join('\n'),
    );
  }
  writeState({ ok: true, since: null, fails: 0, lastCheck: now });
}

log(`итог: ${result.ok ? 'сервис доступен' : 'авария'}`);
