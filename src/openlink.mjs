/**
 * Короткие ссылки на файлы проекта для внешних приложений.
 *
 * Word/Excel/PowerPoint открывают файл по протоколу ms-word / ms-excel /
 * ms-powerpoint: приложение скачивает документ само, без cookie браузера и без
 * заголовков сессии. Поэтому на файл выдаётся одноразовая ссылка с подписью и
 * небольшим сроком жизни; постоянный адрес файла и сессия наружу не попадают.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.mjs';
import { atomicWrite } from './util.mjs';

const SECRET_FILE = path.join(DATA_DIR, 'open-links.key');
const DEFAULT_TTL_MS = 10 * 60 * 1000;
let cachedSecret = null;

function secret() {
  if (cachedSecret) return cachedSecret;
  try {
    const raw = fs.readFileSync(SECRET_FILE);
    if (raw.length >= 32) {
      cachedSecret = raw;
      return cachedSecret;
    }
  } catch {
    /* ключа ещё нет — создадим ниже */
  }
  cachedSecret = crypto.randomBytes(32);
  try {
    atomicWrite(SECRET_FILE, cachedSecret.toString('hex'));
  } catch {
    /* если диск только для чтения, подпись будет жить до перезапуска */
  }
  return cachedSecret;
}

function sign(body) {
  return crypto.createHmac('sha256', secret()).update(body).digest('base64url');
}

export function makeOpenToken({ projectId, relPath, ttlMs = DEFAULT_TTL_MS }) {
  const payload = { p: String(projectId), f: String(relPath), e: Date.now() + ttlMs };
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${body}.${sign(body)}`;
}

/** Возвращает { projectId, relPath } или null, если ссылка битая/просроченная. */
export function readOpenToken(token) {
  const [body, signature] = String(token || '').split('.');
  if (!body || !signature) return null;
  const expected = Buffer.from(sign(body));
  const given = Buffer.from(signature);
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!payload || typeof payload.p !== 'string' || typeof payload.f !== 'string') return null;
  if (!Number.isFinite(payload.e) || payload.e < Date.now()) return null;
  return { projectId: payload.p, relPath: payload.f };
}
