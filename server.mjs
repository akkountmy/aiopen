import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import zlib from 'node:zlib';
import {
  ADMIN,
  BILLING,
  BUDGET,
  DATA_DIR,
  DEVICE,
  DEVICE_KINDS,
  HOST,
  LIMITS,
  PORT,
  PUBLIC_DIR,
  SECURITY,
  SESSION,
  SIGNUP,
  TRUST_PROXY,
  chargeUsd,
  ensureDirs,
  sessionLimit,
  taskLimitUsd,
} from './src/config.mjs';
import { describeFailure, generateTitle, runTurn } from './src/agent.mjs';
import { transcribeAudio } from './src/asr.mjs';
import { detectKind, extractDocumentText, kindLabel } from './src/docparse.mjs';
import { previewDocument } from './src/docpreview.mjs';
import { projectFilesBrief } from './src/filebrief.mjs';
import { docEngines } from './src/doc/index.mjs';
import { approvalMessage, notifyAdmin, suspicionMessage } from './src/notify.mjs';
import { issueOpenLink, resolveOpenLink, asciiFileName, OPEN_PREFIX } from './src/openlink.mjs';
import { proofreadText } from './src/proofread.mjs';
import { keyStatus } from './src/keys.mjs';
import {
  clearSessionCookie,
  deviceCookie,
  deviceKind,
  issueSession,
  isInstalledApp,
  newDeviceId,
  parseCookies,
  passwordProblem,
  RateLimiter,
  sessionCookie,
  sessionKey,
  sessionKind,
  usernameProblem,
} from './src/security.mjs';
import { store } from './src/store.mjs';
import { listTree, resolveSafe } from './src/tools.mjs';
import { listSkills } from './src/skills.mjs';
import { pipeZip } from './src/zip.mjs';
import { nowIso, safeName, uid } from './src/util.mjs';
import { describeImage } from './src/vision.mjs';
import { webSearch } from './src/search.mjs';

ensureDirs();
store.init({ adminUsername: ADMIN.username, adminPassword: ADMIN.password });

const loginIpHits = new RateLimiter({ windowMs: SECURITY.loginWindowMs, max: SECURITY.loginMaxPerIp });
const loginUserHits = new RateLimiter({ windowMs: SECURITY.loginWindowMs, max: SECURITY.loginMaxPerUser });
const transcribeHits = new RateLimiter({ windowMs: 60 * 60 * 1000, max: 120 });
const proofreadHits = new RateLimiter({ windowMs: 60 * 60 * 1000, max: 240 });
const signupHits = new RateLimiter({ windowMs: 60 * 60 * 1000, max: SIGNUP.maxPerIpPerHour });
/* Идущие ответы: ключ — «пользователь:диалог». Один и тот же диалог не может
   генерироваться дважды (иначе сообщения перепутаются), но разные диалоги
   считаются независимо — так ноутбук и телефон работают параллельно. Общий
   потолок на аккаунт остаётся: LIMITS.agentConcurrencyPerUser. */
const runningChats = new Set();
const runningByUser = new Map();
const attachmentQueue = new Set();

/* ---------------- живые задачи ----------------
   Ответ агента больше не живёт внутри одного соединения с браузером. Пока идёт
   работа, её состояние (текст, шаги, заголовок) обновляется здесь: вкладку можно
   перезагрузить, уйти в другой проект, открыть диалог с телефона — при
   возвращении клиент получает готовый снимок и продолжает живой поток.
   Останавливает задачу только человек (кнопка «Стоп») или конец работы агента. */
/* Сколько держим завершённый запуск для позднего переподключения. */
const RUN_KEEP_MS = 15 * 60 * 1000;
const runs = new Map();
const runByChat = new Map();
const chatRunKey = (userId, chatId) => `${userId}:${chatId}`;

function liveRunForChat(userId, chatId) {
  const run = runByChat.get(chatRunKey(userId, chatId));
  return run && run.status === 'running' ? run : null;
}

function publicRun(run) {
  return {
    id: run.id,
    chatId: run.chatId,
    projectId: run.projectId,
    status: run.status,
    startedAt: run.startedAt,
    seq: run.seq,
    chars: run.text.length,
  };
}

/* Полное состояние задачи на текущий момент: по нему вкладка рисует ответ,
   даже если подключилась на середине. */
function runSnapshot(run) {
  return {
    ...publicRun(run),
    text: run.text,
    tools: run.tools,
    title: run.title,
    budget: run.budget,
  };
}

function activeRunsFor(userId) {
  return [...runs.values()]
    .filter((run) => run.userId === userId && run.status === 'running')
    .map(publicRun);
}

function createRun({ user, project, chat }) {
  const run = {
    id: uid('run_'),
    userId: user.id,
    projectId: project.id,
    chatId: chat.id,
    user,
    project,
    chat,
    status: 'running',
    startedAt: nowIso(),
    startedMs: Date.now(),
    seq: 0,
    text: '',
    tools: [],
    title: '',
    budget: null,
    subscribers: new Set(),
    controller: new AbortController(),
  };
  runs.set(run.id, run);
  runByChat.set(chatRunKey(user.id, chat.id), run);
  runningChats.add(chatRunKey(user.id, chat.id));
  runningByUser.set(user.id, (runningByUser.get(user.id) || 0) + 1);
  /* Метка в файле чата переживает перезапуск сервиса: если процесса, который
     её поставил, уже нет, при следующем входе честно скажем, что задача
     прервалась, вместо вечного «работаю…». */
  store.setChatRunning(chat.id, { runId: run.id, startedAt: run.startedAt });
  return run;
}

/* Одно событие задачи: обновляет состояние и уходит всем подключённым вкладкам —
   их может быть несколько: ноутбук, телефон, ярлык. */
function publishRun(run, data) {
  if (run.status !== 'running' && data.type !== 'end') return;
  run.seq += 1;
  const event = { ...data, runId: run.id };
  if (data.type === 'delta') run.text += data.text || '';
  else if (data.type === 'tool') {
    const known = run.tools.find((tool) => tool.id === data.id);
    if (known) Object.assign(known, data);
    else run.tools.push({ id: data.id, label: data.label, summary: data.summary, status: data.status });
  } else if (data.type === 'title') run.title = data.title || run.title;
  else if (data.type === 'budget') run.budget = { spentUsd: data.spentUsd, limitUsd: data.limitUsd, status: 'pending' };
  else if (data.type === 'approval' && data.approval) run.budget = data.approval;
  for (const subscriber of [...run.subscribers]) {
    try {
      subscriber(event);
    } catch {
      run.subscribers.delete(subscriber);
    }
  }
  return event;
}

/* Подключение к задаче: снимок уже полученного результата, затем живой поток.
   Никакого повтора событий — снимок сам содержит всё накопленное, поэтому текст
   не удваивается даже после десяти переподключений. */
function attachRun(res, run) {
  const stream = openStream(res, { 'X-DShow-Run': run.id });
  const subscriber = (event) => {
    stream.emit(event);
    /* Закрываем только по настоящему концу: «done» и «error» — это итог работы,
       после них приходит «end», и вкладке нужно увидеть оба. */
    if (event.type === 'end') {
      run.subscribers.delete(subscriber);
      setTimeout(() => stream.close(), 40);
    }
  };
  stream.emit({ type: 'snapshot', run: runSnapshot(run) });
  if (run.status !== 'running') {
    stream.emit({ type: 'end', status: run.status, runId: run.id });
    setTimeout(() => stream.close(), 40);
    return;
  }
  run.subscribers.add(subscriber);
  /* Пока задача думает, в поток может не уходить ни одного события. Пустой
     комментарий SSE раз в 15 секунд не даёт прокси и телефону закрыть
     «молчащее» соединение. Клиент такие строки просто пропускает. */
  const ping = setInterval(() => {
    if (stream.isClosed()) return;
    res.write(': ping\n\n');
  }, 15000);
  ping.unref?.();
  res.on('close', () => {
    clearInterval(ping);
    run.subscribers.delete(subscriber);
  });
}

function finishRun(run, status) {
  if (run.status !== 'running') return;
  publishRun(run, { type: 'end', status });
  run.status = status;
  run.finishedMs = Date.now();
  runByChat.delete(chatRunKey(run.userId, run.chatId));
  runningChats.delete(chatRunKey(run.userId, run.chatId));
  const left = (runningByUser.get(run.userId) || 1) - 1;
  if (left > 0) runningByUser.set(run.userId, left);
  else runningByUser.delete(run.userId);
  run.subscribers.clear();
  store.setChatRunning(run.chatId, null);
  const timer = setTimeout(() => {
    if (runs.get(run.id) === run) runs.delete(run.id);
  }, RUN_KEEP_MS);
  if (timer.unref) timer.unref();
}

/* Задача жила в памяти: после перезапуска сервиса в диалоге остаётся вопрос без
   ответа. Дописываем пометку один раз — чтобы не выглядело, будто ответ идёт. */
function recoverStaleRuns(user) {
  for (const meta of store.state.chats) {
    if (meta.ownerId !== user.id || !meta.running) continue;
    if (liveRunForChat(user.id, meta.id)) continue;
    store.setChatRunning(meta.id, null);
    const chat = store.getChat(meta.id, user.id);
    if (!chat) continue;
    const last = chat.messages[chat.messages.length - 1];
    if (last?.interrupted) continue;
    chat.messages.push({
      role: 'assistant',
      content: '',
      error: 'Сервис перезапускался, поэтому задача прервалась. Отправьте её ещё раз — контекст диалога сохранён.',
      interrupted: true,
      at: nowIso(),
    });
    store.saveChat(chat.id, { messages: chat.messages, history: chat.history, memory: chat.memory });
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  /* Манифест приложения: без своего типа браузер отказывается ставить ярлык. */
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.zip': 'application/zip',
};

/* Страница из файла пользователя показывается в рамке и без доступа к сервису:
   sandbox в заголовке делает её происхождение «чужим» — cookie и API недоступны,
   при этом сама страница остаётся полноценной. */
const PAGE_SANDBOX_CSP =
  "sandbox allow-scripts allow-popups allow-forms allow-modals; frame-ancestors 'self'; base-uri 'none'";

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data: blob:; connect-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; font-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
};

