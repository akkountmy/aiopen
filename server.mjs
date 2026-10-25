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
import {
  DASHBOARD_FILES_SUBDIR,
  DASHBOARD_LIMITS,
  DASHBOARD_TZ,
  dashboardBlock,
  dashboardDocsBlock,
  scheduleText,
} from './src/dashboard.mjs';
import { transcribeAudio } from './src/asr.mjs';
import { detectKind, extractDocumentText, kindLabel } from './src/docparse.mjs';
import { previewDocument } from './src/docpreview.mjs';
import { projectFilesBrief } from './src/filebrief.mjs';
import { buildProjectContext } from './src/projectcontext.mjs';
import { BACKUP_DEFAULTS, backupsDir, listBackups, snapshotState, startAutoBackup } from './src/backup.mjs';
import { docEngines } from './src/doc/index.mjs';
import { approvalMessage, notifyAdmin, suspicionMessage } from './src/notify.mjs';
import { issueOpenLink, resolveOpenLink, asciiFileName, OPEN_PREFIX } from './src/openlink.mjs';
import { clearPresence, isUserActive, touchPresence } from './src/presence.mjs';
import { proofreadText } from './src/proofread.mjs';
import { classifyCompletion } from './src/pushpolicy.mjs';
import {
  forgetUser as pushForgetUser,
  pushState,
  pushTargets,
  pushToUser,
  pushToUsers,
  reportDevice as pushReportDevice,
  subscribe as pushSubscribe,
  unsubscribe as pushUnsubscribe,
} from './src/push.mjs';
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
import { nowIso, safeName, uid, uniqueFileName } from './src/util.mjs';
import { describeImage } from './src/vision.mjs';
import { webSearch } from './src/search.mjs';
import { describeTrim } from './src/trim.mjs';
import { describeProfile } from './src/model.mjs';
import { describeReview } from './src/review.mjs';

ensureDirs();
store.init({ adminUsername: ADMIN.username, adminPassword: ADMIN.password });

const loginIpHits = new RateLimiter({ windowMs: SECURITY.loginWindowMs, max: SECURITY.loginMaxPerIp });
const loginUserHits = new RateLimiter({ windowMs: SECURITY.loginWindowMs, max: SECURITY.loginMaxPerUser });
const transcribeHits = new RateLimiter({ windowMs: 60 * 60 * 1000, max: 120 });
const proofreadHits = new RateLimiter({ windowMs: 60 * 60 * 1000, max: 240 });
const signupHits = new RateLimiter({ windowMs: 60 * 60 * 1000, max: SIGNUP.maxPerIpPerHour });
/* Идущие ответы: ключ — «пользователь:диалог». Один и тот же диалог не может
   генерироваться дважды (иначе сообщения перепутаются), но разные диалоги
   считаются независимо — так ноутбук и телефон работают параллельно. Потолка на
   аккаунт нет: LIMITS.agentConcurrencyPerUser = 0 значит «сколько угодно». */
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
    reasoning: run.reasoning,
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
    reasoning: '',
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
  else if (data.type === 'reasoning') run.reasoning = (run.reasoning + (data.text || '')).slice(-24000);
  else if (data.type === 'tool') {
    const known = run.tools.find((tool) => tool.id === data.id);
    if (known) Object.assign(known, data);
    else run.tools.push({ id: data.id, name: data.name || '', label: data.label, summary: data.summary, status: data.status });
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
    store.saveChat(chat.id, { messages: chat.messages, history: chat.history, memory: chat.memory, task: chat.task || null });
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

/** Сколько мест у аккаунта: 0 — без ограничений (штатный режим, см. config).
 *  Числа мест нет, поэтому отдаём пару «потолок + признак безлимита». */
function sessionSeats() {
  const limit = sessionLimit();
  return { max: Number.isFinite(limit) ? limit : 0, unlimited: !Number.isFinite(limit) };
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
    /* Сколько устройств аккаунт держит одновременно. Сейчас — сколько угодно:
       сеансы не выбивают друг друга, тип устройства здесь справочный. */
    seats: sessionSeats().max,
    seatsUnlimited: sessionSeats().unlimited,
    sessions,
    kicked,
    audit,
  };
}

/* Адрес клиента за прокси. Берём последний хоп X-Forwarded-For — его дописывает
   наш прокси, а всё, что левее, приходит от клиента и подделывается тривиально:
   с первым хопом лимит входов на адрес обходился одним заголовком. */
function clientIp(req) {
  if (TRUST_PROXY) {
    const chain = String(req.headers['x-forwarded-for'] || '')
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean);
    if (chain.length) return chain[chain.length - 1];
    const real = String(req.headers['x-real-ip'] || '').trim();
    if (real) return real;
  }
  return req.socket.remoteAddress || '';
}

/* Декодирование того, что пришло от клиента. `decodeURIComponent('%')` бросает
   исключение, и раньше такой заголовок или путь давал 500 вместо понятного
   ответа; битую строку возвращаем как есть — её отбракует проверка имени. */
