import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import zlib from 'node:zlib';
import {
  ADMIN,
  BILLING,
  BUDGET,
  DATA_DIR,
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
  taskLimitUsd,
} from './src/config.mjs';
import { describeFailure, generateTitle, runTurn } from './src/agent.mjs';
import { transcribeAudio } from './src/asr.mjs';
import { detectKind, extractDocumentText, kindLabel } from './src/docparse.mjs';
import { approvalMessage, notifyAdmin } from './src/notify.mjs';
import { issueOpenLink, resolveOpenLink, asciiFileName, OPEN_PREFIX } from './src/openlink.mjs';
import { proofreadText } from './src/proofread.mjs';
import { keyStatus } from './src/keys.mjs';
import {
  clearSessionCookie,
  issueSession,
  parseCookies,
  passwordProblem,
  RateLimiter,
  sessionCookie,
  sessionKey,
  usernameProblem,
} from './src/security.mjs';
import { store } from './src/store.mjs';
import { listTree, resolveSafe } from './src/tools.mjs';
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
const busyUsers = new Map();
const attachmentQueue = new Set();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
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

function currentUser(req) {
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies[SESSION.cookie];
  if (!token) return null;
  const key = sessionKey(token);
  const user = store.sessionUser(key);
  if (!user) return null;
  const session = store.state.sessions[key];
  if (session && session.exp - Date.now() < SESSION.ttlMs / 2) {
    store.renewSession(key, SESSION.ttlMs);
  }
  return user;
}

function requireUser(req, res) {
  const user = currentUser(req);
  if (!user) {
    sendError(res, 401, 'Требуется вход');
    return null;
  }
  return user;
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
  const projects = store.projectsFor(user.id).map((project) => ({
    ...project,
    chats: store.chatsFor(project.id).map(chatMeta),
  }));
  return {
    user: store.publicUser(user.id),
    projects,
    workflows: store.workflowsFor(user.id),
    keys: { vision: keyStatus().vision },
    limits: {
      maxAttachments: LIMITS.maxAttachmentsPerMessage,
      maxFileMb: Math.round(LIMITS.maxAttachmentBytes / 1024 / 1024),
    },
  };
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
  const token = issueSession(store, user.id, { ip, ua: req.headers['user-agent'] });
  store.touchLogin(user.id);
  sendJson(res, 200, bootstrapPayload(user), { 'Set-Cookie': sessionCookie(token, SESSION.ttlMs, TRUST_PROXY) });
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
  const token = issueSession(store, user.id, { ip, ua: req.headers['user-agent'] });
  store.touchLogin(user.id);
  sendJson(res, 200, bootstrapPayload(user), { 'Set-Cookie': sessionCookie(token, SESSION.ttlMs, TRUST_PROXY) });
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

function openStream(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    ...SECURITY_HEADERS,
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

  if (busyUsers.get(user.id)) {
    return sendError(res, 429, 'Дождитесь завершения текущего ответа.');
  }

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

  busyUsers.set(user.id, true);
  const stream = openStream(res);
  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) controller.abort();
  });

  const isFirstMessage = chat.messages.length === 0;
  let assistantText = '';
  try {
    const attachments = await waitForAttachments(attachmentIds, user, chat, stream.emit);
    const ctx = attachmentContext(attachments);
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
      images: ctx.images,
      emit: stream.emit,
      signal: controller.signal,
      budget: user.role === 'admin' ? null : { limitUsd: projectLimit(project) },
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
  } finally {
    busyUsers.delete(user.id);
    stream.cleanup();
    stream.close();
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
  const compressible = /\.(html|css|js|svg|json|txt|md|map)$/.test(ext);
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
      return sendFile(res, full, {
        download: true,
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
    if (pathname === '/api/health' && method === 'GET') {
      return sendJson(res, 200, { ok: true, time: nowIso() });
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
      if (parts[3] === 'file-link' && method === 'GET') {
        /* Подписанная ссылка на файл для Word/Excel/PowerPoint. Живёт 10 минут
           и открывает только этот файл; сессия и постоянный адрес не нужны. */
        const rel = url.searchParams.get('path') || '';
        try {
          const full = resolveSafe(workspace, rel);
          if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return sendError(res, 404, 'Файл не найден');
          const id = issueOpenLink({ projectId: project.id, relPath: rel });
          const fileName = path.basename(full);
          /* Адрес держим коротким: Excel не открывает файл, если путь длиннее 218 знаков. */
          return sendJson(res, 200, {
            url: `${publicOrigin(req)}/o/${id}/${asciiFileName(fileName)}`,
            name: fileName,
          });
        } catch (error) {
          return sendError(res, 400, error.message);
        }
      }
      if (parts[3] === 'file-preview' && method === 'GET') {
        // Просмотр файла прямо в приложении: текст документа извлекаем на сервере,
        // чтобы Word/Excel/презентации открывались для чтения, а не скачивались.
        const rel = url.searchParams.get('path') || '';
        try {
          const full = resolveSafe(workspace, rel);
          if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return sendError(res, 404, 'Файл не найден');
          const name = path.basename(full);
          const stat = fs.statSync(full);
          const base = { name, path: rel, size: stat.size, kind: detectKind(name), kindLabel: kindLabel(detectKind(name)) };
          if (stat.size > 25 * 1024 * 1024) {
            return sendJson(res, 200, { ...base, text: '', warnings: ['Файл больше 25 МБ — предпросмотр недоступен, скачайте его.'] });
          }
          const { kind, text, warnings } = extractDocumentText(fs.readFileSync(full), name, '', {
            maxRows: 500,
            maxChars: 200000,
          });
          return sendJson(res, 200, { ...base, kind, kindLabel: kindLabel(kind), text, warnings });
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
    if (pathname === '/api/admin/stats' && method === 'GET') {
      const admin = requireAdmin(req, res);
      if (!admin) return;
      return sendJson(res, 200, { overview: store.overview(), keys: keyStatus() });
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