function sendJson(res, status, data, extraHeaders = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...SECURITY_HEADERS,
    ...extraHeaders,
  });
  res.end(body);
}

function sendError(res, status, message) {
  sendJson(res, status, { error: message });
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error('Слишком большой запрос'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJsonBody(req, limit = LIMITS.jsonBody) {
  const buf = await readBody(req, limit);
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    throw Object.assign(new Error('Некорректный JSON'), { status: 400 });
  }
}

/**
 * Принимает тело запроса сразу на диск, не держа файл в памяти.
 * Возвращает размер файла. При превышении лимита удаляет недописанный файл.
 */
async function receiveToFile(req, limit, dest) {
  await fs.promises.mkdir(path.dirname(dest), { recursive: true });
  const part = `${dest}.part`;
  const out = fs.createWriteStream(part);
  let size = 0;
  let settled = false;
  try {
    await new Promise((resolve, reject) => {
      const fail = (error) => {
        if (settled) return;
        settled = true;
        req.unpipe(out);
        req.on('data', () => {});
        req.resume();
        out.destroy();
        reject(error);
      };
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > limit) {
          fail(Object.assign(new Error('Слишком большой файл'), { status: 413 }));
        }
      });
      req.on('aborted', () => fail(Object.assign(new Error('Загрузка прервана'), { status: 400 })));
      req.on('error', fail);
      out.on('error', fail);
      out.on('finish', () => {
        if (settled) return;
        settled = true;
        resolve();
      });
      req.pipe(out);
    });
    await fs.promises.rename(part, dest);
    return size;
  } catch (error) {
    await fs.promises.rm(part, { force: true }).catch(() => {});
    throw error;
  }
}

async function freeDiskBytes() {
  try {
    const stats = await fs.promises.statfs(DATA_DIR);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return null;
  }
}

/** Не начинаем приём файла, если после него на диске не останется запаса. */
async function ensureDiskRoom(res, incomingBytes = 0) {
  const free = await freeDiskBytes();
  if (free === null) return true;
  const reserve = Number.isFinite(incomingBytes) && incomingBytes > 0 ? incomingBytes : 0;
  if (free < reserve + LIMITS.minFreeBytes) {
    sendError(res, 507, 'На диске сервиса мало места. Удалите ненужные файлы и повторите.');
    return false;
  }
  return true;
}

/**
 * Занятое место в каталоге данных: общий размер и разбивка по верхним папкам.
 * Читаем по одной записи, чтобы не держать в памяти дерево большого проекта.
 */
async function dataUsage() {
  const parts = { workspaces: 0, uploads: 0, chats: 0, logs: 0, index: 0, other: 0 };
  const buckets = new Set(['workspaces', 'uploads', 'chats', 'logs']);
  const stack = [{ dir: DATA_DIR, bucket: null }];
  let totalBytes = 0;
  while (stack.length) {
    const { dir, bucket } = stack.pop();
    let entries = [];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push({ dir: full, bucket: bucket || (buckets.has(entry.name) ? entry.name : 'other') });
        continue;
      }
      if (!entry.isFile()) continue;
      let size = 0;
      try {
        size = (await fs.promises.stat(full)).size;
      } catch {
        size = 0;
      }
      totalBytes += size;
      const key = bucket || (entry.name === 'index.json' ? 'index' : 'other');
      parts[key] = (parts[key] || 0) + size;
    }
  }
  return { totalBytes, parts };
}

/** Состояние диска сервиса: сколько дано тому, сколько занято, чем занято. */
async function storageReport() {
  const data = await dataUsage();
  const limits = planLimits();
  const cap = planDiskCap(limits.memoryBytes);
  const report = {
    at: nowIso(),
    dataDir: DATA_DIR,
    data: { totalBytes: data.totalBytes, parts: data.parts },
    plan: {
      memoryBytes: limits.memoryBytes,
      cpuCores: limits.cpuCores,
      capBytes: cap.bytes,
      capSource: cap.source,
    },
    volume: null,
    reserveBytes: LIMITS.minFreeBytes,
    overview: store.overview(),
  };
  try {
    const stats = await fs.promises.statfs(DATA_DIR);
    const blockSize = Number(stats.bsize);
    const totalBytes = Number(stats.blocks) * blockSize;
    const freeBytes = Number(stats.bavail) * blockSize;
    const usedBytes = Math.max(0, totalBytes - freeBytes);
    report.volume = {
      totalBytes,
      freeBytes,
      usedBytes,
      usedPct: totalBytes > 0 ? Number(((usedBytes / totalBytes) * 100).toFixed(2)) : null,
    };
  } catch {
    report.volume = null;
  }
  return report;
}

function readTextFile(file) {
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    return null;
  }
}

/** Ресурсы, которые дал тариф: лимит памяти контейнера и квота ЦП (cgroup v2, затем v1). */
function planLimits() {
  const memoryRaw =
    readTextFile('/sys/fs/cgroup/memory.max') || readTextFile('/sys/fs/cgroup/memory/memory.limit_in_bytes');
  let memoryBytes = null;
  if (memoryRaw && /^\d+$/.test(memoryRaw)) {
    const value = Number(memoryRaw);
    if (value > 0 && value < 1e12) memoryBytes = value;
  }
  const cpuMax = readTextFile('/sys/fs/cgroup/cpu.max');
  let cpuCores = null;
  if (cpuMax) {
    const [quota, period] = cpuMax.split(/\s+/);
    if (quota && quota !== 'max' && Number(quota) > 0) cpuCores = Number(quota) / Number(period || 100000);
  } else {
    const q = Number(readTextFile('/sys/fs/cgroup/cpu/cpu.cfs_quota_us'));
    const p = Number(readTextFile('/sys/fs/cgroup/cpu/cpu.cfs_period_us'));
    if (q > 0 && p > 0) cpuCores = q / p;
  }
  return { memoryBytes, cpuCores: cpuCores === null ? null : Number(cpuCores.toFixed(2)) };
}

const MB = 1024 * 1024;

/**
 * Потолок диска по тарифу Amvera. Отдельного запроса «сколько мне дали» у платформы
 * нет, а statfs(/data) показывает диск всего узла (общий с другими проектами).
 * Зато ОЗУ и SSD в тарифах идут парами, поэтому лимит памяти контейнера и есть
 * ключ к тарифу. Переопределяется переменной DSHOW_STORAGE_CAP_MB.
 */
function planDiskCap(memoryBytes) {
  const override = Number(process.env.DSHOW_STORAGE_CAP_MB || 0);
  if (Number.isFinite(override) && override > 0) {
    return { bytes: Math.round(override) * MB, source: 'DSHOW_STORAGE_CAP_MB' };
  }
  if (!memoryBytes) return { bytes: null, source: null };
  const mib = memoryBytes / MB;
  const table = [
    [120, 2], // Пробный: 100 МБ ОЗУ, 2 ГБ SSD
    [600, 5], // Начальный: 500 МБ ОЗУ, 5 ГБ SSD
    [1200, 7], // Начальный Плюс: 1 ГБ ОЗУ, 7 ГБ SSD
    [2800, 15], // Стандартный: 2,5 ГБ ОЗУ, 15 ГБ SSD
    [6500, 25], // Ультра: 6 ГБ ОЗУ, 25 ГБ SSD
    [Infinity, 35], // Ультра Плюс: 9 ГБ ОЗУ, 35 ГБ SSD
  ];
  const row = table.find(([max]) => mib <= max) || table[table.length - 1];
  return { bytes: row[1] * 1024 * MB, source: `тариф по лимиту памяти ${Math.round(mib)} МБ` };
}

/** Живые сеансы и история входов: видно, с какого класса устройства вошли и кого это выбило. */
function sessionsReport() {
  const now = Date.now();
  const sessions = Object.entries(store.state.sessions || {}).map(([key, session]) => {
    const user = store.getUser(session.userId);
    return {
      id: key.slice(0, 10),
      user: user ? user.username : '—',
      kind: sessionKind(session),
      service: Boolean(session.service),
      device: String(session.device || '').slice(0, 8),
      ua: String(session.ua || ''),
      ip: String(session.ip || ''),
      createdAt: session.createdAt || null,
      expiresInHours: Math.max(0, Math.round((Number(session.exp) - now) / 3600000)),
    };
  });
  const kicked = Object.entries(store.state.kicked || {}).map(([key, mark]) => ({
    id: key.slice(0, 10),
    kind: DEVICE_KINDS.includes(String(mark.kind)) ? String(mark.kind) : 'desktop',
    at: Number(mark.at) ? new Date(Number(mark.at)).toISOString() : null,
    byIp: mark.byIp || '',
    byUa: mark.byUa || '',
  }));
  const audit = store.users().map((user) => ({
    user: user.username,
    events: (store.loginAuditFor(user.id).events || []).slice(-12),
  }));
  return {
    at: nowIso(),
    /* Сколько устройств аккаунт держит одновременно: закрывается только самый
       давно не использованный сеанс, поэтому тип устройства здесь справочный. */
    seats: sessionLimit(),
    sessions,
    kicked,
    audit,
  };
}

function clientIp(req) {
  if (TRUST_PROXY) {
    const forwarded = String(req.headers['x-forwarded-for'] || '')
      .split(',')[0]
      .trim();
    if (forwarded) return forwarded;
    const real = String(req.headers['x-real-ip'] || '').trim();
    if (real) return real;
  }
  return req.socket.remoteAddress || '';
}

