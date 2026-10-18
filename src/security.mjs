import crypto from 'node:crypto';
import { DEVICE, DEVICE_KINDS, SECURITY, SESSION } from './config.mjs';
import { nowIso, sha256 } from './util.mjs';

const { N, r, p, keylen } = SECURITY.scrypt;

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, keylen, { N, r, p, maxmem: 64 * 1024 * 1024 });
  return {
    algo: 'scrypt',
    N,
    r,
    p,
    salt: salt.toString('base64'),
    hash: hash.toString('base64'),
  };
}

export function verifyPassword(password, record) {
  if (!record || record.algo !== 'scrypt') return false;
  try {
    const salt = Buffer.from(record.salt, 'base64');
    const expected = Buffer.from(record.hash, 'base64');
    const actual = crypto.scryptSync(String(password), salt, expected.length, {
      N: record.N,
      r: record.r,
      p: record.p,
      maxmem: 64 * 1024 * 1024,
    });
    return crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

export function newSessionToken() {
  return crypto.randomBytes(32).toString('base64url');
}

export function sessionKey(token) {
  return sha256(`dshow:${token}`);
}

export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const name = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (name) out[name] = decodeURIComponent(value);
  }
  return out;
}

export function sessionCookie(token, maxAgeMs = SESSION.ttlMs, secure = false) {
  const attrs = [
    `${SESSION.cookie}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
  ];
  if (secure) attrs.push('Secure');
  return attrs.join('; ');
}

export function clearSessionCookie(secure = false) {
  const attrs = [`${SESSION.cookie}=`, 'Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=0'];
  if (secure) attrs.push('Secure');
  return attrs.join('; ');
}

/* Метка устройства: долгоживущая cookie. По ней видно, что вход пришёл
   с той же самой машины, а не с новой (cookie переживает закрытие браузера). */
export function deviceCookie(value, maxAgeMs = DEVICE.cookieMs, secure = false) {
  const attrs = [
    `${DEVICE.cookie}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
  ];
  if (secure) attrs.push('Secure');
  return attrs.join('; ');
}

export function newDeviceId() {
  return crypto.randomBytes(12).toString('base64url');
}

/* Класс устройства: компьютер и телефон занимают разные «полки» сеансов,
   поэтому под одним аккаунтом можно работать и на ноутбуке, и на телефоне.
   Планшеты считаем телефоном: второго «наладонника» обычно не бывает.
   iPadOS 13+ присылает настольный User-Agent, поэтому смотрим ещё и на
   Client Hints (Chromium присылает Sec-CH-UA-Mobile сам, без запроса). */
const MOBILE_UA =
  /Android|iPhone|iPod|iPad|Tablet|Mobile|Windows Phone|IEMobile|Opera Mini|Opera Mobi|BlackBerry|BB10|PlayBook|Silk|Kindle|webOS/i;

export function deviceKind(ua, hints = {}) {
  const hint = String(hints.mobileHint || '').trim();
  if (hint === '?1') return 'mobile';
  if (MOBILE_UA.test(String(ua || ''))) return 'mobile';
  return 'desktop';
}

/* Класс уже сохранённого сеанса: старые сеансы (до разделения на классы)
   считаем компьютером — так телефон никогда не выбьет ноутбук. */
export function sessionKind(session) {
  const kind = String(session?.kind || '');
  return DEVICE_KINDS.includes(kind) ? kind : 'desktop';
}

export function deviceKindLabel(kind) {
  return kind === 'mobile' ? 'телефон' : 'компьютер';
}

export function passwordProblem(password) {
  const pwd = String(password ?? '');
  if (pwd.length < SECURITY.passwordMinLength) {
    return `Пароль должен быть не короче ${SECURITY.passwordMinLength} символов`;
  }
  if (pwd.length > 200) return 'Пароль слишком длинный';
  if (!/[A-Za-zА-Яа-я]/.test(pwd) || !/[0-9]/.test(pwd)) {
    return 'Пароль должен содержать буквы и цифры';
  }
  return '';
}

export function usernameProblem(username) {
  const name = String(username ?? '').trim();
  if (name.length < 3) return 'Логин должен быть не короче 3 символов';
  if (name.length > 32) return 'Логин слишком длинный';
  if (!/^[A-Za-z0-9._-]+$/.test(name)) return 'Логин может содержать только латиницу, цифры, точку, дефис и подчёркивание';
  return '';
}

export class RateLimiter {
  constructor({ windowMs, max }) {
    this.windowMs = windowMs;
    this.max = max;
    this.hits = new Map();
  }

  prune(now) {
    for (const [key, entry] of this.hits) {
      if (entry.resetAt <= now) this.hits.delete(key);
    }
  }

  check(key) {
    const now = Date.now();
    if (this.hits.size > 2000) this.prune(now);
    const entry = this.hits.get(key);
    if (!entry || entry.resetAt <= now) return { ok: true, remaining: this.max };
    if (entry.count >= this.max) {
      return { ok: false, retryAfterMs: entry.resetAt - now, remaining: 0 };
    }
    return { ok: true, remaining: this.max - entry.count };
  }

  hit(key) {
    const now = Date.now();
    const entry = this.hits.get(key);
    if (!entry || entry.resetAt <= now) {
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
    } else {
      entry.count += 1;
    }
  }

  reset(key) {
    this.hits.delete(key);
  }
}

export function timingSafeEqualString(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/* Выдаёт новый сеанс. Сеансы того же класса устройства закрываются лишние
   (по умолчанию — один компьютер и один телефон), поэтому работа с ноутбука и
   телефона идёт параллельно. Возвращает метку нового сеанса, его класс и список
   выбитых — по нему видно, не пользуются ли аккаунтом вдвоём. */
export function issueSession(store, userId, meta) {
  const token = newSessionToken();
  const key = sessionKey(token);
  const now = nowIso();
  const kind = DEVICE_KINDS.includes(meta?.kind) ? meta.kind : 'desktop';
  const displaced = store.dropOtherSessions(userId, key, { ip: meta?.ip, ua: meta?.ua, kind });
  store.state.sessions[key] = {
    userId,
    createdAt: now,
    exp: Date.now() + SESSION.ttlMs,
    ip: meta?.ip || '',
    ua: (meta?.ua || '').slice(0, 200),
    device: (meta?.device || '').slice(0, 80),
    kind,
  };
  store.pruneSessions();
  store.save();
  return { token, key, kind, displaced };
}
