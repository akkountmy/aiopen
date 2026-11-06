// Внешний сторож сервиса в облаке: замечает молчание и перезапускает проект.
//
// Зачем он нужен. 4 ноября сервис трижды переставал отвечать на всё: контейнер
// жив, статус RUNNING, а /api/health молчит и через двадцать минут. Проверено
// на живом облаке: платформа НЕ поднимает контейнер после SIGKILL, поэтому
// изнутри процесса такую аварию закрыть нечем — ни мягким, ни жёстким сторожем.
// Единственный работающий способ — увидеть молчание снаружи и вызвать
// restartProject.
//
//   node scripts/health-guard.mjs              один прогон: проверить и, если надо, перезапустить
//   node scripts/health-guard.mjs --watch      крутиться постоянно (по умолчанию раз в 5 минут)
//   node scripts/health-guard.mjs --dry-run    только проверить, ничего не перезапускать
//   node scripts/health-guard.mjs --cooldown=900  не перезапускать чаще, чем раз в 15 минут
//
// Токен MCP обновляется сам: health-guard.mjs вызывает scripts/amvera-login.mjs,
// если сохранённый токен протух. Учётные данные берутся из хранилища DSH
// (C:\Users\33620\.dsh\secrets), в журнал не печатаются.
//
// Расписание: раз в 5 минут через Планировщик задач Windows —
//   schtasks /Create /TN "DSH Open Web health guard" /SC MINUTE /MO 5 /F ^
//     /TR "cmd /c cd /d D:\DSHarness-0.1\DSH.OPEN.WEB && node scripts/health-guard.mjs >> .health-guard.log 2>&1"
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const TOKEN_FILE = path.join(os.tmpdir(), 'amvera-token.json');
const STATE_FILE = path.join(root, '.health-guard-state.json');

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const found = args.find((a) => a.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : fallback;
};
const has = (name) => args.includes(`--${name}`);

const BASE = flag('base', process.env.DSHOW_BASE_URL || 'https://dshopen-vladimir00177.msk1.amvera.tech');
const SLUG = flag('slug', process.env.DSHOW_SLUG || 'dshopen');
const TIMEOUT_MS = Number(flag('timeout', '15000'));
const COOLDOWN_MS = Number(flag('cooldown', '900')) * 1000;
const INTERVAL_MS = Number(flag('interval', '300')) * 1000;
const DRY = has('dry-run');
const WATCH = has('watch');
const LOG_FILE = flag('log', path.join(root, '.health-guard.log'));

function note(line) {
  const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const text = `[${stamp}] ${line}`;
  console.log(text);
  try {
    fs.appendFileSync(LOG_FILE, `${text}\n`, 'utf8');
  } catch {
    /* журнал не обязателен */
  }
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { restarts: 0, lastRestartAt: null };
  }
}

function writeState(state) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
  } catch {
    /* состояние можно не сохранить — это не повод падать */
  }
}

async function probe() {
  const started = Date.now();
  try {
    const res = await fetch(`${BASE}/api/health`, {
      headers: { 'user-agent': 'DSH-OPEN-WEB-guard/1.0', 'x-dshow-service': '1' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await res.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    return { ok: res.ok && Boolean(body?.ok), status: res.status, body, ms: Date.now() - started };
  } catch (error) {
    return { ok: false, status: 0, error: String(error?.message || error), ms: Date.now() - started };
  }
}

/* Проверка двумя попытками: одиночный таймаут бывает холодным стартом после
   пересборки, и перезапускать из-за него живой сервис нельзя. */
async function isAlive() {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const result = await probe();
    if (result.ok) {
      note(`жив: code=${result.status} за ${result.ms} мс, прогонов ${result.body?.load?.runs?.active ?? '?'}`);
      return true;
    }
    note(`попытка ${attempt}: нет ответа (${result.error || `code=${result.status}`})`);
    if (attempt === 1) await new Promise((r) => setTimeout(r, 20000));
  }
  return false;
}

function tokenAlive() {
  try {
    const data = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
    if (!data.access_token) return false;
    const stat = fs.statSync(TOKEN_FILE);
    const ageMs = Date.now() - stat.mtimeMs;
    return ageMs < 25 * 60 * 1000;
  } catch {
    return false;
  }
}

function runNode(script, scriptArgs = []) {
  return new Promise((resolve) => {
    execFile(process.execPath, [path.join(root, 'scripts', script), ...scriptArgs], { cwd: root, timeout: 120000 }, (error, stdout, stderr) => {
      resolve({ error, stdout: String(stdout || '').trim(), stderr: String(stderr || '').trim() });
    });
  });
}

async function restart() {
  if (DRY) {
    note('--dry-run: перезапуск не выполнялся');
    return false;
  }
  if (!tokenAlive()) {
    const login = await runNode('amvera-login.mjs');
    if (login.error) {
      note(`не удалось обновить токен: ${(login.stderr || login.error.message).slice(0, 200)}`);
      return false;
    }
    note('токен MCP обновлён');
  }
  const call = await runNode('amvera-mcp.mjs', ['call', 'restartProject', JSON.stringify({ slug: SLUG })]);
  const text = `${call.stdout}${call.stderr}`;
  if (call.error || /ERROR|isError/i.test(text)) {
    note(`перезапуск не удался: ${text.replace(/\s+/g, ' ').slice(0, 200)}`);
    return false;
  }
  note(`проект ${SLUG} перезапущен — ждём подъёма`);
  return true;
}

async function tick() {
  if (await isAlive()) return;
  const state = readState();
  const sinceLast = state.lastRestartAt ? Date.now() - new Date(state.lastRestartAt).getTime() : Infinity;
  if (sinceLast < COOLDOWN_MS) {
    note(`сервис молчит, но перезапуск был ${Math.round(sinceLast / 1000)} с назад — ждём (остывание ${Math.round(COOLDOWN_MS / 1000)} с)`);
    return;
  }
  note('сервис не отвечает на /api/health — перезапускаю проект');
  const done = await restart();
  if (!done) return;
  writeState({ restarts: (state.restarts || 0) + 1, lastRestartAt: new Date().toISOString() });
  /* Ждём подъёма и докладываем результат в тот же журнал: человек должен
     видеть, что перезапуск помог, а не только что он был. */
  for (let attempt = 1; attempt <= 12; attempt += 1) {
    await new Promise((r) => setTimeout(r, 20000));
    const result = await probe();
    if (result.ok) {
      note(`поднялся через ~${attempt * 20} с: code=${result.status}`);
      return;
    }
  }
  note('за 4 минуты не поднялся — нужен человек');
}

if (WATCH) {
  note(`сторож запущен: ${BASE}, интервал ${Math.round(INTERVAL_MS / 1000)} с, остывание ${Math.round(COOLDOWN_MS / 1000)} с${DRY ? ', режим проверки' : ''}`);
  for (;;) {
    try {
      await tick();
    } catch (error) {
      note(`сбой проверки: ${String(error?.message || error)}`);
    }
    await new Promise((r) => setTimeout(r, INTERVAL_MS));
  }
} else {
  await tick();
}