/* Скользящий срок жизни входа. Продлевать мало на сервере: у cookie в браузере
   свой Max-Age, и без нового Set-Cookie браузер стирает её ровно через срок,
   отсчитанный при входе, — ярлык-приложение посреди работы показывает экран
   входа. Поэтому при продлении cookie ставится заново, с полным сроком. */
function currentUser(req, res) {
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies[SESSION.cookie];
  if (!token) return null;
  const key = sessionKey(token);
  const user = store.sessionUser(key);
  if (!user) return null;
  const session = store.state.sessions[key];
  if (session && session.exp - Date.now() < SESSION.ttlMs / 2) {
    store.renewSession(key, SESSION.ttlMs);
    if (res && !res.headersSent && !res.getHeader('Set-Cookie')) {
      res.setHeader('Set-Cookie', sessionCookie(token, SESSION.ttlMs, TRUST_PROXY));
    }
  }
  return user;
}

function requireUser(req, res) {
  const user = currentUser(req, res);
  if (user) return user;
  const token = parseCookies(req.headers.cookie)[SESSION.cookie];
  if (token) {
    const kicked = store.kickedInfo(sessionKey(token));
    if (kicked) {
      const seats = sessionLimit();
      return sendJson(
        res,
        401,
        {
          error:
            `Этот сеанс закрыт: у аккаунта одновременно работают не больше ${seats} устройств, ` +
            'и на новом входе пришлось уступить место тому, где дольше всего ничего не делали. ' +
            'Просто войдите снова — или смените пароль, если это были не вы.',
          reason: 'displaced',
          at: kicked.at,
        },
        { 'Set-Cookie': clearSessionCookie(TRUST_PROXY) },
      );
    }
  }
  sendError(res, 401, 'Требуется вход');
  return null;
}

function requireAdmin(req, res) {
  const user = requireUser(req, res);
  if (!user) return null;
  if (user.role !== 'admin') {
    sendError(res, 403, 'Недостаточно прав');
    return null;
  }
  return user;
}

function projectOr404(res, user, projectId) {
  const project = store.getProject(projectId, user.id);
  if (!project) {
    sendError(res, 404, 'Проект не найден');
    return null;
  }
  return project;
}

function chatScopeOr404(res, user, chatId) {
  const chat = store.getChat(chatId, user.id);
  if (!chat) {
    sendError(res, 404, 'Диалог не найден');
    return null;
  }
  return chat;
}

function serializeAttachment(att) {
  return {
    id: att.id,
    name: att.name,
    kind: att.kind,
    label: kindLabel(att.kind),
    size: att.size,
    status: att.status,
    error: att.error || null,
    warnings: att.warnings || [],
    path: att.relPath || '',
  };
}

function chatMeta(chat) {
  return {
    id: chat.id,
    projectId: chat.projectId,
    title: chat.title,
    createdAt: chat.createdAt,
    updatedAt: chat.updatedAt,
    messageCount: chat.messageCount || 0,
    /* В диалоге прямо сейчас работает агент: по этому признаку в списке
       диалогов виден индикатор, даже если открыт другой проект. */
    running: Boolean(liveRunForChat(chat.ownerId, chat.id)),
  };
}

/* Внешний адрес сервиса. Нужен для ссылки, которую открывает Word/Excel:
   приложение качает файл само, поэтому адрес должен быть публичным. */
function publicOrigin(req) {
  const configured = String(process.env.DSHOW_PUBLIC_URL || '').trim();
  if (configured) return configured.replace(/\/+$/, '');
  const rawProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const rawHost = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  const proto = rawProto || (req.socket?.encrypted ? 'https' : 'http');
  return rawHost ? `${proto}://${rawHost}` : 'https://dshopen-vladimir00177.msk1.amvera.tech';
}

function projectLimit(project) {
  return taskLimitUsd(project?.budgetUsd);
}

/* Запрос администратору: создаём один раз на проект и сразу шлём в Telegram. */
function raiseBudgetApproval({ user, project, chat, spentUsd }) {
  const pending = store.pendingApprovalFor(project.id);
  if (pending) return pending;
  const limitUsd = projectLimit(project);
  const approval = store.createApproval({
    userId: user.id,
    username: user.displayName || user.username,
    projectId: project.id,
    projectName: project.name,
    chatId: chat?.id || null,
    chatTitle: chat?.title && chat.title !== 'Новый диалог' ? chat.title : '',
    spentUsd,
    limitUsd,
  });
  notifyAdmin(
    approvalMessage({
      username: `${user.displayName || user.username} (${user.username})`,
      projectName: project.name,
      chatTitle: approval.chatTitle,
      spentUsd: Number(approval.spentUsd),
      limitUsd,
      when: new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' }),
    }),
  ).catch(() => {});
  return approval;
}

function bootstrapPayload(user) {
  /* Записи прежних версий создавались без владельца: отдаём их тому, кто вошёл
     первым, иначе раздельные истории сделали бы их невидимыми для всех. */
  store.claimOrphans(user.id);
  /* У нового аккаунта сразу есть своё рабочее место: собственный проект и
     пустой диалог. Чужих проектов и истории этот вызов не касается. */
  store.ensurePersonalProject(user.id);
  /* Если сервис перезапускался во время работы, метка «идёт ответ» осталась в
     файле чата без живой задачи — закрываем её честной пометкой. */
  recoverStaleRuns(user);
  const projects = store.projectsFor(user.id).map((project) => ({
    ...project,
    chats: store.chatsFor(project.id).map(chatMeta),
  }));
  return {
    user: store.publicUser(user.id),
    projects,
    workflows: store.workflowsFor(user.id),
    /* Незавершённые задачи: вкладка после перезагрузки сразу подключается к
       той, что идёт, вместо пустого экрана. */
    runs: activeRunsFor(user.id),
    keys: { vision: keyStatus().vision },
    limits: {
      maxAttachments: LIMITS.maxAttachmentsPerMessage,
      maxFileMb: Math.round(LIMITS.maxAttachmentBytes / 1024 / 1024),
    },
  };
}

/* Метка машины из долгоживущей cookie. Если её ещё нет (первый вход в этом
   браузере), выдаём новую — так видно, что входы идут с разных устройств. */
function deviceIdOf(req) {
  const known = parseCookies(req.headers.cookie)[DEVICE.cookie];
  if (known && known.length >= 8 && known.length <= 80) return { id: known, fresh: false };
  return { id: newDeviceId(), fresh: true };
}

/* Служебные клиенты (сторож места, дежурные скрипты) представляются своим
   User-Agent. Их входы не занимают «полку» человека и никого не выбивают:
   иначе автоматика под той же учётной записью тушит живой браузер. */
function isServiceClient(req) {
  const ua = String(req.headers['user-agent'] || '');
  return /^DSH-OPEN-WEB-/i.test(ua) || req.headers['x-dshow-service'] === '1';
}

/* Класс устройства этого входа. Берём User-Agent и, если браузер прислал,
   Client Hint Sec-CH-UA-Mobile — так планшет с «настольным» User-Agent тоже
   попадает в телефонную полку и не выбивает ноутбук.
   Ярлык, открытый как приложение, — отдельная полка: на iPhone он держит cookie
   отдельно от Safari, и без этого вход из ярлыка закрывал вкладку телефона. */
function deviceKindOf(req) {
  if (isInstalledApp(req.headers['x-dshow-display'])) return 'app';
  return deviceKind(req.headers['user-agent'], { mobileHint: req.headers['sec-ch-ua-mobile'] });
}

/* Фиксирует вход: история устройств нужна, чтобы заметить передачу пароля.
   Считаем не число закрытых сеансов (их может накопиться много), а сам факт:
   этот вход выбил чью-то работающую сессию. */
function registerLogin(user, req, { ip, deviceId, displaced }) {
  const ua = String(req.headers['user-agent'] || '');
  const result = store.recordLogin(user.id, {
    ip,
    ua,
    device: deviceId,
    kind: deviceKindOf(req),
    displaced: displaced.length ? 1 : 0,
  });
  if (!result.alert) return result;
  console.warn(
    `[guard] подозрение по аккаунту ${user.username}: ${result.reasons.join('; ')} — сообщаю администратору`,
  );
  notifyAdmin(
    suspicionMessage({
      username: user.username,
      displayName: user.displayName || user.username,
      reasons: result.reasons,
      events: result.recent,
      ips: result.ips,
      devices: result.devices,
      displaced: result.displaced,
      windowHours: result.windowHours,
    }),
  ).catch((error) => console.warn('[notify] подозрение не отправлено:', error?.message || error));
  return result;
}

async function handleLogin(req, res) {
  const ip = clientIp(req);
  const gate = loginIpHits.check(ip);
  if (!gate.ok) {
    return sendError(res, 429, `Слишком много попыток. Повторите через ${Math.ceil(gate.retryAfterMs / 60000)} мин.`);
  }
  const body = await readJsonBody(req);
  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  const user = store.getUserByUsername(username);
  const userGate = loginUserHits.check(username.toLowerCase() || '—');
  loginIpHits.hit(ip);
  if (!userGate.ok) {
    return sendError(res, 429, 'Слишком много попыток входа. Подождите несколько минут.');
  }
  const valid = Boolean(user) && !user.disabled && store.checkPassword(user, password);
  if (!valid) {
    loginUserHits.hit(username.toLowerCase() || '—');
    return sendError(res, 401, 'Неверный логин или пароль');
  }
  loginUserHits.reset(username.toLowerCase());
  loginIpHits.reset(ip);
  const device = deviceIdOf(req);
  const service = isServiceClient(req);
  const { token, displaced } = issueSession(store, user.id, {
    ip,
    ua: req.headers['user-agent'],
    device: device.id,
    kind: deviceKindOf(req),
    service,
  });
  store.touchLogin(user.id);
  if (!service) registerLogin(user, req, { ip, deviceId: device.id, displaced });
  const cookies = [sessionCookie(token, SESSION.ttlMs, TRUST_PROXY)];
  if (device.fresh) cookies.push(deviceCookie(device.id, DEVICE.cookieMs, TRUST_PROXY));
  sendJson(res, 200, bootstrapPayload(user), { 'Set-Cookie': cookies });
}

