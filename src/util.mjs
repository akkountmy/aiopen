import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export function uid(prefix = '') {
  const t = Date.now().toString(36);
  const r = crypto.randomBytes(5).toString('hex');
  return `${prefix}${t}${r}`;
}

export function nowIso() {
  return new Date().toISOString();
}

export function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function estimateTokens(text) {
  if (!text) return 0;
  const s = typeof text === 'string' ? text : JSON.stringify(text);
  // Кириллица в среднем ~2.4 символа на токен, латиница ~3.6. Берём с запасом.
  return Math.ceil(s.length / 2.7);
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function safeName(name, fallback = 'file') {
  const base = String(name || '').split(/[\\/]/).pop() || fallback;
  const cleaned = base
    .replace(/[\u0000-\u001f<>:"|?*]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.slice(0, 180) || fallback;
}

/* Свободное имя в папке: «отчёт.pdf», «отчёт (2).pdf», «отчёт (3).pdf»…
   Вложение из диалога и файл из панели лежат в одной общей папке проекта —
   одинаковые имена не должны затирать друг друга. */
export function uniqueFileName(dir, name) {
  const wanted = safeName(name);
  if (!fs.existsSync(path.join(dir, wanted))) return wanted;
  const parsed = path.parse(wanted);
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${parsed.name} (${index})${parsed.ext}`;
    if (!fs.existsSync(path.join(dir, candidate))) return candidate;
  }
  return `${parsed.name} ${Date.now()}${parsed.ext}`;
}

export function formatBytes(n) {
  if (!Number.isFinite(n) || n < 0) return '0 Б';
  const units = ['Б', 'КБ', 'МБ', 'ГБ'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

export function atomicWrite(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, content, 'utf8');
  try {
    fs.renameSync(tmp, file);
  } catch {
    fs.writeFileSync(file, content, 'utf8');
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
  }
}

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeJson(file, value) {
  atomicWrite(file, JSON.stringify(value, null, 2));
}

export function truncate(text, max) {
  const s = String(text ?? '');
  if (s.length <= max) return s;
  return `${s.slice(0, Math.max(0, max - 20))}\n…[сокращено ${s.length - max} симв.]`;
}

export function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function dayKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

export function stripAccents(value) {
  return String(value || '');
}

export function bool(value, fallback = false) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'boolean') return value;
  return value === 'true' || value === '1' || value === 1;
}
