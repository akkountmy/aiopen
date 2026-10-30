/**
 * Obscura — движок браузера для сайтов, которые не отдаются обычной загрузке.
 *
 * Зачем: половина отказов в ресёрче — не «сайт лежит», а анти-бот. Обычный
 * HTTP-запрос получает заглушку («проверка браузера», `fab_chlg`, Cloudflare),
 * SPA отдаёт пустой скелет, а сервер видит отпечаток TLS и режет запрос.
 * Obscura (h4ckf0r0day/obscura, Rust, Apache-2.0) — браузер с настоящим V8,
 * stealth-отпечатком и блокировкой трекеров; весит десятки мегабайт вместо
 * гигабайта Chromium и запускается без системных библиотек.
 *
 * Здесь движок не замена Playwright, а запасной путь: `render: true` остаётся
 * для интерактива и скриншотов, obscura включается, когда страница пришла
 * заглушкой или пустой. Бинарник скачивается один раз в DATA_DIR (в облаке это
 * постоянный том /data) и проверяется по SHA-256.
 *
 * Выключить: DSHOW_OBSCURA=off. Свой бинарник: OBSCURA_BIN=/путь/obscura.
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import zlib from 'node:zlib';
import { DATA_DIR, ROOT } from './config.mjs';

const VERSION = '0.2.5';
const RELEASE_FILE = `obscura-x86_64-linux-stealth.tar.gz`;
const RELEASE_URL = `https://github.com/h4ckf0r0day/obscura/releases/download/v${VERSION}/${RELEASE_FILE}`;
const RELEASE_BYTES = 74936793;
const RELEASE_SHA256 = process.env.DSHOW_OBSCURA_SHA256 || 'd9175cf7573d0243fc303a6f1a3b68affc757af0b5549cacb018e9670988316c';
const INSTALL_DIR = path.join(DATA_DIR, 'vendor', `obscura-${VERSION}`);
const INSTALLED_BIN = path.join(INSTALL_DIR, 'obscura');

/** Пределы, чтобы один «браузер» не съел память процесса. */
const LIMITS = { pageBytes: 12_000_000, stdoutBytes: 16_000_000, timeoutMs: 40_000 };

/** Признаки заглушки анти-бота: их видно в тексте, а не в статусе. */
const CHALLENGE_MARKERS = [
  'нужна небольшая проверка браузера',
  'проверка пройдена',
  'подтвердите, что вы не робот',
  'доступ ограничен',
  'доступ запрещ',
  'пожалуйста, включите javascript',
  'включите javascript',
  'just a moment',
  'attention required',
  'checking your browser',
  'verify you are human',
  'are you a robot',
  'antibot challenge',
  'challenge page',
  'ddos protection',
  'enable javascript and cookies to continue',
  'captcha',
  'cf_chl',
  'challenge-platform',
  'fab_chlg',
  'ddos-guard',
  'request blocked',
  'access denied',
  'слишком много запросов',
  'проблем с ip',
  'обновить страницу',
];

let installPromise = null;
let cachedBinary;

function flagOff() {
  const value = String(process.env.DSHOW_OBSCURA || '').trim().toLowerCase();
  return value === 'off' || value === '0' || value === 'false';
}

function platformSupported() {
  return process.platform === 'linux' && process.arch === 'x64';
}

/** Кандидаты по убыванию приоритета: свой бинарник, установленный, в образе. */
function candidates() {
  const list = [];
  const own = String(process.env.OBSCURA_BIN || '').trim();
  if (own) list.push(own);
  list.push(INSTALLED_BIN, path.join(DATA_DIR, 'vendor', 'obscura', 'obscura'), path.join(ROOT, 'vendor', 'obscura', 'obscura'));
  return list;
}

function isExecutable(file) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size < 1_000_000) return false;
    if (process.platform !== 'win32') fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Готов ли движок прямо сейчас (без скачивания). */
export function obscuraPath() {
  if (flagOff()) return null;
  if (cachedBinary && isExecutable(cachedBinary)) return cachedBinary;
  for (const file of candidates()) {
    if (isExecutable(file)) {
      cachedBinary = file;
      return file;
    }
  }
  return null;
}

export function obscuraConfigured() {
  return !flagOff() && Boolean(obscuraPath() || platformSupported());
}

export function looksLikeChallenge(text) {
  const low = String(text || '').toLowerCase();
  if (!low) return false;
  const head = low.slice(0, 4000);
  return CHALLENGE_MARKERS.some((marker) => head.includes(marker));
}