async function handleSignup(req, res) {
  if (!SIGNUP.open) return sendError(res, 403, 'Свободная регистрация выключена');
  const ip = clientIp(req);
  const gate = signupHits.check(ip);
  if (!gate.ok) {
    return sendError(res, 429, `Слишком много регистраций. Повторите через ${Math.ceil(gate.retryAfterMs / 60000)} мин.`);
  }
  const body = await readJsonBody(req);
  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  const problem = usernameProblem(username) || passwordProblem(password);
  if (problem) return sendError(res, 400, problem);
  signupHits.hit(ip);
  if (store.getUserByUsername(username)) return sendError(res, 409, 'Такой логин уже занят');
  let user = null;
  try {
    user = store.createUser({ username, password, displayName: username.slice(0, 80), role: 'user' });
  } catch {
    return sendError(res, 409, 'Такой логин уже занят');
  }
  const device = deviceIdOf(req);
  const { token, displaced } = issueSession(store, user.id, {
    ip,
    ua: req.headers['user-agent'],
    device: device.id,
    kind: deviceKindOf(req),
  });
  store.touchLogin(user.id);
  registerLogin(user, req, { ip, deviceId: device.id, displaced });
  const cookies = [sessionCookie(token, SESSION.ttlMs, TRUST_PROXY)];
  if (device.fresh) cookies.push(deviceCookie(device.id, DEVICE.cookieMs, TRUST_PROXY));
  sendJson(res, 200, bootstrapPayload(user), { 'Set-Cookie': cookies });
}

async function handleUpload(req, res, user) {
  const rawName = decodeURIComponent(String(req.headers['x-filename'] || 'file'));
  const projectId = String(req.headers['x-project-id'] || '');
  const chatId = String(req.headers['x-chat-id'] || '') || null;
  const project = store.getProject(projectId, user.id);
  if (!project) return sendError(res, 404, 'Проект не найден');
  const mime = String(req.headers['content-type'] || 'application/octet-stream');
  const id = uid('a_');
  const cleanName = safeName(rawName).slice(0, 120) || 'file';
  const relPath = `uploads/${id.slice(-6)}_${cleanName}`;
  const full = resolveSafe(store.workspaceDir(project.id), relPath);
  const declared = Number(req.headers['content-length'] || 0);
  if (!(await ensureDiskRoom(res, declared))) return;
  const size = await receiveToFile(req, LIMITS.maxAttachmentBytes, full);
  if (!size) {
    await fs.promises.rm(full, { force: true }).catch(() => {});
    return sendError(res, 400, 'Пустой файл');
  }
  const kind = detectKind(cleanName, mime);
  const attachment = store.createAttachment({
    id,
    ownerId: user.id,
    projectId: project.id,
    chatId,
    name: cleanName,
    mime,
    size,
    kind,
    relPath,
    status: 'processing',
    text: '',
    warnings: [],
    createdAt: nowIso(),
  });
  scheduleAttachment(attachment, store.workspaceDir(project.id));
  sendJson(res, 200, { attachment: serializeAttachment(attachment) });
}

// Разбор файлов идёт по одному: пики памяти на больших документах не складываются.
let attachmentChain = Promise.resolve();
function scheduleAttachment(att, workspace) {
  attachmentChain = attachmentChain
    .then(() => processAttachment(att, workspace))
    .catch((error) => console.error('[attachment]', error?.message || error));
  return attachmentChain;
}

async function processAttachment(att, workspace) {
  if (attachmentQueue.has(att.id)) return;
  attachmentQueue.add(att.id);
  try {
    const full = resolveSafe(workspace, att.relPath);
    if (att.kind !== 'image' && Number(att.size || 0) > LIMITS.maxParseBytes) {
      store.updateAttachment(att.id, {
        status: 'ready',
        text: '',
        warnings: [`Файл больше ${Math.round(LIMITS.maxParseBytes / 1024 / 1024)} МБ — он сохранён, но текст автоматически не извлекался.`],
      });
      return;
    }
    const buffer = fs.readFileSync(full);
    if (att.kind === 'image') {
      const result = await describeImage({ buffer, mime: att.mime, name: att.name });
      store.updateAttachment(att.id, { status: 'ready', text: result.text, warnings: [] });
      return;
    }
    const parsed = extractDocumentText(buffer, att.name, att.mime, { maxChars: LIMITS.maxFileTextChars });
    if (!parsed.text) {
      store.updateAttachment(att.id, {
        status: 'ready',
        text: '',
        warnings: parsed.warnings.length ? parsed.warnings : ['В файле не найден текст для анализа.'],
      });
      return;
    }
    store.updateAttachment(att.id, { status: 'ready', text: parsed.text, warnings: parsed.warnings });
  } catch (error) {
    store.updateAttachment(att.id, {
      status: 'error',
      error: 'Не удалось обработать файл',
      warnings: [String(error.message || '').slice(0, 200)],
    });
  } finally {
    attachmentQueue.delete(att.id);
  }
}

async function waitForAttachments(ids, user, chat, emit) {
  const result = [];
  const deadline = Date.now() + 120000;
  for (const id of ids) {
    let att = store.getAttachment(id);
    if (!att || att.ownerId !== user.id || att.projectId !== chat.projectId) continue;
    if (att.status === 'processing') emit({ type: 'stage', stage: 'files' });
    while (att.status === 'processing' && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 400));
      att = store.getAttachment(id);
    }
    result.push(att);
  }
  if (chat.id) {
    for (const att of result) {
      if (att.chatId !== chat.id) store.updateAttachment(att.id, { chatId: chat.id });
    }
  }
  return result;
}

function attachmentContext(attachments) {
  const blocks = [];
  const images = [];
  let budget = LIMITS.attachmentsContextChars;
  for (const att of attachments) {
    let body;
    if (att.kind === 'image') {
      body = `[Изображение «${att.name}» — распознавание]\n${att.text || '(не удалось распознать)'}`;
      if (att.size <= 8 * 1024 * 1024 && images.length < 4) {
        const full = resolveSafe(store.workspaceDir(att.projectId), att.relPath);
        try {
          const buf = fs.readFileSync(full);
          const mime = att.mime && att.mime.startsWith('image/') ? att.mime : 'image/png';
          images.push(`data:${mime};base64,${buf.toString('base64')}`);
        } catch {
          /* ignore */
        }
      }
    } else if (att.text) {
      body = `[Файл «${att.name}» (${kindLabel(att.kind)}), путь: ${att.relPath}]\n${att.text}`;
    } else {
      body = `[Файл «${att.name}» (${kindLabel(att.kind)}), путь: ${att.relPath}] — текст не извлечён.`;
    }
    if (budget <= 0) {
      blocks.push(`[Файл «${att.name}» — не передан в контекст: достигнут лимит объёма. Полный текст доступен через инструменты чтения по пути ${att.relPath}]`);
      continue;
    }
    if (body.length > budget) {
      body = `${body.slice(0, budget)}\n…[обрезано: достигнут лимит объёма]`;
    }
    budget -= body.length;
    blocks.push(body);
  }
  return { text: blocks.join('\n\n'), images };
}

function openStream(res, extraHeaders = {}) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    ...SECURITY_HEADERS,
    ...extraHeaders,
  });
  res.write(': connected\n\n');
  let closed = false;
  const emit = (data) => {
    if (closed) return;
    try {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    } catch {
      closed = true;
    }
  };
  const close = () => {
    if (closed) return;
    closed = true;
    try {
      res.end();
    } catch {
      /* ignore */
    }
  };
  const keepAlive = setInterval(() => {
    if (!closed) {
      try {
        res.write(': ping\n\n');
      } catch {
        /* ignore */
      }
    }
  }, 15000);
  res.on('close', () => {
    closed = true;
    clearInterval(keepAlive);
  });
  return { emit, close, isClosed: () => closed, cleanup: () => clearInterval(keepAlive) };
}

async function handleMessageStream(req, res, user, chatId) {
  const chat = store.getChat(chatId, user.id);
  if (!chat) return sendError(res, 404, 'Диалог не найден');
  const project = store.getProject(chat.projectId, user.id);
  if (!project) return sendError(res, 404, 'Проект не найден');

  /* Обычная задача запускается сразу и без уведомлений. Ограничение — только
     по стоимости самой задачи (порог в agent.mjs) и по уже висящему запросу:
     пока администратор не ответил, новую работу не начинаем. */
  if (user.role !== 'admin') {
    const pending = store.pendingApprovalFor(project.id);
    if (pending) {
      return sendError(
        res,
        402,
        'Предыдущая тяжёлая задача ждёт подтверждения администратора — продолжу, как только он ответит.',
      );
    }
    if (Number(user.creditUsd || 0) <= 0) {
      return sendError(
        res,
        402,
        'На балансе закончились средства. Напишите администратору — он пополнит баланс, и можно будет продолжить.',
      );
    }
  }

  const body = await readJsonBody(req, LIMITS.jsonBody);
  const text = String(body.text || '').trim();
  const attachmentIds = Array.isArray(body.attachmentIds) ? body.attachmentIds.slice(0, LIMITS.maxAttachmentsPerMessage) : [];
  if (!text && !attachmentIds.length) return sendError(res, 400, 'Пустое сообщение');

  /* Занятость проверяем после чтения тела: иначе две одновременные отправки
     успевают проскочить проверку до того, как первая займёт диалог.
     Один диалог — один ответ (иначе сообщения перепутаются), но разные диалоги
     считаются независимо: ноутбук и телефон могут работать одновременно. */
  const active = liveRunForChat(user.id, chat.id);
  if (active) {
    /* Ответ уже идёт — возможно, начатый с другого устройства или переживший
       перезагрузку этой страницы. Второй не запускаем: отдаём клиенту
       идентификатор запуска, и вкладка подключается к нему. */
    return sendJson(res, 429, {
      error: 'Ответ в этом диалоге уже идёт — подключаюсь к нему.',
      run: publicRun(active),
    });
  }
  const busy = runningByUser.get(user.id) || 0;
  if (busy >= LIMITS.agentConcurrencyPerUser) {
    return sendError(
      res,
      429,
      `Сейчас идёт ${busy} ${busy === 1 ? 'ответ' : 'ответа'} — дождитесь завершения хотя бы одного.`,
    );
  }

  const run = createRun({ user, project, chat });
  /* Текущее соединение подписывается на запуск. Работа идёт отдельно от него:
     обрыв этого сокета (перезагрузка страницы, уход на другой проект, сон
     телефона) задачу больше не прерывает. */
  attachRun(res, run);
  void executeRun(run, {
    text,
    attachmentIds,
    isFirstMessage: chat.messages.length === 0,
  });
}

