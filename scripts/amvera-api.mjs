// Прямой REST-клиент Amvera (регион msk1) — без MCP.
//
// Почему так: MCP-шлюз openmcp.msk0/msk1 перестал отвечать (TCP открыт, TLS не
// поднимается), а сам региональный API жив и работает с обычным токеном Keycloak.
// Пути взяты из фронтенда кабинета: работа с файлами проекта идёт не через
// /projects, а через git-API платформы.
//
//   GET  /projects/{slug}                            — карточка проекта
//   POST /projects/{slug}/rebuild                    — пересборка (redeploy)
//   POST /projects/{slug}/restart                    — перезапуск без сборки
//   GET  /git/{slug}/files?branch&path               — список файлов (дерево)
//   GET  /git/{slug}/file?branch&filename            — содержимое файла
//   GET  /git/{slug}/log?branch&page&size            — история коммитов
//   POST /git/{slug}/files                           — загрузка файлов (multipart)
//
// Загрузка — multipart с полями: files (несколько частей, имя части = путь
// внутри проекта), path (целевая папка), commitMessage, branch. Файлы до 30 МБ
// кабинет шлёт так же; крупнее — по частям через /file-storage/userdata/...,
// нам это не нужно (самый большой файл проекта — 1,3 МБ).
//
// Сертификат регионального API выпущен внутренним центром — проверку цепочки
// отключаем осознанно (rejectUnauthorized: false), трафик идёт по HTTPS.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import { execFileSync } from 'node:child_process';

export const API_HOST = 'api.msk1.amvera.ru';
const TOKEN_FILE = path.join(os.tmpdir(), 'amvera-token.json');
const LOGIN_SCRIPT = path.resolve(import.meta.dirname, 'amvera-login.mjs');

/** Токен Keycloak: из кеша, при истечении — логинимся заново. */
export function token({ force = false } = {}) {
  if (!force) {
    try {
      const data = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
      const fresh = data.expiresAt ? Date.now() < data.expiresAt - 60_000 : false;
      if (data.access_token && fresh) return data.access_token;
    } catch {
      /* кеша нет — идём логиниться */
    }
  }
  execFileSync(process.execPath, [LOGIN_SCRIPT], { stdio: 'inherit' });
  const data = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
  if (!data.access_token) throw new Error('не удалось получить токен Amvera');
  /* в кеше от старой версии скрипта нет времени жизни — считаем по expires_in */
  if (!data.expiresAt) {
    data.expiresAt = Date.now() + (data.expires_in || 1800) * 1000;
    fs.writeFileSync(TOKEN_FILE, JSON.stringify(data, null, 2));
  }
  return data.access_token;
}

/** Один HTTP-запрос к региональному API. */
export function request(method, urlPath, { body = null, headers = {}, timeout = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    const allHeaders = {
      accept: 'application/json',
      'user-agent': 'dsh-open-web deploy',
      authorization: `Bearer ${token()}`,
      ...headers,
    };
    if (body) allHeaders['content-length'] = Buffer.byteLength(body);
    const req = https.request(
      { host: API_HOST, path: urlPath, method, headers: allHeaders, rejectUnauthorized: false, timeout },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode, headers: res.headers, text });
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy(new Error(`таймаут запроса ${method} ${urlPath}`));
    });
    if (body) req.write(body);
    req.end();
  });
}

/** JSON-запрос с понятной ошибкой вместо молчаливого 404. */
export async function apiJson(method, urlPath, body, options = {}) {
  const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
  const res = await request(method, urlPath, {
    body: payload,
    headers: payload ? { 'content-type': 'application/json' } : {},
    ...options,
  });
  if (res.status >= 400) {
    throw new Error(`${method} ${urlPath} → ${res.status}: ${res.text.slice(0, 300)}`);
  }
  try {
    return JSON.parse(res.text);
  } catch {
    return res.text;
  }
}

export const getProject = (slug) => apiJson('GET', `/projects/${encodeURIComponent(slug)}`);

export const rebuildProject = (slug) =>
  apiJson('POST', `/projects/${encodeURIComponent(slug)}/rebuild`, {});

export const restartProject = (slug) =>
  apiJson('POST', `/projects/${encodeURIComponent(slug)}/restart`, {});

/** Файлы и папки в каталоге проекта (папки помечены isFolder). */
export const listFiles = (slug, dir = '/', branch = 'master') =>
  apiJson(
    'GET',
    `/git/${encodeURIComponent(slug)}/files?branch=${encodeURIComponent(branch)}&path=${encodeURIComponent(dir)}`,
  );

/** Содержимое одного файла как текст. */
export async function getFile(slug, filename, branch = 'master') {
  const res = await request(
    'GET',
    `/git/${encodeURIComponent(slug)}/file?branch=${encodeURIComponent(branch)}&filename=${encodeURIComponent(filename)}`,
    { headers: { accept: 'text/plain, */*' } },
  );
  if (res.status >= 400) throw new Error(`GET file ${filename} → ${res.status}`);
  return res.text;
}

/** История коммитов: [{hash, author, date, message, branch}]. */
export const gitLog = (slug, { branch = 'master', page = 0, size = 10 } = {}) =>
  apiJson(
    'GET',
    `/git/${encodeURIComponent(slug)}/log?branch=${encodeURIComponent(branch)}&page=${page}&size=${size}`,
  );

/**
 * Загрузка набора файлов одним коммитом.
 * files: [{ path: 'src/agent.mjs', full: 'D:\\...\\src\\agent.mjs' }]
 */
export async function uploadFiles(slug, files, { commitMessage, branch = 'master', targetPath = '/', timeout = 180_000 } = {}) {
  const boundary = '----dshdeploy' + Math.random().toString(16).slice(2);
  const parts = [];
  const push = (chunk) => parts.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8'));

  for (const file of files) {
    push(`--${boundary}\r\n`);
    push(`Content-Disposition: form-data; name="files"; filename="${file.path}"\r\n`);
    push('Content-Type: application/octet-stream\r\n\r\n');
    push(fs.readFileSync(file.full));
    push('\r\n');
  }
  for (const [name, value] of [
    ['path', targetPath],
    ['commitMessage', commitMessage],
    ['branch', branch],
  ]) {
    push(`--${boundary}\r\n`);
    push(`Content-Disposition: form-data; name="${name}"\r\n\r\n`);
    push(value);
    push('\r\n');
  }
  push(`--${boundary}--\r\n`);

  const body = Buffer.concat(parts);
  const res = await request('POST', `/git/${encodeURIComponent(slug)}/files`, {
    body,
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    timeout,
  });
  if (res.status >= 400) {
    throw new Error(`загрузка ${files.length} файл(ов) → ${res.status}: ${res.text.slice(0, 300)}`);
  }
  return res.text;
}