/** Скачивает и распаковывает бинарник; повторные вызовы ждут один и тот же. */
async function installBinary() {
  if (!platformSupported() && !String(process.env.OBSCURA_BIN || '').trim()) {
    throw new Error('Obscura доступна только для linux-x64; задайте OBSCURA_BIN или положите бинарник в vendor/obscura');
  }
  fs.mkdirSync(INSTALL_DIR, { recursive: true });
  const response = await fetch(RELEASE_URL, { redirect: 'follow' });
  if (!response.ok) throw new Error(`Obscura не скачивается: HTTP ${response.status}`);
  const archive = Buffer.from(await response.arrayBuffer());
  if (archive.length !== RELEASE_BYTES) {
    throw new Error(`Obscura: неверный размер архива (${archive.length} вместо ${RELEASE_BYTES})`);
  }
  const digest = crypto.createHash('sha256').update(archive).digest('hex');
  if (RELEASE_SHA256 && digest !== RELEASE_SHA256) {
    throw new Error('Obscura: контрольная сумма архива не совпала');
  }
  const staging = `${INSTALL_DIR}.tmp-${process.pid}-${Date.now()}`;
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  try {
    await extractTarStream(Readable.from([archive]).pipe(zlib.createGunzip()), staging);
    const root = findObscuraRoot(staging);
    if (!root) throw new Error('Obscura: в архиве нет бинарника');
    fs.chmodSync(root, 0o755);
    fs.rmSync(INSTALL_DIR, { recursive: true, force: true });
    fs.renameSync(staging, INSTALL_DIR);
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw error;
  }
  clearCache();
  const installed = obscuraPath();
  if (!installed) throw new Error('Obscura установлена, но не запускается');
  return installed;
}

function clearCache() {
  cachedBinary = undefined;
}

export function ensureObscura() {
  const ready = obscuraPath();
  if (ready) return Promise.resolve(ready);
  if (!installPromise) {
    installPromise = installBinary().finally(() => {
      installPromise = null;
    });
  }
  return installPromise;
}

function findObscuraRoot(dir) {
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.name === 'obscura') return full;
    }
  }
  return null;
}

/**
 * Разбор tar-потока (ustar, pax, GNU long name) с записью файлов по мере чтения.
 * Свой, потому что в облачном образе может не быть `tar`, а тянуть npm-зависимость
 * ради одного архива незачем. Поток — чтобы не держать в памяти распакованные
 * 164 МБ бинарников.
 */
export async function extractTarStream(source, destDir) {
  const root = path.resolve(destDir);
  fs.mkdirSync(root, { recursive: true });
  let rest = Buffer.alloc(0);
  let longName = '';

  const safeTarget = (name) => {
    const safe = String(name || '').replace(/^\.\//, '').replace(/^\/+/, '');
    if (!safe || safe.split('/').includes('..')) return '';
    const full = path.resolve(root, safe);
    if (full !== root && !full.startsWith(root + path.sep)) return '';
    return full;
  };

  for await (const chunk of source) {
    rest = rest.length ? Buffer.concat([rest, chunk]) : chunk;
    let offset = 0;
    while (rest.length - offset >= 512) {
      const header = rest.subarray(offset, offset + 512);
      if (header[0] === 0) {
        /* После первого нулевого блока начинаются пустые: архив закончился. */
        offset = rest.length;
        break;
      }
      const rawName = cString(header.subarray(0, 100));
      const prefix = cString(header.subarray(345, 500));
      const sizeField = header
        .subarray(124, 136)
        .toString('utf8')
        .replace(/\0/g, ' ')
        .trim();
      const size = /^[0-7]+$/.test(sizeField) ? parseInt(sizeField, 8) : 0;
      const type = String.fromCharCode(header[156] || 48);
      const total = 512 + Math.ceil(size / 512) * 512;
      if (rest.length - offset < total) break;
      const data = rest.subarray(offset + 512, offset + 512 + size);
      offset += total;
      if (type === 'x' || type === 'X') {
        for (const record of parsePax(data.toString('utf8'))) {
          if (record.path) longName = record.path;
        }
        continue;
      }
      if (type === 'L') {
        longName = data.toString('utf8').replace(/\0+$/, '');
        continue;
      }
      if (type === 'g' || type === 'K') continue;
      const full = safeTarget(longName || (prefix ? `${prefix}/${rawName}` : rawName));
      longName = '';
      if (!full) continue;
      if (type === '5') {
        fs.mkdirSync(full, { recursive: true });
        continue;
      }
      /* Обычный файл; симлинки и хардлинки не нужны — тарбол кладёт файлы рядом. */
      if (type !== '0' && type !== '\0' && type !== '7') continue;
      fs.mkdirSync(path.dirname(full), { recursive: true });
      await fs.promises.writeFile(full, Buffer.from(data));
      if (process.platform !== 'win32') fs.chmodSync(full, 0o755);
    }
    rest = rest.subarray(offset);
  }
}

/** Тот же разбор для готового gzip-буфера: удобно в тестах. */
export function extractTarGz(archive, destDir) {
  return extractTarStream(Readable.from([zlib.gunzipSync(archive)]), destDir);
}

function parsePax(text) {
  const records = [];
  let index = 0;
  while (index < text.length) {
    const space = text.indexOf(' ', index);
    if (space < 0) break;
    const length = Number.parseInt(text.slice(index, space), 10);
    if (!Number.isFinite(length) || length <= 0) break;
    const record = text.slice(space + 1, index + length - 1);
    const eq = record.indexOf('=');
    if (eq > 0) {
      const key = record.slice(0, eq);
      const value = record.slice(eq + 1);
      records.push(key === 'path' ? { path: value } : { [key]: value });
    }
    index += length;
  }
  return records;
}

function cString(bytes) {
  const text = Buffer.from(bytes).toString('utf8');
  const zero = text.indexOf('\0');
  return zero >= 0 ? text.slice(0, zero) : text;
}

function run(binary, args, timeoutMs) {
  return new Promise((resolve) => {
    const started = Date.now();
    let child;
    try {
      child = spawn(binary, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      resolve({ ok: false, error: String(error?.message || error), stdout: '', stderr: '', elapsedMs: 0 });
      return;
    }
    const out = [];
    const err = [];
    let size = 0;
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      try {
        child.kill('SIGKILL');
      } catch {
        /* процесс уже завершился */
      }
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      size += chunk.length;
      if (size > LIMITS.stdoutBytes) {
        killed = true;
        try {
          child.kill('SIGKILL');
        } catch {
          /* уже завершился */
        }
        return;
      }
      out.push(chunk);
    });
    child.stderr.on('data', (chunk) => {
      if (err.length < 40) err.push(chunk);
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ ok: false, error: String(error?.message || error), stdout: '', stderr: '', elapsedMs: Date.now() - started });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(out).toString('utf8');
      const stderr = Buffer.concat(err).toString('utf8');
      resolve({
        ok: code === 0 && !killed && stdout.length > 0,
        exitCode: code,
        killed,
        stdout,
        stderr,
        elapsedMs: Date.now() - started,
        error: code === 0 && !killed ? '' : firstLine(stderr) || `obscura завершился с кодом ${code}`,
      });
    });
  });
}