/* Сама работа. Живёт своей жизнью: её не останавливает закрытие вкладки, а все
   события складываются в запуск — подключиться и догнать можно в любой момент. */
async function executeRun(run, job) {
  const { user, project, chat } = run;
  const { text, attachmentIds, isFirstMessage } = job;
  const controller = run.controller;
  const stream = { emit: (data) => publishRun(run, data) };

  let assistantText = '';
  try {
    const attachments = await waitForAttachments(attachmentIds, user, chat, stream.emit);
    /* Пока ждали вложения, человек мог нажать «Стоп» — тогда работу не начинаем. */
    if (controller.signal.aborted) throw Object.assign(new Error('Остановлено'), { name: 'AbortError' });
    const ctx = attachmentContext(attachments);
    /* Что уже лежит в проекте: свежие файлы пересказаны коротко, чтобы задача
       про загруженный файл решалась сразу, без «пришлите ещё раз». Вложения
       этого же сообщения уже целиком в тексте — их не дублируем. */
    let filesBrief = '';
    try {
      filesBrief = projectFilesBrief(store.workspaceDir(project.id), {
        skipPaths: attachments.map((att) => att.relPath),
      }).text;
    } catch (error) {
      console.error('[files]', error?.message || error);
    }
    const userMessage = {
      role: 'user',
      content: text,
      attachments: attachments.map((att) => ({
        id: att.id,
        name: att.name,
        kind: att.kind,
        label: kindLabel(att.kind),
        size: att.size,
        relPath: att.relPath,
      })),
      at: nowIso(),
    };
    chat.messages.push(userMessage);
    store.saveChat(chat.id, { messages: chat.messages, history: chat.history, memory: chat.memory });

    const userText = [text, ctx.text].filter(Boolean).join('\n\n');
    stream.emit({ type: 'start' });

    const outcome = await runTurn({
      workspace: store.workspaceDir(project.id),
      /* Передаём сам объект чата: runTurn дописывает историю и обновляет
         сводку-«память» при переполнении. Копия { history, memory } теряла
         новую память, и она не попадала в файл чата. */
      chat,
      projectName: project.name,
      userName: user.displayName || user.username,
      userText,
      filesBrief,
      images: ctx.images,
      emit: stream.emit,
      signal: controller.signal,
      budget: user.role === 'admin' ? null : { limitUsd: projectLimit(project) },
      /* Постоянная память пользователя: факты подмешиваются в системное
         сообщение, remember пишет новые прямо в index.json. */
      facts: store.memoryFacts(user.id),
      remember: (fact) => store.addMemoryFact(user.id, fact),
    });

    assistantText = outcome.text || '';

    /* Учитываем стоимость: баланс пользователя, расход по проекту и суточная статистика.
       С баланса списывается итоговая сумма (внутренняя наценка уже внутри chargeUsd),
       в статистике и в лимите проекта — тоже она, чтобы все цифры сходились. */
    const chargedUsd = outcome.usage ? chargeUsd(outcome.usage.tokensIn, outcome.usage.tokensOut) : 0;
    if (chargedUsd > 0) {
      store.addProjectSpend(project.id, chargedUsd);
      if (user.role !== 'admin') store.chargeUser(user.id, chargedUsd);
    }
    if (outcome.usage) {
      store.addUsage(user.id, {
        tokensIn: outcome.usage.tokensIn,
        tokensOut: outcome.usage.tokensOut,
        messages: 1,
        usd: chargedUsd,
      });
    }
    const balanceUsd = user.role === 'admin' ? null : store.publicUser(user.id).balanceUsd;

    /* Задача перевалила за лимит: предупреждаем пользователя и просим администратора. */
    let budgetInfo = null;
    if (outcome.budgetHit) {
      const approval = raiseBudgetApproval({
        user,
        project,
        chat,
        spentUsd: outcome.budgetHit.spentUsd,
      });
      budgetInfo = {
        spentUsd: outcome.budgetHit.spentUsd,
        limitUsd: outcome.budgetHit.limitUsd,
        approvalId: approval.id,
        approvalStatus: approval.status,
      };
      const note =
        '\n\nЗадача получилась очень тяжёлой — это выше порога для одной задачи. Я приостановил работу и ' +
        'отправил администратору запрос на подтверждение: продолжу, как только он разрешит.';
      assistantText += note;
      stream.emit({ type: 'delta', text: note });
      stream.emit({ type: 'approval', approval: budgetInfo });
    }

    chat.messages.push({
      role: 'assistant',
      content: assistantText || 'Готово.',
      tools: outcome.tools.map((tool) => ({ id: tool.id, label: tool.label, summary: tool.summary, status: tool.status })),
      at: nowIso(),
      ...(budgetInfo ? { budget: budgetInfo } : {}),
    });
    store.saveChat(chat.id, { messages: chat.messages, history: chat.history, memory: chat.memory });

    if (isFirstMessage && (!chat.title || chat.title === 'Новый диалог')) {
      const title = await generateTitle(text || assistantText, { signal: controller.signal }).catch(() => '');
      if (title) {
        store.renameChat(chat.id, title);
        stream.emit({ type: 'title', title });
      }
    }
    stream.emit({ type: 'done', usage: outcome.usage, tools: outcome.tools.length, balanceUsd });
    finishRun(run, 'done');
  } catch (error) {
    const aborted = error?.name === 'AbortError' || controller.signal.aborted;
    const message = aborted ? 'Остановлено' : describeFailure(error);
    if (!aborted) console.error('[agent]', error?.message || error);
    if (assistantText) {
      chat.messages.push({ role: 'assistant', content: assistantText, interrupted: true, at: nowIso() });
    } else {
      chat.messages.push({ role: 'assistant', content: '', error: message, at: nowIso() });
    }
    store.saveChat(chat.id, { messages: chat.messages, history: chat.history, memory: chat.memory });
    stream.emit({ type: 'error', message, aborted });
    finishRun(run, aborted ? 'stopped' : 'error');
  }
}

const gzipCache = new Map();
let assetVersionCache = { value: '', at: 0 };

// Версия статики = самый свежий mtime среди ключевых файлов. Подставляется в index.html,
// чтобы браузер гарантированно забирал новый CSS/JS и мог кэшировать их навсегда.
function assetVersion() {
  const now = Date.now();
  if (now - assetVersionCache.at < 2000) return assetVersionCache.value;
  let stamp = 0;
  for (const name of ['index.html', 'styles.css', 'app.js', 'theme.js', 'favicon.svg']) {
    try {
      stamp = Math.max(stamp, fs.statSync(path.join(PUBLIC_DIR, name)).mtimeMs);
    } catch {
      /* файла нет — пропускаем */
    }
  }
  assetVersionCache = { value: String(Math.floor(stamp)).slice(-9), at: now };
  return assetVersionCache.value;
}

function gzipped(full, stat) {
  const key = `${full}:${Math.floor(stat.mtimeMs)}`;
  const cached = gzipCache.get(key);
  if (cached) return cached;
  if (gzipCache.size > 32) gzipCache.clear();
  const out = zlib.gzipSync(fs.readFileSync(full), { level: 6 });
  gzipCache.set(key, out);
  return out;
}