function tryDecode(value) {
  const text = String(value ?? '');
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
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
      return sendJson(
        res,
        401,
        {
          error:
            'Этот сеанс закрыт — войдите снова. Так бывает после смены пароля, ' +
            'выхода на этой машине или нового входа в этом же браузере.',
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
const DEFAULT_PUBLIC_ORIGIN = 'https://dshopen-vladimir00177.msk1.amvera.tech';
const PUBLIC_HOST_RE = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::\d{1,5})?$/i;

/* Адрес сервиса для ссылок, которые уходят наружу (Telegram, Word/Excel).
   За прокси хост приходит заголовком, и подставить туда чужой домен может любой
   клиент — тогда короткая ссылка на файл проекта уводила бы в чужой домен.
   Поэтому при работе за прокси берём только явно настроенный адрес. */
function publicOrigin(req) {
  const configured = String(process.env.DSHOW_PUBLIC_URL || '').trim();
  if (configured) return configured.replace(/\/+$/, '');
  if (!TRUST_PROXY) {
    const rawHost = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
    if (PUBLIC_HOST_RE.test(rawHost)) {
      const rawProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
      const proto = rawProto === 'https' ? 'https' : rawProto === 'http' ? 'http' : req.socket?.encrypted ? 'https' : 'http';
      return `${proto}://${rawHost}`;
    }
  }
  return DEFAULT_PUBLIC_ORIGIN;
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

/* Текст уведомления: markdown-разметку убираем, длинные ответы обрезаем —
   в центре уведомлений помещается две строки, остальное человек прочитает
   в приложении. */
function pushSnippet(text, limit = 160) {
  const flat = String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[#*_`>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!flat) return '';
  return flat.length > limit ? `${flat.slice(0, limit - 1).trimEnd()}…` : flat;
}

/**
 * Уведомление в ярлык-приложение о конце работы. Уходит только по сложным
 * задачам и только когда человек не работает в сервисе: если приложение
 * открыто на экране, ответ и так виден в диалоге, а пуш на телефон в этот
 * момент — лишнее беспокойство.
 *
 * Отметки видимости приходят от вкладок; небольшая пауза перед решением нужна,
 * чтобы сигнал «свернул» успел дойти, если задача закончилась ровно в этот
 * момент. Сервис-воркер дополнительно не показывает уведомление на том
 * устройстве, где окно на экране.
 */
const COMPLETION_PUSH_DELAY_MS = 1200;

function notifyRunPush({
  user,
  project,
  chat,
  run = null,
  status,
  text = '',
  errorText = '',
  approval = null,
  outcome = null,
}) {
  if (!user?.id || status === 'stopped') return;
  const decision = classifyCompletion({
    outcome,
    durationMs: run?.startedMs ? Date.now() - run.startedMs : 0,
    tools: run?.tools || [],
    approval,
    background: run?.source === 'dashboard',
  });
  if (!decision.complex) {
    console.log(`[push] dialog ${chat?.id || '?'}: обычная задача, уведомление не нужно`);
    return;
  }
  const chatTitle = chat?.title && chat.title !== 'Новый диалог' ? chat.title : '';
  const where = chatTitle || project?.name || 'DSH Open';
  const title = where;
  let body = '';
  let kind = status;
  if (approval) {
    kind = 'approval';
    body = 'Нужно подтверждение: задача приостановлена до ответа администратора.';
  } else if (status === 'error') {
    body = `Задача прервалась: ${pushSnippet(errorText, 120) || 'подробности в приложении'}`;
  } else {
    body = `Готово: ${pushSnippet(text, 150) || 'задача выполнена'}`;
  }
  const url = chat?.id ? `/?chat=${encodeURIComponent(chat.id)}` : '/';
  const send = () => {
    /* Человек вернулся в сервис, пока мы ждали сигнал, — не отвлекаем. */
    if (isUserActive(user.id)) {
      console.log(`[push] dialog ${chat?.id || '?'}: человек в сервисе, уведомление не отправляем`);
      return;
    }
    pushToUser(user.id, {
      title,
      body,
      url,
      kind,
      chatId: chat?.id || null,
      projectId: project?.id || null,
      tag: chat?.id ? `chat-${chat.id}` : 'dsh',
      /* Воркер не показывает такое уведомление, если окно на экране. */
      onlyWhenAway: true,
    }).catch((error) => console.warn('[push] отправка не удалась:', error?.message || error));
  };
  if (approval) {
    send();
    return;
  }
  const timer = setTimeout(send, COMPLETION_PUSH_DELAY_MS);
  timer.unref?.();
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
  const rawName = tryDecode(String(req.headers['x-filename'] || 'file'));
  const projectId = String(req.headers['x-project-id'] || '');
  const project = store.getProject(projectId, user.id);
  if (!project) return sendError(res, 404, 'Проект не найден');
  /* Диалог приходит заголовком: без проверки в чужую переписку можно было
     подложить свой файл (и он появился бы у другого человека в ленте). */
  let chatId = String(req.headers['x-chat-id'] || '') || null;
  if (chatId) {
    const chat = store.getChat(chatId, user.id);
    if (!chat || chat.projectId !== project.id) chatId = null;
  }
  const mime = String(req.headers['content-type'] || 'application/octet-stream');
  const id = uid('a_');
  const cleanName = safeName(rawName).slice(0, 120) || 'file';
  /* Вложение из диалога лежит в той же общей папке проекта, что и файлы из
     панели: отдельной папки uploads больше нет, а одинаковые имена не
     затирают друг друга. */
  const workspaceDir = store.workspaceDir(project.id);
  const relPath = uniqueFileName(workspaceDir, cleanName);
  const full = resolveSafe(workspaceDir, relPath);
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

/* ---- документы задания «Дашборда» ----
   Файлы живут рядом с данными приложения, а не в проекте: проект отчёта можно
   сменить, материалы при этом остаются. Текст вынимаем сразу при загрузке —
   во время запуска ждать разбор уже некогда. */
async function handleDashboardFileUpload(req, res, user, task) {
  const current = Array.isArray(task.files) ? task.files : [];
  if (current.length >= DASHBOARD_LIMITS.maxFiles) {
    return sendError(res, 400, `К одному заданию можно приложить не больше ${DASHBOARD_LIMITS.maxFiles} документов`);
  }
  const rawName = tryDecode(String(req.headers['x-filename'] || 'документ'));
  const name = safeName(rawName).slice(0, 160) || 'документ';
  const mime = String(req.headers['content-type'] || 'application/octet-stream');
  const id = uid('df_');
  const dir = store.dashboardFilesDir(task.id);
  fs.mkdirSync(dir, { recursive: true });
  const relPath = `${id}-${name}`;
  const full = path.join(dir, relPath);
  if (!(await ensureDiskRoom(res, Number(req.headers['content-length'] || 0)))) return;
  const size = await receiveToFile(req, LIMITS.maxAttachmentBytes, full);
  if (!size) {
    fs.rmSync(full, { force: true });
    return sendError(res, 400, 'Пустой файл');
  }
  const kind = detectKind(name, mime);
  let text = '';
  let warnings = [];
  try {
    if (kind === 'image') {
      const described = await describeImage({ buffer: fs.readFileSync(full), mime, name });
      text = String(described?.text || '');
    } else if (Number(size) <= LIMITS.maxParseBytes) {
      const parsed = extractDocumentText(fs.readFileSync(full), name, mime, {
        maxChars: DASHBOARD_LIMITS.filesContextChars,
      });
      text = String(parsed.text || '');
      warnings = Array.isArray(parsed.warnings) ? parsed.warnings : [];
    } else {
      warnings = [
        `Файл больше ${Math.round(LIMITS.maxParseBytes / 1024 / 1024)} МБ — сохранён, но текст автоматически не извлекался.`,
      ];
    }
  } catch {
    warnings = ['Текст разобрать не удалось — агент откроет файл в проекте.'];
  }
  const textPath = text.trim() ? `${id}.txt` : '';
  if (textPath) {
    try {
      fs.writeFileSync(path.join(dir, textPath), text);
    } catch {
      /* без текста задание всё равно получит файл в проекте */
    }
  }
  const file = {
    id,
    name,
    size,
    mime,
    kind,
    relPath,
    textPath,
    warnings: warnings.slice(0, 2),
    createdAt: nowIso(),
  };
  const updated = store.addDashboardFile(task.id, user.id, file);
  if (!updated) {
    fs.rmSync(full, { force: true });
    if (textPath) fs.rmSync(path.join(dir, textPath), { force: true });
    return sendError(res, 400, 'Не удалось сохранить документ');
  }
  return sendJson(res, 200, { task: publicDashboardTask(updated, user) });
}

function handleDashboardFileDelete(res, user, task, fileId) {
  const removed = store.deleteDashboardFile(task.id, user.id, fileId);
  if (!removed) return sendError(res, 404, 'Документ не найден');
  const dir = store.dashboardFilesDir(task.id);
  try {
    fs.rmSync(path.join(dir, removed.relPath), { force: true });
    if (removed.textPath) fs.rmSync(path.join(dir, removed.textPath), { force: true });
  } catch {
    /* запись уже удалена — файл мог быть убран вручную */
  }
  return sendJson(res, 200, { task: publicDashboardTask(store.getDashboardTask(task.id, user.id), user) });
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
  /* Режимы ответа приходят с мобильного композера двумя независимыми
     флажками. Читаем и вложенный modes, и плоские поля — старый клиент,
     который про них не знает, просто не пришлёт ничего. */
  const modeSource = body.modes && typeof body.modes === 'object' ? body.modes : body;
  const modes = {
    thinking: modeSource.thinking === true,
    search: modeSource.search === true,
  };
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
  /* Потолка на одновременные ответы у аккаунта нет: диалоги независимы, и
     десяток вкладок может работать сразу. Предел включается только явной
     настройкой LIMITS.agentConcurrencyPerUser > 0 (например, для отладки). */
  const busy = runningByUser.get(user.id) || 0;
  if (LIMITS.agentConcurrencyPerUser > 0 && busy >= LIMITS.agentConcurrencyPerUser) {
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
    modes,
    isFirstMessage: chat.messages.length === 0,
  });
}

/* Сама работа. Живёт своей жизнью: её не останавливает закрытие вкладки, а все
   события складываются в запуск — подключиться и догнать можно в любой момент. */
async function executeRun(run, job) {
  const { user, project, chat } = run;
  const { text, attachmentIds, isFirstMessage, modes = { thinking: false, search: false } } = job;
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
    store.saveChat(chat.id, { messages: chat.messages, history: chat.history, memory: chat.memory, task: chat.task || null });

    const userText = [text, ctx.text].filter(Boolean).join('\n\n');
    stream.emit({ type: 'start' });

    /* Прошлые диалоги этого же проекта: короткая выжимка, чтобы новый разговор
       продолжал работу, а не начинался с чистого листа. Сбой здесь не должен
       ломать ход — контекст проекта вещь полезная, но не обязательная. */
    let projectContext = '';
    try {
      projectContext = buildProjectContext({
        chats: store.chatsFor(project.id),
        currentChatId: chat.id,
        load: (id) => store.getChat(id),
        question: userText,
      });
    } catch (error) {
      console.error('[context]', error?.message || error);
    }

    const outcome = await runTurn({
      workspace: store.workspaceDir(project.id),
      /* Передаём сам объект чата: runTurn дописывает историю и обновляет
         сводку-«память» при переполнении. Копия { history, memory } теряла
         новую память, и она не попадала в файл чата. */
      chat,
      projectName: project.name,
      userName: user.displayName || user.username,
      userText,
      projectContext,
      filesBrief,
      images: ctx.images,
      emit: stream.emit,
      signal: controller.signal,
      budget: user.role === 'admin' ? null : { limitUsd: projectLimit(project) },
      /* Постоянная память пользователя: факты подмешиваются в системное
         сообщение, remember пишет новые прямо в index.json. */
      facts: store.memoryFacts(user.id),
      remember: (fact) => store.addMemoryFact(user.id, fact),
      /* Кнопки «Рассуждения» и «Поиск» действуют на этот ход: первая сразу
         поднимает профиль модели, вторая добавляет в системную подсказку
         требование искать источники. */
      thinking: modes.thinking === true,
      search: modes.search === true,
    });

    assistantText = outcome.text || '';

    /* Что дала обрезка контекста в этом ходе: одна строка в лог, без записи
       отдельного файла — цифры нужны для понимания расходов, не для отчёта. */
    if (outcome.trim) {
      const trimLine = describeTrim(outcome.trim);
      if (trimLine) console.log(`[trim] dialog ${chat.id}: ${trimLine}`);
    }
    /* Класс задачи и результат проверки ответа: видно, почему ход ушёл на
       сильную модель и что нашёл ревью-пасс. */
    if (outcome.route?.profile === 'pro') {
      console.log(`[route] dialog ${chat.id}: ${describeProfile(outcome.route)}`);
    }
    if (outcome.review?.checked) {
      console.log(`[review] dialog ${chat.id}: ${describeReview(outcome.review)}`);
    }

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
      ...(modes.thinking || modes.search ? { modes: { thinking: modes.thinking === true, search: modes.search === true } } : {}),
      ...(outcome.reasoning ? { reasoning: outcome.reasoning } : {}),
    });
    store.saveChat(chat.id, { messages: chat.messages, history: chat.history, memory: chat.memory, task: chat.task || null });

    if (isFirstMessage && (!chat.title || chat.title === 'Новый диалог')) {
      const title = await generateTitle(text || assistantText, { signal: controller.signal }).catch(() => '');
      if (title) {
        store.renameChat(chat.id, title);
        stream.emit({ type: 'title', title });
      }
    }
    stream.emit({ type: 'done', usage: outcome.usage, tools: outcome.tools.length, balanceUsd });
    finishRun(run, 'done');
    /* Работа закончилась, а приложение может быть закрыто или свёрнуто —
       отправляем уведомление на все устройства пользователя. */
    notifyRunPush({ user, project, chat, run, status: 'done', text: assistantText, approval: budgetInfo, outcome });
  } catch (error) {
    const aborted = error?.name === 'AbortError' || controller.signal.aborted;
    const message = aborted ? 'Остановлено' : describeFailure(error);
    if (!aborted) console.error('[agent]', error?.message || error);
    if (assistantText) {
      chat.messages.push({ role: 'assistant', content: assistantText, interrupted: true, at: nowIso() });
    } else {
      chat.messages.push({ role: 'assistant', content: '', error: message, at: nowIso() });
    }
    store.saveChat(chat.id, { messages: chat.messages, history: chat.history, memory: chat.memory, task: chat.task || null });
    stream.emit({ type: 'error', message, aborted });
    finishRun(run, aborted ? 'stopped' : 'error');
    notifyRunPush({
      user,
      project,
      chat,
      run,
      status: aborted ? 'stopped' : 'error',
      text: assistantText,
      errorText: message,
    });
  }
}

/* ---------------------- «Дашборд»: запуск по расписанию ----------------------
   Постоянное задание — это обычный диалог, который сервер открывает сам, когда
   подошло время. Браузер при этом может быть закрыт: работа идёт в фоне, ответ
   складывается в новый диалог и приходит уведомлением на устройства.

   Почему планировщик внутри процесса, а не отдельная служба: приложению нужен
   ровно один тик в минуту, а состояние (задания, баланс, проекты) и так живёт
   здесь. Пропущенные из-за простоя запуски не копятся: если окно пропущено
   больше чем на DASHBOARD_MISS_LIMIT_MS, запуск не догоняется — старый отчёт
   уже не нужен, лучше дождаться следующего. */
const DASHBOARD_TICK_MS = Math.max(2000, Number(process.env.DSHOW_DASHBOARD_TICK_MS) || 60 * 1000);
const DASHBOARD_MISS_LIMIT_MS = 6 * 60 * 60 * 1000;
/** Сколько запусков «Дашборда» может идти у человека одновременно. */
const DASHBOARD_RUNS_PER_USER = 2;
let dashboardBusy = false;

function dashboardRunsFor(userId) {
  let count = 0;
  for (const run of runs.values()) {
    if (run.userId !== userId && run.userId !== String(userId)) continue;
    if (run.source === 'dashboard' && run.status === 'running') count += 1;
  }
  return count;
}

/** Проект для отчёта: выбранный человеком, иначе первый свой, иначе новый. */
function dashboardProjectFor(user, task) {
  const projects = store.projectsFor(user.id);
  const chosen = task.projectId ? projects.find((project) => project.id === task.projectId) : null;
  if (chosen) return chosen;
  if (projects.length) return projects[0];
  return store.createProject({ ownerId: user.id, name: 'Дашборд' });
}

/* Документы задания к запуску: файл копируется в папку проекта (агент читает
   его своими инструментами), а извлечённый при загрузке текст прикладывается к
   заданию — так отчёт опирается на реальные цифры из бумаг человека, а не на
   догадки. Текст каждого файла уже посчитан один раз при загрузке. */
function dashboardDocsFor(task) {
  const files = Array.isArray(task.files) ? task.files : [];
  const dir = store.dashboardFilesDir(task.id);
  const docs = [];
  let budget = DASHBOARD_LIMITS.filesContextChars;
  for (const file of files) {
    let text = '';
    if (file.textPath && budget > 0) {
      try {
        text = fs.readFileSync(path.join(dir, file.textPath), 'utf8');
      } catch {
        text = '';
      }
      if (text.length > budget) {
        text = `${text.slice(0, budget)}\n…(документ длинный — прочитай файл целиком)`;
      }
      budget -= text.length;
    }
    docs.push({ name: file.name, text, file });
  }
  return docs;
}

/** Копии документов в проекте: агент ходит по рабочей папке, а не по данным
    приложения. Имя не дублируется при повторных запусках. */
function copyDashboardDocs(project, task, docs) {
  if (!docs.length) return [];
  const dir = path.join(store.workspaceDir(project.id), DASHBOARD_FILES_SUBDIR);
  const paths = [];
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (error) {
    console.error('[dashboard] папка материалов:', error?.message || error);
    return paths;
  }
  for (const doc of docs) {
    const source = path.join(store.dashboardFilesDir(task.id), doc.file.relPath);
    const base = safeName(doc.file.name) || 'документ';
    let name = base;
    try {
      const target = path.join(dir, name);
      const same = fs.existsSync(target) && fs.statSync(target).size === Number(doc.file.size || 0);
      if (!same) {
        name = uniqueFileName(dir, base);
        fs.copyFileSync(source, path.join(dir, name));
      }
    } catch (error) {
      console.error('[dashboard] копирование документа:', error?.message || error);
      continue;
    }
    paths.push(`${DASHBOARD_FILES_SUBDIR}/${name}`);
  }
  return paths;
}

function dashboardTaskText(task, docs = []) {
  const block = dashboardBlock(task.blockId);
  const title = block ? block.title : 'Постоянное задание';
  const base = `Постоянное задание «${title}»\n\n${task.prompt || (block && block.prompt) || ''}`;
  const notice = dashboardDocsBlock(docs.map((doc) => ({ name: doc.name })));
  const usable = docs.filter((doc) => String(doc.text || '').trim());
  const body = usable.length
    ? `\n\n=== Текст приложенных документов ===\n${usable
        .map((doc) => `--- ${doc.name} ---\n${doc.text}`)
        .join('\n\n')}`
    : '';
  return `${base}${notice}${body}`;
}

/**
 * Готовит запуск задания: диалог, задача, отметки в задании. Саму работу
 * запускает вызвавший — так ручка успевает ответить, а планировщик не ждёт.
 * Возвращает причину и подсказку «когда повторить», если запустить нельзя.
 */
function beginDashboardRun(task, { manual = false } = {}) {
  const user = store.getUser(task.ownerId);
  if (!user || user.disabled) return { ok: false, reason: 'аккаунт недоступен', disable: true };
  if (!manual && user.role !== 'admin') {
    const balanceUsd = store.publicUser(user.id).balanceUsd;
    /* Без денег запуск бессмысленен: ждём пополнения, но не чаще раза в шесть часов. */
    if (!(balanceUsd > 0)) return { ok: false, reason: 'на балансе нет средств', retryMinutes: 360 };
  }
  const project = dashboardProjectFor(user, task);
  if (!manual && user.role !== 'admin' && store.pendingApprovalFor(project.id)) {
    return { ok: false, reason: 'ждёт подтверждения администратора', retryMinutes: 60 };
  }
  if (dashboardRunsFor(user.id) >= DASHBOARD_RUNS_PER_USER) {
    return { ok: false, reason: 'агент занят другим заданием', retryMinutes: 15 };
  }
  const block = dashboardBlock(task.blockId);
  const label = new Date().toLocaleDateString('ru-RU', {
    timeZone: DASHBOARD_TZ,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
  const chatMeta = store.createChat({
    projectId: project.id,
    ownerId: user.id,
    title: `${block ? block.title : 'Дашборд'} — ${label}`,
  });
  const chat = store.getChat(chatMeta.id, user.id) || chatMeta;
  const run = createRun({ user, project, chat });
  run.source = 'dashboard';
  run.dashboardTaskId = task.id;
  /* Материалы задания готовим до старта: и копии в проекте, и текст для модели. */
  const docs = dashboardDocsFor(task);
  copyDashboardDocs(project, task, docs);
  store.markDashboardStarted(task.id, { chatId: chat.id, advance: !manual });
  return {
    ok: true,
    chat,
    run,
    start: () => {
      void executeRun(run, {
        text: dashboardTaskText(task, docs),
        attachmentIds: [],
        isFirstMessage: true,
      })
        .then(() => store.markDashboardFinished(task.id, run.status))
        .catch(() => store.markDashboardFinished(task.id, 'error'));
    },
  };
}

function dashboardTick() {
  if (dashboardBusy) return;
  dashboardBusy = true;
  try {
    const now = Date.now();
    let launched = 0;
    for (const task of store.dashboardDue(now)) {
      if (launched >= 3) break;
      const scheduled = Date.parse(task.nextRunAt) || now;
      if (now - scheduled > DASHBOARD_MISS_LIMIT_MS) {
        store.markDashboardSkipped(task.id, { reason: 'запуск пропущен: сервис был недоступен' });
        console.log(`[dashboard] задание «${task.blockId}» пропущено (окно прошло)`);
        continue;
      }
      const started = beginDashboardRun(task);
      if (!started.ok) {
        /* Временная причина — просто подождать; постоянная — перенести дату. */
        if (started.retryMinutes) store.postponeDashboardTask(task.id, started.retryMinutes);
        else store.markDashboardSkipped(task.id, { reason: started.reason, disable: Boolean(started.disable) });
        continue;
      }
      launched += 1;
      started.start();
      console.log(`[dashboard] задание «${task.blockId}» → диалог ${started.chat.id}`);
    }
  } catch (error) {
    console.error('[dashboard]', error?.message || error);
  } finally {
    dashboardBusy = false;
  }
}

function startDashboardScheduler() {
  /* Первый тик с задержкой: при старте сервиса сначала поднимаются ключи,
     задачи и перенос хранилища — не надо мешать им своим запуском. */
  const startDelayMs = Math.max(0, Number(process.env.DSHOW_DASHBOARD_START_MS ?? 20 * 1000) || 0);
  setTimeout(dashboardTick, startDelayMs).unref?.();
  const timer = setInterval(dashboardTick, DASHBOARD_TICK_MS);
  timer.unref?.();
}

/* Задание глазами браузера: настройки, подписи, расписание и состояние.
   Внутрь (ownerId, служебные поля) наружу ничего не отдаём. */
/* Документы задания: отдаём только имя, размер и подсказку — содержимое
   остаётся на сервере. */
function publicDashboardFile(file) {
  return {
    id: file.id,
    name: file.name,
    size: Number(file.size) || 0,
    warnings: Array.isArray(file.warnings) ? file.warnings.slice(0, 2) : [],
  };
}

function publicDashboardTask(task, user) {
  const block = dashboardBlock(task.blockId) || {};
  const project = task.projectId ? store.getProject(task.projectId, user.id) : null;
  return {
    id: task.id,
    blockId: task.blockId,
    title: block.title || task.blockId,
    short: block.short || '',
    description: block.description || '',
    icon: block.icon || 'calendar',
    skill: block.skill || '',
    enabled: Boolean(task.enabled),
    cadence: task.cadence,
    dayOfMonth: task.dayOfMonth,
    dayOfWeek: task.dayOfWeek,
    hour: task.hour,
    schedule: scheduleText(task),
    prompt: task.prompt || '',
    projectId: project ? project.id : '',
    /* Если проект не выбран, показываем тот, куда отчёт попадёт на самом деле:
       первый проект аккаунта (его же подставит и планировщик). */
    projectName: project ? project.name : store.projectsFor(user.id)[0]?.name || '',
    nextRunAt: task.nextRunAt || null,
    lastRunAt: task.lastRunAt || null,
    lastStatus: task.lastStatus || '',
    lastChatId: task.lastChatId || '',
    lastError: task.lastError || '',
    files: (Array.isArray(task.files) ? task.files : []).map(publicDashboardFile),
    defaults: {
      cadence: block.cadence || 'monthly',
      dayOfMonth: block.dayOfMonth || 1,
      dayOfWeek: block.dayOfWeek || 1,
      hour: block.hour || 9,
      prompt: block.prompt || '',
    },
  };
}

function dashboardPayload(user) {
  store.ensureDashboardTasks(user.id);
  const tasks = store.dashboardTasks(user.id).map((task) => publicDashboardTask(task, user));
  const upcoming = tasks
    .filter((task) => task.enabled && task.nextRunAt)
    .sort((a, b) => String(a.nextRunAt).localeCompare(String(b.nextRunAt)))[0];
  const balanceUsd = store.publicUser(user.id)?.balanceUsd ?? 0;
  return {
    tasks,
    nextRunAt: upcoming ? upcoming.nextRunAt : null,
    tz: DASHBOARD_TZ,
    balanceUsd,
    /* Автозапуск тратит баланс — интерфейс обязан сказать это до включения. */
    canAutoRun: user.role === 'admin' || balanceUsd > 0,
  };
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

/* Что нельзя отдавать «как страницу» в origin приложения: HTML/SVG/XML умеют
   исполнять скрипты, а сессия живёт на том же домене. Такие файлы скачиваются,
   а если их всё-таки показывают внутри (страница проекта), ответ получает
   песочницу CSP — как в sendSharedFile. */
const ACTIVE_PAGE_EXT = new Set(['.html', '.htm', '.xhtml', '.svg', '.xml']);

function sendFile(res, full, { download = false, name, head = false } = {}) {
  const stat = fs.statSync(full);
  if (!stat.isFile()) return sendError(res, 404, 'Не найдено');
  const ext = path.extname(full).toLowerCase();
  const fileName = name || path.basename(full);
  const active = ACTIVE_PAGE_EXT.has(ext);
  const asDownload = download || active;
  const disposition = asDownload
    ? `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`
    : `inline; filename*=UTF-8''${encodeURIComponent(fileName)}`;
  const headers = {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': stat.size,
    'Content-Disposition': disposition,
    'Cache-Control': 'no-store',
    ...SECURITY_HEADERS,
  };
  if (active) headers['Content-Security-Policy'] = PAGE_SANDBOX_CSP;
  res.writeHead(200, headers);
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
  const pathname = tryDecode(url.pathname);
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
      const token = cookies[SESSION.cookie];
      const leaving = token ? store.sessionUser(sessionKey(token)) : null;
      if (leaving) clearPresence(leaving.id);
      if (token) store.dropSession(sessionKey(token));
      return sendJson(res, 200, { ok: true }, { 'Set-Cookie': clearSessionCookie(TRUST_PROXY) });
    }
    if (pathname === '/api/version' && method === 'GET') {
      /* Версия статики. Открытая вкладка сравнивает её сама и обновляется,
         когда на сервере выложили новую сборку — без F5 у человека. */
      return sendJson(res, 200, { version: assetVersion() }, { 'Cache-Control': 'no-store' });
    }
    if (pathname === '/api/health' && method === 'GET') {
      /* Сколько устройств аккаунт держит одновременно: сейчас без ограничений —
         ноутбук, телефон, ярлык и вкладки работают параллельно, не выбивая
         друг друга. */
      return sendJson(res, 200, {
        ok: true,
        time: nowIso(),
        sessions: sessionSeats(),
        docs: await docEngines(),
        skills: listSkills().length,
      });
    }

    // --- требуется вход ---
    const user = requireUser(req, res);
    if (!user) return;

    if (pathname === '/api/me' && method === 'GET') return sendJson(res, 200, bootstrapPayload(user));
    if (pathname === '/api/bootstrap' && method === 'GET') return sendJson(res, 200, bootstrapPayload(user));

    /* --- уведомления в ярлык-приложение --- */
    /* Вкладка сообщает, на экране она или ушла в фон. Пока хоть одна вкладка
       пользователя видима, пуш о готовой задаче не отправляем ни на одно его
       устройство: человек и так увидит ответ. */
    if (pathname === '/api/presence' && method === 'POST') {
      const body = await readJsonBody(req, 4096);
      if (!body || typeof body !== 'object') return sendError(res, 400, 'Некорректный запрос');
      const clientId = String(body.clientId || '').slice(0, 80);
      touchPresence(user.id, {
        clientId,
        visible: body.visible !== false,
        focused: body.focused === true,
      });
      return sendJson(res, 200, { ok: true, active: isUserActive(user.id) });
    }
    if (pathname === '/api/push/state' && method === 'GET') {
      return sendJson(res, 200, pushState(user.id), { 'Cache-Control': 'no-store' });
    }
    if (pathname === '/api/push/subscribe' && method === 'POST') {
      const body = await readJsonBody(req);
      const device = deviceIdOf(req);
      const result = pushSubscribe(user, body.subscription, req.headers['user-agent'], {
        deviceId: body.deviceId || device.id,
        app: Boolean(body.app),
      });
      if (!result.ok) return sendError(res, 400, result.error);
      return sendJson(res, 200, { ok: true, subscriptions: result.subscriptions });
    }
    /* Состояние уведомлений на устройстве: разрешение браузера, живая подписка,
       ярлык-приложение. Приходит и тогда, когда уведомления запрещены, — иначе
       администратор не увидит, что человек выключил их на самом устройстве. */
    if (pathname === '/api/push/report' && method === 'POST') {
      const body = await readJsonBody(req);
      const device = deviceIdOf(req);
      const result = pushReportDevice(
        user,
        {
          deviceId: body.deviceId || device.id,
          permission: body.permission,
          subscribed: body.subscribed,
          app: body.app,
        },
        req.headers['user-agent'],
      );
      if (!result.ok) return sendError(res, 400, result.error);
      const headers = device.fresh && !body.deviceId ? { 'Set-Cookie': deviceCookie(device.id, DEVICE.cookieMs, TRUST_PROXY) } : {};
      return sendJson(res, 200, result, headers);
    }
    if (pathname === '/api/push/unsubscribe' && method === 'POST') {
      const body = await readJsonBody(req);
      const result = pushUnsubscribe(user, body.endpoint);
      if (!result.ok) return sendError(res, 400, result.error);
      return sendJson(res, 200, { ok: true, subscriptions: result.subscriptions });
    }
    if (pathname === '/api/push/test' && method === 'POST') {
      /* Пробное уведомление: единственный способ проверить, что телефон и
         компьютер действительно принимают пуши, не дожидаясь конца задачи. */
      const result = await pushToUser(user.id, {
        title: 'DSH Open',
        body: 'Уведомления работают: так придёт сообщение о готовой задаче.',
        url: '/',
        kind: 'test',
        tag: 'dsh-test',
        onlyWhenAway: false,
      });
      if (!result.total) return sendError(res, 409, 'Сначала включите уведомления на этом устройстве');
      return sendJson(res, 200, { ok: result.sent > 0, ...result });
    }

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
        const rawName = tryDecode(String(req.headers['x-filename'] || 'file'));
        /* Без явного пути файл ложится в общую папку проекта. */
        const target = url.searchParams.get('path') || uniqueFileName(workspace, rawName);
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
          .filter((att) => att.chatId === chat.id && (!att.ownerId || att.ownerId === chat.ownerId))
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

    /* ---- «Дашборд»: постоянные задания ----
       Шесть блоков есть у каждого аккаунта; человек настраивает расписание,
       проект и свой текст задания. Запуск по времени делает планировщик
       (dashboardTick), а «Запустить сейчас» — эта же ручка, но по кнопке. */
    if (parts[1] === 'dashboard') {
      if (parts.length === 2 && method === 'GET') return sendJson(res, 200, dashboardPayload(user));
      if (parts[2] === 'tasks' && parts[3]) {
        const task = store.getDashboardTask(parts[3], user.id);
        if (!task) return sendError(res, 404, 'Задание не найдено');
        if (parts.length === 4 && method === 'PATCH') {
          const body = await readJsonBody(req);
          const patch = {};
          if (body.enabled !== undefined) patch.enabled = Boolean(body.enabled);
          if (body.cadence !== undefined) patch.cadence = String(body.cadence);
          if (body.dayOfMonth !== undefined) patch.dayOfMonth = body.dayOfMonth;
          if (body.dayOfWeek !== undefined) patch.dayOfWeek = body.dayOfWeek;
          if (body.hour !== undefined) patch.hour = body.hour;
          if (body.prompt !== undefined) patch.prompt = String(body.prompt);
          if (body.projectId !== undefined) {
            const project = body.projectId ? store.getProject(String(body.projectId), user.id) : null;
            if (body.projectId && !project) return sendError(res, 400, 'Проект не найден');
            patch.projectId = project ? project.id : '';
          }
          store.updateDashboardTask(task.id, user.id, patch);
          /* Крючок для проверок: расписание срабатывает раз в месяц, а
             планировщик надо увидеть сейчас. Включается только окружением. */
          if (process.env.DSHOW_DASHBOARD_TEST === '1' && body.forceDue) store.forceDashboardDue(task.id);
          return sendJson(res, 200, { task: publicDashboardTask(store.getDashboardTask(task.id, user.id), user) });
        }
        if (parts[4] === 'run' && method === 'POST') {
          const started = beginDashboardRun(task, { manual: true });
          if (!started.ok) return sendError(res, started.retryMinutes ? 409 : 400, started.reason);
          /* Отвечаем до начала работы: вкладка откроет диалог и подпишется на
             поток задачи, а сама задача уже зарегистрирована в runs. */
          sendJson(res, 200, { chatId: started.chat.id, run: publicRun(started.run) });
          started.start();
          return;
        }
        if (parts[4] === 'reset' && method === 'POST') {
          store.resetDashboardTask(task.id, user.id);
          return sendJson(res, 200, { task: publicDashboardTask(store.getDashboardTask(task.id, user.id), user) });
        }
        /* Документы задания: загрузка (тело — сами байты, имя в x-filename),
           скачивание и удаление. Отдельным путём, чтобы не мешать PATCH. */
        if (parts[4] === 'files') {
          if (parts.length === 5 && method === 'POST') return await handleDashboardFileUpload(req, res, user, task);
          const file = (Array.isArray(task.files) ? task.files : []).find((item) => item.id === parts[5]);
          if (!file) return sendError(res, 404, 'Документ не найден');
          if (parts.length === 6 && method === 'DELETE') return handleDashboardFileDelete(res, user, task, file.id);
          if (parts.length === 6 && method === 'GET') {
            /* relPath хранится в состоянии, но проверяем его как пользовательский
               путь: ошибка в данных не должна выпускать чтение за папку задания. */
            let full;
            try {
              full = resolveSafe(store.dashboardFilesDir(task.id), file.relPath);
            } catch {
              return sendError(res, 404, 'Файл не найден');
            }
            if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return sendError(res, 404, 'Файл не найден');
            return sendFile(res, full, { download: true, name: file.name });
          }
          return sendError(res, 404, 'Не найдено');
        }
        return sendError(res, 404, 'Не найдено');
      }
      return sendError(res, 404, 'Не найдено');
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
        /* Роль только из двух известных значений: иначе опечатка («Admin», «root»)
           молча понижала человека и отключала ему админские ручки. */
        if (body.role && target.id !== admin.id) {
          if (body.role !== 'admin' && body.role !== 'user') {
            return sendError(res, 400, 'Роль может быть только admin или user');
          }
          patch.role = body.role;
        }
        const updated = store.updateUser(target.id, patch);
        return sendJson(res, 200, { user: updated });
      }
      if (method === 'DELETE') {
        if (target.id === admin.id) return sendError(res, 400, 'Нельзя удалить свою учётную запись');
        store.deleteUser(target.id);
        pushForgetUser(target.id);
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
    /* --- рассылка уведомлений от администратора ---
       Объявление о новой функции уходит всем или выбранным пользователям —
       разумеется, только тем, у кого уведомления включены на устройстве. */
    if (pathname === '/api/admin/push' && method === 'GET') {
      const admin = requireAdmin(req, res);
      if (!admin) return;
      return sendJson(res, 200, pushTargets(store.users()), { 'Cache-Control': 'no-store' });
    }
    if (pathname === '/api/admin/push' && method === 'POST') {
      const admin = requireAdmin(req, res);
      if (!admin) return;
      const body = await readJsonBody(req);
      const title = String(body.title || '').trim();
      const text = String(body.text || body.body || '').trim();
      if (!title) return sendError(res, 400, 'Укажите заголовок уведомления');
      if (title.length > 80) return sendError(res, 400, 'Заголовок длиннее 80 символов');
      if (!text) return sendError(res, 400, 'Укажите текст уведомления');
      if (text.length > 300) return sendError(res, 400, 'Текст длиннее 300 символов');
      const targets = pushTargets(store.users());
      const devicesByUser = new Map(targets.users.map((item) => [item.userId, item.devices]));
      const requested = [...new Set((Array.isArray(body.userIds) ? body.userIds : []).map(String).filter(Boolean))];
      const all = body.all === true;
      /* Пробная отправка — всегда только на устройства самого администратора.
         Аудиторию из запроса при этом игнорируем: иначе опечатка или старая
         вкладка превращали проверку в рассылку «Тест» всем пользователям. */
      const testOnly = body.test === true;
      const userIds = testOnly
        ? [admin.id].filter((id) => devicesByUser.get(id) > 0)
        : all
          ? [...devicesByUser.keys()].filter((id) => devicesByUser.get(id) > 0)
          : requested.filter((id) => devicesByUser.get(id) > 0);
      /* Про тех, кому уведомления не придут вовсе, сообщаем отдельно: иначе
         администратор решит, что объявление получили все. */
      const skipped = testOnly
        ? (devicesByUser.get(admin.id) ? 0 : 1)
        : all
          ? store.users().filter((item) => !devicesByUser.get(item.id)).length
          : requested.filter((id) => !devicesByUser.get(id)).length;
      if (!userIds.length) {
        return sendError(
          res,
          409,
          testOnly
            ? 'На ваших устройствах уведомления ещё не включены — проверять некуда'
            : 'Ни у одного из выбранных не включены уведомления',
        );
      }
      const result = await pushToUsers(userIds, {
        title,
        body: text,
        url: '/',
        kind: testOnly ? 'test' : 'news',
        tag: testOnly ? 'dsh-test' : `dsh-news-${Date.now()}`,
        /* Проверка и объявление — не отчёт о задаче: их показываем, даже если
           приложение открыто, иначе кнопка «Проверить» выглядит сломанной. */
        onlyWhenAway: false,
      });
      console.log(
        testOnly
          ? `[push] проверка от ${admin.username}: принято устройств ${result.sent} из ${result.total}, получатель — только администратор`
          : `[push] рассылка от ${admin.username}: принято устройств ${result.sent} из ${result.total}, людей ${result.users}`,
      );
      return sendJson(res, 200, { ok: result.sent > 0, ...result, skipped });
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
    /* Резервные копии состояния: список, снимок по кнопке и выгрузка архива. */
    if (pathname === '/api/admin/backups' && method === 'GET') {
      const admin = requireAdmin(req, res);
      if (!admin) return;
      return sendJson(res, 200, {
        backups: listBackups(),
        automatic: process.env.DSHOW_BACKUPS !== '0',
        keep: BACKUP_DEFAULTS.keep,
      });
    }
    if (pathname === '/api/admin/backups' && method === 'POST') {
      const admin = requireAdmin(req, res);
      if (!admin) return;
      try {
        const result = snapshotState();
        console.log(
          `[backup] по кнопке администратора: ${result.id}, диалогов ${result.chats}, ` +
            `проектов ${result.workspaces}, файлов ${result.files}`,
        );
        return sendJson(res, 200, { ok: true, backup: result, backups: listBackups() });
      } catch (error) {
        return sendError(res, 500, `Не удалось сделать копию: ${error.message}`);
      }
    }
    if (pathname === '/api/admin/backups/download' && method === 'GET') {
      const admin = requireAdmin(req, res);
      if (!admin) return;
      const id = String(url.searchParams.get('id') || '');
      const backup = listBackups().find((item) => item.id === id);
      if (!backup) return sendError(res, 404, 'Копия не найдена');
      const dir = path.join(backupsDir(), backup.id);
      const files = [];
      /* Пропускаем только служебные папки в корне копии: `.history` внутри
         проекта — это срезы разговора, в архиве они нужны. */
      const walk = (base, rel, depth) => {
        for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
          if (depth === 0 && entry.name.startsWith('.')) continue;
          const full = path.join(base, entry.name);
          const name = rel ? `${rel}/${entry.name}` : entry.name;
          if (entry.isDirectory()) walk(full, name, depth + 1);
          else files.push({ name, path: full });
        }
      };
      walk(dir, backup.id, 0);
      res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(`dshow-backup-${backup.id}.zip`)}`,
        ...SECURITY_HEADERS,
      });
      return await pipeZip(res, files);
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
  console.log(`  Дашборд: ${process.env.DSHOW_DASHBOARD === '0' ? 'выключен' : 'постоянные задания включены'}`);
  console.log('');
});

/* Планировщик «Дашборда» поднимается вместе с сервисом. Выключается
   переменной окружения: это нужно проверкам, которым не нужен фоновой тик. */
if (process.env.DSHOW_DASHBOARD !== '0') startDashboardScheduler();

/* Суточные копии состояния: даже если проект удалят по ошибке или файл индекса
   побьётся, переписки и структура вернутся. Выключается DSHOW_BACKUPS=0. */
if (process.env.DSHOW_BACKUPS !== '0') startAutoBackup();

process.on('SIGINT', () => {
  console.log('\nОстановка…');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
});