function firstLine(text) {
  const clean = String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('[INFO]') && !line.startsWith('[WARN]'));
  return (clean[0] || '').slice(0, 300);
}

/**
 * Загружает страницу obscura и возвращает HTML после JavaScript.
 * Именно HTML: из него штатный разбор search.mjs достаёт заголовки, таблицы и
 * ссылки, поэтому путь «обычная загрузка» и «stealth-загрузка» дают одинаковый
 * результат — отличается только движок.
 */
export async function obscuraLoad(rawUrl, { timeoutMs = 30_000, waitMs = 0, waitUntil = '', proxy = '', format = 'html', stealth = true } = {}) {
  const binary = await ensureObscura();
  const args = ['fetch', String(rawUrl), '--quiet', '--timeout', String(Math.max(5, Math.round(timeoutMs / 1000)))];
  args.push('--dump', format === 'markdown' ? 'markdown' : 'html');
  if (waitUntil) args.push('--wait-until', waitUntil);
  if (waitMs > 0) args.push('--wait', String(Math.min(20, Math.max(1, Math.round(waitMs / 1000)))));
  if (stealth) args.push('--stealth');
  if (proxy) args.push('--proxy', String(proxy));
  const result = await run(binary, args, Math.max(LIMITS.timeoutMs, timeoutMs + 20_000));
  if (!result.ok) {
    const error = new Error(result.error || 'Obscura не отдал страницу');
    error.engine = 'obscura';
    throw error;
  }
  const body = result.stdout.replace(/^\[(INFO|WARN|DEBUG|TRACE)\].*$/gm, '').trim();
  if (!body) throw new Error('Obscura вернул пустую страницу');
  if (body.length > LIMITS.pageBytes) throw new Error('Страница слишком большая для разбора (больше 12 МБ)');
  return {
    kind: 'html',
    text: format === 'markdown' ? body : body,
    url: String(rawUrl),
    status: 200,
    engine: 'obscura',
    challenge: looksLikeChallenge(body),
    elapsedMs: result.elapsedMs,
  };
}

/** Короткий статус движка для интерфейса и подсказок в ответе инструмента. */
export function obscuraInfo() {
  const binary = obscuraPath();
  return {
    enabled: !flagOff(),
    ready: Boolean(binary),
    binary: binary || '',
    version: VERSION,
    supportedPlatform: platformSupported(),
    installDir: INSTALL_DIR,
    source: RELEASE_URL,
    sizeBytes: RELEASE_BYTES,
  };
}