function serveStatic(req, res, urlPath, versioned = false) {
  let rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  let full = path.resolve(PUBLIC_DIR, rel);
  if (full !== PUBLIC_DIR && !full.startsWith(PUBLIC_DIR + path.sep)) {
    return sendError(res, 404, 'Не найдено');
  }
  let stat;
  try {
    stat = fs.statSync(full);
  } catch {
    return sendError(res, 404, 'Не найдено');
  }
  if (stat.isDirectory()) {
    rel = path.join(rel, 'index.html');
    full = path.resolve(PUBLIC_DIR, rel);
    try {
      stat = fs.statSync(full);
    } catch {
      return sendError(res, 404, 'Не найдено');
    }
  }
  const ext = path.extname(full).toLowerCase();
  const version = assetVersion();
  const isHtml = ext === '.html';
  const etag = isHtml ? `W/"html-${version}"` : `W/"${stat.size}-${Math.floor(stat.mtimeMs)}"`;
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { ETag: etag, ...SECURITY_HEADERS });
    return res.end();
  }
  const cacheControl = isHtml
    ? 'no-cache'
    : versioned
      ? 'public, max-age=31536000, immutable'
      : 'public, max-age=3600';
  const type = MIME[ext] || 'application/octet-stream';
  const body = isHtml
    ? Buffer.from(fs.readFileSync(full, 'utf8').replace(/__ASSET_VERSION__/g, version))
    : null;
  const headers = {
    'Content-Type': type,
    ETag: etag,
    'Cache-Control': cacheControl,
    Vary: 'Accept-Encoding',
    ...SECURITY_HEADERS,
  };
  /* mjs — это те же текстовые js-файлы: без него просмотрщик PDF отдавал
     1,7 МБ вместо 0,5 МБ (pdf.min.mjs 344 КБ и pdf.worker.min.mjs 1,3 МБ). */
  const compressible = /\.(html|css|m?js|webmanifest|svg|json|txt|md|map)$/.test(ext);
  const wantsGzip = compressible && /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''));
  if (wantsGzip) {
    const packed = body ? zlib.gzipSync(body, { level: 6 }) : gzipped(full, stat);
    if (packed.length < (body ? body.length : stat.size)) {
      res.writeHead(200, { ...headers, 'Content-Encoding': 'gzip', 'Content-Length': packed.length });
      return req.method === 'HEAD' ? res.end() : res.end(packed);
    }
  }
  const size = body ? body.length : stat.size;
  res.writeHead(200, { ...headers, 'Content-Length': size });
  if (req.method === 'HEAD') return res.end();
  if (body) return res.end(body);
  fs.createReadStream(full).pipe(res);
}

function sendFile(res, full, { download = false, name, head = false } = {}) {
  const stat = fs.statSync(full);
  if (!stat.isFile()) return sendError(res, 404, 'Не найдено');
  const ext = path.extname(full).toLowerCase();
  const fileName = name || path.basename(full);
  const disposition = download
    ? `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`
    : `inline; filename*=UTF-8''${encodeURIComponent(fileName)}`;
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': stat.size,
    'Content-Disposition': disposition,
    'Cache-Control': 'no-store',
    ...SECURITY_HEADERS,
  });
  if (head) return res.end();
  fs.createReadStream(full).pipe(res);
}

/* Файл по короткой ссылке. Отличается от sendFile тем, что HTML-страницу можно
   показать в рамке внутри приложения: без X-Frame-Options и с «песочницей» в
   заголовке — чужие скрипты из загруженного файла не достанут до сервиса. */
function sendSharedFile(res, full, { name, head = false } = {}) {
  const stat = fs.statSync(full);
  if (!stat.isFile()) return sendError(res, 404, 'Не найдено');
  const ext = path.extname(full).toLowerCase();
  const page = ext === '.html' || ext === '.htm';
  const fileName = name || path.basename(full);
  const headers = {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': stat.size,
    'Content-Disposition': `${page ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(fileName)}`,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  };
  if (page) headers['Content-Security-Policy'] = PAGE_SANDBOX_CSP;
  res.writeHead(200, headers);
  if (head) return res.end();
  fs.createReadStream(full).pipe(res);
}

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = decodeURIComponent(url.pathname);
  const method = req.method || 'GET';

  /* Ссылка для внешних приложений (Word, Excel, PowerPoint): у них нет cookie
     браузера, поэтому доступ даёт короткий адрес со своим сроком жизни. */
  if (pathname.startsWith(OPEN_PREFIX)) {
    if (method !== 'GET' && method !== 'HEAD') return sendError(res, 405, 'Метод не разрешён');
    const id = pathname.split('/').filter(Boolean)[1];
    const link = resolveOpenLink(id);
    if (!link) return sendError(res, 403, 'Ссылка на файл устарела — откройте его ещё раз');
    const project = store.getProject(link.projectId);
    if (!project) return sendError(res, 404, 'Файл не найден');
    try {
      const full = resolveSafe(store.workspaceDir(project.id), link.relPath);
      if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return sendError(res, 404, 'Файл не найден');
      return sendSharedFile(res, full, {
        name: asciiFileName(path.basename(full)),
        head: method === 'HEAD',
      });
    } catch (error) {
      return sendError(res, error.status || 400, error.message);
    }
  }

  if (!pathname.startsWith('/api/')) {
    if (method !== 'GET' && method !== 'HEAD') return sendError(res, 405, 'Метод не разрешён');
    return serveStatic(req, res, pathname, url.searchParams.has('v'));
  }

  const parts = pathname.split('/').filter(Boolean); // ['api', ...]

  try {
    // --- публичные ---
    if (pathname === '/api/login' && method === 'POST') return await handleLogin(req, res);
    if (pathname === '/api/auth-config' && method === 'GET') {
      return sendJson(res, 200, { signupOpen: SIGNUP.open });
    }
    if (pathname === '/api/signup' && method === 'POST') return await handleSignup(req, res);
    if (pathname === '/api/logout' && method === 'POST') {
      const cookies = parseCookies(req.headers.cookie);
      if (cookies[SESSION.cookie]) store.dropSession(sessionKey(cookies[SESSION.cookie]));
      return sendJson(res, 200, { ok: true }, { 'Set-Cookie': clearSessionCookie(TRUST_PROXY) });
    }
    if (pathname === '/api/version' && method === 'GET') {
      /* Версия статики. Открытая вкладка сравнивает её сама и обновляется,
         когда на сервере выложили новую сборку — без F5 у человека. */
      return sendJson(res, 200, { version: assetVersion() }, { 'Cache-Control': 'no-store' });
    }
    if (pathname === '/api/health' && method === 'GET') {
      /* сколько устройств аккаунт держит одновременно — видно, что ноутбук,
         браузер телефона и его ярлык работают параллельно, не выбивая друг друга */
      return sendJson(res, 200, {
        ok: true,
        time: nowIso(),
        sessions: { max: sessionLimit() },
        docs: await docEngines(),
        skills: listSkills().length,
      });
    }

    // --- требуется вход ---
    const user = requireUser(req, res);
    if (!user) return;

    if (pathname === '/api/me' && method === 'GET') return sendJson(res, 200, bootstrapPayload(user));
    if (pathname === '/api/bootstrap' && method === 'GET') return sendJson(res, 200, bootstrapPayload(user));

    if (pathname === '/api/transcribe' && method === 'POST') {
      const gate = transcribeHits.check(user.id);
      if (!gate.ok) {
        return sendError(res, 429, `Слишком много записей. Повторите через ${Math.ceil(gate.retryAfterMs / 60000)} мин.`);
      }
      const format = String(req.headers['x-audio-format'] || 'wav').toLowerCase() === 'mp3' ? 'mp3' : 'wav';
      const audio = await readBody(req, LIMITS.transcribeBody);
      if (!audio.length) return sendError(res, 400, 'Пустая запись');
      transcribeHits.hit(user.id);
      const result = await transcribeAudio({ buffer: audio, format });
      return sendJson(res, 200, { text: result.text });
    }

    if (pathname === '/api/proofread' && method === 'POST') {
      const gate = proofreadHits.check(user.id);
      if (!gate.ok) {
        return sendError(res, 429, `Слишком много проверок. Повторите через ${Math.ceil(gate.retryAfterMs / 60000)} мин.`);
      }
      const body = await readJsonBody(req);
      const text = String(body.text || '');
      if (!text.trim()) return sendError(res, 400, 'Пустой текст');
      if (text.length > LIMITS.proofreadChars) {
        return sendError(res, 413, `Текст длиннее ${LIMITS.proofreadChars} символов`);
      }
      proofreadHits.hit(user.id);
      const result = await proofreadText(text);
      return sendJson(res, 200, result);
    }

    if (pathname === '/api/projects' && method === 'POST') {
      const body = await readJsonBody(req);
      const name = String(body.name || '').trim() || 'Новый проект';
      const workflowId = body.workflowId ? String(body.workflowId) : null;
      try {
        const project = store.createProject({ ownerId: user.id, name, workflowId });
        return sendJson(res, 200, { project: { ...project, chats: [] } });
      } catch (error) {
        return sendError(res, error.status || 400, error.message);
      }
    }

    if (pathname === '/api/workflows' && method === 'POST') {
      const body = await readJsonBody(req);
      const name = String(body.name || '').trim();
      if (!name) return sendError(res, 400, 'Укажите название папки проектов');
      const workflow = store.createWorkflow({ ownerId: user.id, name });
      return sendJson(res, 200, { workflow });
    }

    if (parts[1] === 'workflows' && parts[2] && parts.length === 3) {
      const workflow = store.getWorkflow(parts[2], user.id);
      if (!workflow) return sendError(res, 404, 'Папка проектов не найдена');
      if (method === 'PATCH') {
        const body = await readJsonBody(req);
        const updated = store.renameWorkflow(parts[2], body.name, user.id);
        return sendJson(res, 200, { workflow: updated });
      }
      if (method === 'DELETE') {
        const projects = store.projectsFor(user.id).filter((p) => p.workflowId === parts[2]);
        store.deleteWorkflow(parts[2], user.id);
        return sendJson(res, 200, { ok: true, movedProjects: projects.map((p) => p.id) });
      }
      return sendError(res, 405, 'Метод не разрешён');
    }

    if (parts[1] === 'projects' && parts[2]) {
      const project = projectOr404(res, user, parts[2]);
      if (!project) return;
      const workspace = store.workspaceDir(project.id);

      if (parts.length === 3 && method === 'GET') {
        return sendJson(res, 200, { project: { ...project, chats: store.chatsFor(project.id).map(chatMeta) } });
      }
      if (parts.length === 3 && method === 'PATCH') {
        const body = await readJsonBody(req);
        let updated = project;
        if (body.name !== undefined) {
          updated = store.renameProject(project.id, body.name) || updated;
        }
        if (body.workflowId !== undefined) {
          try {
            updated = store.setProjectWorkflow(project.id, body.workflowId || null, user.id) || updated;
          } catch (error) {
            return sendError(res, error.status || 400, error.message);
          }
        }
        return sendJson(res, 200, { project: updated });
      }
      if (parts.length === 3 && method === 'DELETE') {
        store.deleteProject(project.id);
        return sendJson(res, 200, { ok: true });
      }
      if (parts[3] === 'chats' && parts.length === 4 && method === 'GET') {
        return sendJson(res, 200, { chats: store.chatsFor(project.id).map(chatMeta) });
      }
      if (parts[3] === 'chats' && parts.length === 4 && method === 'POST') {
        const body = await readJsonBody(req);
        const chat = store.createChat({ projectId: project.id, ownerId: user.id, title: body.title });
        return sendJson(res, 200, { chat: chatMeta(chat) });
      }
      if (parts[3] === 'files' && method === 'GET') {
        const rel = url.searchParams.get('path') || '.';
        const depth = Number(url.searchParams.get('depth') || 4);
        try {
          const items = listTree(workspace, rel, { depth });
          return sendJson(res, 200, { path: rel, items });
        } catch (error) {
          return sendError(res, 400, error.message);
        }
      }
      if (parts[3] === 'preview' && method === 'GET') {
        // Просмотр HTML-страницы проекта (лендинг и т.п.) в отдельной вкладке.
        const rel = url.searchParams.get('path') || 'index.html';
        try {
          const full = resolveSafe(workspace, rel);
          if (!/\.html?$/i.test(full) || !fs.existsSync(full) || !fs.statSync(full).isFile()) {
            return sendError(res, 404, 'Страница не найдена');
          }
          const html = fs.readFileSync(full);
          res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
            // Изолируем страницу: чужие скрипты и внешние ресурсы работают, доступа к сессии нет.
            'Content-Security-Policy':
              "sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads; default-src * data: blob: 'unsafe-inline' 'unsafe-eval'; img-src * data: blob:; style-src * 'unsafe-inline'; script-src * 'unsafe-inline' 'unsafe-eval'; font-src * data:",
          });
          return res.end(html);
        } catch (error) {
          return sendError(res, 400, error.message);
        }
      }
      if (parts[3] === 'file' && method === 'GET') {
        const rel = url.searchParams.get('path') || '';
        try {
          const full = resolveSafe(workspace, rel);
          const download = url.searchParams.get('download') === '1';
          return sendFile(res, full, { download, name: path.basename(full) });
        } catch (error) {
          return sendError(res, 400, error.message);
        }
      }
      if (parts[3] === 'file-preview' && method === 'GET') {
        /* Просмотр файла прямо в приложении. Сервер отдаёт не «плоский текст»,
           а структуру документа (заголовки, абзацы с выделением, таблицы,
           листы, слайды) — её и рисует окно просмотра. Поле text оставлено для
           совместимости и для тех файлов, которые разобрать не удалось. */
        const rel = url.searchParams.get('path') || '';
        try {
          const full = resolveSafe(workspace, rel);
          if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return sendError(res, 404, 'Файл не найден');
          const name = path.basename(full);
          const stat = fs.statSync(full);
          const kind = detectKind(name);
          const base = { name, path: rel, size: stat.size, kind, kindLabel: kindLabel(kind) };
          if (stat.size > 25 * 1024 * 1024) {
            return sendJson(res, 200, {
              ...base,
              format: 'other',
              text: '',
              warnings: ['Файл больше 25 МБ — просмотр недоступен, скачайте его.'],
            });
          }
          const buf = fs.readFileSync(full);
          const preview = previewDocument(buf, name, { maxRows: 400, maxChars: 200000 });
          if (preview) return sendJson(res, 200, { ...base, ...preview, name, path: rel, size: stat.size });
          /* Незнакомый формат: пробуем вытащить хотя бы текст. */
          const { text, warnings } = extractDocumentText(buf, name, '', { maxRows: 500, maxChars: 200000 });
          return sendJson(res, 200, {
            ...base,
            format: 'other',
            text,
            warnings: warnings || [],
          });
        } catch (error) {
          return sendError(res, 400, error.message);
        }
      }
      if (parts[3] === 'file-page' && method === 'GET') {
        /* HTML открываем как настоящую страницу в рамке. Ссылки на соседние
           файлы проекта заменяем короткими адресами: страница живёт в песочнице
           без доступа к сессии, поэтому по обычным путям её ресурсы не открылись
           бы. */
        const rel = url.searchParams.get('path') || '';
        try {
          const full = resolveSafe(workspace, rel);
          const ext = path.extname(full).toLowerCase();
          if (ext !== '.html' && ext !== '.htm') return sendError(res, 400, 'Это не HTML-страница');
          if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return sendError(res, 404, 'Файл не найден');
          const stat = fs.statSync(full);
          if (stat.size > 6 * 1024 * 1024) return sendError(res, 413, 'Страница больше 6 МБ — откройте её скачиванием');
          const source = fs.readFileSync(full, 'utf8');
          const origin = publicOrigin(req);
          const dir = path.posix.dirname(rel.replace(/\\/g, '/'));
          let issued = 0;
          const rewrite = (raw) => {
            const ref = String(raw || '').trim();
            if (!ref || issued > 40) return raw;
            if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(ref)) return raw;
            const cut = ref.search(/[?#]/);
            const clean = cut >= 0 ? ref.slice(0, cut) : ref;
            const tail = cut >= 0 ? ref.slice(cut) : '';
            if (!clean) return raw;
            const target = clean.startsWith('/')
              ? clean.replace(/^\/+/, '')
              : path.posix.normalize(path.posix.join(dir === '.' ? '' : dir, clean));
            if (!target || target.startsWith('..')) return raw;
            try {
              const asset = resolveSafe(workspace, target);
              if (!fs.existsSync(asset) || !fs.statSync(asset).isFile()) return raw;
              issued += 1;
              const id = issueOpenLink({ projectId: project.id, relPath: target });
              return `${origin}/o/${id}/${asciiFileName(path.basename(asset))}${tail}`;
            } catch {
              return raw;
            }
          };
          const body = source.replace(/\b(src|href|poster)\s*=\s*("([^"]*)"|'([^']*)')/gi, (whole, attr, quoted, dq, sq) => {
            const value = dq !== undefined ? dq : sq;
            const next = rewrite(value);
            if (next === value) return whole;
            return `${attr}="${next.replace(/"/g, '&quot;')}"`;
          });
          const buf = Buffer.from(body, 'utf8');
          res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Content-Length': buf.length,
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
            'Referrer-Policy': 'no-referrer',
            'Content-Security-Policy': PAGE_SANDBOX_CSP,
          });
          return res.end(buf);
        } catch (error) {
          return sendError(res, 400, error.message);
        }
      }
      if (parts[3] === 'file' && method === 'DELETE') {
        const rel = url.searchParams.get('path') || '';
        try {
          const full = resolveSafe(workspace, rel);
          if (full === path.resolve(workspace)) return sendError(res, 400, 'Нельзя удалить корень');
          fs.rmSync(full, { recursive: true, force: true });
          return sendJson(res, 200, { ok: true });
        } catch (error) {
          return sendError(res, 400, error.message);
        }
      }
      if (parts[3] === 'upload' && method === 'POST') {
        const rawName = decodeURIComponent(String(req.headers['x-filename'] || 'file'));
        const target = url.searchParams.get('path') || `uploads/${safeName(rawName)}`;
        const full = resolveSafe(workspace, target);
        if (!(await ensureDiskRoom(res, Number(req.headers['content-length'] || 0)))) return;
        const size = await receiveToFile(req, LIMITS.maxAttachmentBytes, full);
        if (!size) {
          await fs.promises.rm(full, { force: true }).catch(() => {});
          return sendError(res, 400, 'Пустой файл');
        }
        return sendJson(res, 200, { path: target.replace(/\\/g, '/'), size });
      }
      if (parts[3] === 'download') {
        // Экспорт проекта одним архивом
        if (method !== 'GET') return sendError(res, 405, 'Метод не разрешён');
        const files = [];
        const walk = (dir, rel) => {
          for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (entry.name.startsWith('.')) continue;
            const full = path.join(dir, entry.name);
            const relName = rel ? `${rel}/${entry.name}` : entry.name;
            if (entry.isDirectory()) walk(full, relName);
            else files.push({ name: relName, path: full });
          }
        };
        walk(workspace, '');
        res.writeHead(200, {
          'Content-Type': 'application/zip',
          'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(`${project.name}.zip`)}`,
          ...SECURITY_HEADERS,
        });
        return await pipeZip(res, files);
      }
    }

    if (parts[1] === 'chats' && parts[2]) {
      const chat = chatScopeOr404(res, user, parts[2]);
      if (!chat) return;
      if (parts.length === 3 && method === 'GET') {
        const attachments = Object.values(store.state.attachments)
          .filter((att) => att.chatId === chat.id)
          .map(serializeAttachment);
        return sendJson(res, 200, {
          chat: {
            id: chat.id,
            projectId: chat.projectId,
            title: chat.title,
            messages: chat.messages,
            attachments,
            /* Если в диалоге идёт работа, вкладка сразу подключится к ней. */
            run: liveRunForChat(user.id, chat.id) ? publicRun(liveRunForChat(user.id, chat.id)) : null,
          },
        });
      }
      if (parts.length === 3 && method === 'PATCH') {
        const body = await readJsonBody(req);
        return sendJson(res, 200, { chat: store.renameChat(chat.id, body.title) });
      }
      if (parts.length === 3 && method === 'DELETE') {
        store.deleteChat(chat.id);
        return sendJson(res, 200, { ok: true });
      }
      if (parts[3] === 'messages' && method === 'POST') {
        return await handleMessageStream(req, res, user, chat.id);
      }
    }

    /* ---- живые задачи ----
       Задача живёт на сервере, поэтому её можно найти, догнать и остановить
       независимо от того, какая вкладка её запустила. */
    if (pathname === '/api/runs' && method === 'GET') {
      return sendJson(res, 200, { runs: activeRunsFor(user.id) });
    }
    if (parts[1] === 'runs' && parts[2]) {
      const run = runs.get(parts[2]);
      if (!run || run.userId !== user.id) return sendError(res, 404, 'Задача не найдена');
      if (parts.length === 3 && method === 'GET') return sendJson(res, 200, { run: publicRun(run) });
      if (parts[3] === 'stream' && method === 'GET') return attachRun(res, run);
      if (parts[3] === 'stop' && method === 'POST') {
        if (run.status !== 'running') return sendJson(res, 200, { ok: true, status: run.status });
        /* Останавливает человек, а не обрыв связи: прерываем работу агента,
           а вкладки получат событие «end» и покажут сохранённый ответ. */
        run.stoppedBy = user.id;
        run.controller.abort();
        return sendJson(res, 200, { ok: true, status: 'stopping' });
      }
    }

    if (pathname === '/api/attachments' && method === 'POST') return await handleUpload(req, res, user);

    if (parts[1] === 'attachments' && parts[2] && method === 'GET') {
      const att = store.getAttachment(parts[2]);
      if (!att || att.ownerId !== user.id) return sendError(res, 404, 'Файл не найден');
      return sendJson(res, 200, { attachment: serializeAttachment(att) });
    }
    if (parts[1] === 'attachments' && parts[2] && method === 'DELETE') {
      const att = store.getAttachment(parts[2]);
      if (!att || att.ownerId !== user.id) return sendError(res, 404, 'Файл не найден');
      try {
        fs.rmSync(resolveSafe(store.workspaceDir(att.projectId), att.relPath), { force: true });
      } catch {
        /* ignore */
      }
      store.deleteAttachment(att.id);
      return sendJson(res, 200, { ok: true });
    }

    if (pathname === '/api/search' && method === 'GET') {
      const q = String(url.searchParams.get('q') || '').trim();
      if (!q) return sendJson(res, 200, { results: [] });
      const results = await webSearch(q, 6);
      return sendJson(res, 200, { results });
    }

    /* ---------------- администратор ---------------- */
    if (pathname === '/api/admin/users' && method === 'GET') {
      const admin = requireAdmin(req, res);
      if (!admin) return;
      return sendJson(res, 200, { users: store.users().map((u) => ({ ...u, usage: store.usageSummary(u.id) })) });
    }
    if (pathname === '/api/admin/users' && method === 'POST') {
      const admin = requireAdmin(req, res);
      if (!admin) return;
      const body = await readJsonBody(req);
      const username = String(body.username || '').trim();
      const problem = usernameProblem(username) || passwordProblem(body.password);
      if (problem) return sendError(res, 400, problem);
      const role = body.role === 'admin' ? 'admin' : 'user';
      const hasCredit = body.creditUsd !== undefined && body.creditUsd !== null && body.creditUsd !== '';
      /* Стартовый баланс нового аккаунта: сколько указал администратор,
         иначе общая стартовая сумма из настроек. */
      const startCreditUsd = role === 'admin' ? 0 : hasCredit ? Number(body.creditUsd) : BILLING.migrationCreditUsd;
      if (!Number.isFinite(startCreditUsd) || startCreditUsd < 0 || startCreditUsd > 10000) {
        return sendError(res, 400, 'Некорректный стартовый баланс');
      }
      const created = store.createUser({
        username,
        password: String(body.password),
        displayName: String(body.displayName || username).slice(0, 80),
        role,
        startCreditUsd,
      });
      return sendJson(res, 200, { user: created });
    }
    if (parts[1] === 'admin' && parts[2] === 'users' && parts[3]) {
      const admin = requireAdmin(req, res);
      if (!admin) return;
      const target = store.getUser(parts[3]);
      if (!target) return sendError(res, 404, 'Пользователь не найден');
      if (parts[4] === 'credit' && method === 'POST') {
        const body = await readJsonBody(req);
        const amount = Number(body.usd);
        if (!Number.isFinite(amount) || Math.abs(amount) < 0.01) {
          return sendError(res, 400, 'Укажите сумму в долларах');
        }
        if (Math.abs(amount) > 10000) return sendError(res, 400, 'Слишком большая сумма');
        const updated = store.grantCredit(target.id, amount);
        return sendJson(res, 200, { user: updated });
      }
      if (method === 'PATCH') {
        const body = await readJsonBody(req);
        const patch = {};
        if (body.password) {
          const problem = passwordProblem(body.password);
          if (problem) return sendError(res, 400, problem);
          patch.password = String(body.password);
        }
        if (body.displayName !== undefined) patch.displayName = String(body.displayName).slice(0, 80);
        if (body.disabled !== undefined) patch.disabled = Boolean(body.disabled);
        if (body.role && target.id !== admin.id) patch.role = body.role;
        const updated = store.updateUser(target.id, patch);
        return sendJson(res, 200, { user: updated });
      }
      if (method === 'DELETE') {
        if (target.id === admin.id) return sendError(res, 400, 'Нельзя удалить свою учётную запись');
        store.deleteUser(target.id);
        return sendJson(res, 200, { ok: true });
      }
    }
    if (pathname === '/api/account/password' && method === 'POST') {
      const body = await readJsonBody(req);
      if (!store.checkPassword(user, String(body.current || ''))) {
        return sendError(res, 400, 'Текущий пароль неверен');
      }
      const problem = passwordProblem(body.next);
      if (problem) return sendError(res, 400, problem);
      store.updateUser(user.id, { password: String(body.next) });
      return sendJson(res, 200, { ok: true });
    }
    if (pathname === '/api/memory' && method === 'GET') {
      return sendJson(res, 200, { facts: store.memoryFacts(user.id) });
    }
    if (pathname === '/api/memory' && method === 'POST') {
      const body = await readJsonBody(req);
      const text = String(body.text || body.fact || '').trim();
      if (!text) return sendError(res, 400, 'Пустая формулировка');
      if (text.length > 400) return sendError(res, 400, 'Слишком длинно: до 400 символов');
      const outcome = store.addMemoryFact(user.id, text);
      return sendJson(res, 200, { ...outcome, facts: store.memoryFacts(user.id) });
    }
    if (pathname === '/api/memory' && method === 'DELETE') {
      const body = await readJsonBody(req);
      if (body.id) {
        const outcome = store.removeMemoryFact(user.id, String(body.id));
        return sendJson(res, 200, { ...outcome, facts: store.memoryFacts(user.id) });
      }
      store.clearMemory(user.id);
      return sendJson(res, 200, { ok: true, facts: [] });
    }
    if (pathname === '/api/admin/stats' && method === 'GET') {
      const admin = requireAdmin(req, res);
      if (!admin) return;
      return sendJson(res, 200, { overview: store.overview(), keys: keyStatus() });
    }
    /* Сколько места дано сервису и сколько занято: сторож места проверяет это раз в неделю. */
    if (pathname === '/api/admin/sessions' && method === 'GET') {
      const admin = requireAdmin(req, res);
      if (!admin) return;
      return sendJson(res, 200, sessionsReport());
    }
    if (pathname === '/api/admin/storage' && method === 'GET') {
      const admin = requireAdmin(req, res);
      if (!admin) return;
      return sendJson(res, 200, await storageReport());
    }
    if (pathname === '/api/admin/approvals' && method === 'GET') {
      const admin = requireAdmin(req, res);
      if (!admin) return;
      return sendJson(res, 200, { approvals: store.approvals({ limit: 100 }), stepUsd: BUDGET.stepUsd });
    }
    if (parts[1] === 'admin' && parts[2] === 'approvals' && parts[3] && method === 'POST') {
      const admin = requireAdmin(req, res);
      if (!admin) return;
      const approval = store.getApproval(parts[3]);
      if (!approval) return sendError(res, 404, 'Запрос не найден');
      const project = store.getProject(approval.projectId);
      if (!project) return sendError(res, 404, 'Проект не найден');
      const body = await readJsonBody(req);
      const approve = body.action !== 'reject';
      /* Одобрение поднимает порог для задачи: столько, сколько она уже стоила, плюс шаг.
         Отклонение порог не меняет — мелкие задачи в проекте должны работать дальше. */
      const budgetUsd = approve ? Number(approval.spentUsd || 0) + BUDGET.stepUsd : null;
      const updated = store.decideApproval(approval.id, approve ? 'approved' : 'rejected', {
        by: admin.username,
        budgetUsd,
      });
      return sendJson(res, 200, { approval: updated, budgetUsd });
    }

    sendError(res, 404, 'Не найдено');
  } catch (error) {
    if (res.headersSent) {
      try {
        res.end();
      } catch {
        /* ignore */
      }
      return;
    }
    const status = error?.status || 500;
    if (status >= 500) console.error('[server]', error);
    sendError(res, status, status >= 500 ? 'Внутренняя ошибка сервера' : error.message);
  }
}

const server = http.createServer((req, res) => {
  route(req, res).catch((error) => {
    console.error('[server]', error);
    if (!res.headersSent) sendError(res, 500, 'Внутренняя ошибка сервера');
  });
});

server.requestTimeout = 0;
server.headersTimeout = 65000;
server.keepAliveTimeout = 61000;

server.listen(PORT, HOST, () => {
  const address = `http://${HOST}:${PORT}`;
  console.log('');
  console.log('  Рабочее пространство запущено');
  console.log(`  Адрес:  ${address}`);
  console.log(`  Данные: ${DATA_DIR}`);
  console.log(`  Режим:  ${TRUST_PROXY ? 'за прокси (облако)' : 'локальный'}`);
  console.log('');
});

process.on('SIGINT', () => {
  console.log('\nОстановка…');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
});
