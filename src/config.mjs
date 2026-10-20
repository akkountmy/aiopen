import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '..');

export const DATA_DIR = process.env.DSHOW_DATA_DIR
  ? path.resolve(process.env.DSHOW_DATA_DIR)
  : path.join(ROOT, 'data');

export const PUBLIC_DIR = path.join(ROOT, 'public');
export const WORKSPACES_DIR = path.join(DATA_DIR, 'workspaces');
export const CHATS_DIR = path.join(DATA_DIR, 'chats');
export const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
export const LOGS_DIR = path.join(DATA_DIR, 'logs');
export const INDEX_FILE = path.join(DATA_DIR, 'index.json');

export const HOST = process.env.DSHOW_HOST || '127.0.0.1';
export const PORT = Number(process.env.DSHOW_PORT || 3123);

/** За обратным прокси (Amvera и подобные) реальный IP приходит в X-Forwarded-For. */
export const TRUST_PROXY = process.env.DSHOW_TRUST_PROXY === '1';

/** Уровень контекста: средний. Значения можно переопределить окружением —
 *  это удобно для тестов и для тонкой настройки облака без правки кода. */
export const CONTEXT = {
  profile: 'medium',
  /* Сколько истории уходит в модель. Большая задача — это десятки шагов с
     файлами и расчётами, поэтому запас нужен приличный; лишнее отрезается
     между шагами, чтобы модель не упёрлась в окно контекста. */
  historyTokens: Number(process.env.DSHOW_HISTORY_TOKENS || 60000),
  toolResultChars: 12000,
  summaryChars: 2200,
  keepRecentMessages: Number(process.env.DSHOW_KEEP_RECENT || 10),
  /* Шагов до мягкого продолжения: дальше агент сам получает «продолжай» и
     работает, вместо того чтобы остановиться и спросить человека. */
  maxSteps: Number(process.env.DSHOW_MAX_STEPS || 40),
  /* Сколько таких отрезков разрешено на одну задачу. 40 × 12 = 480 шагов —
     с запасом на самый большой проект; упирается в это только зацикливание,
     а не настоящая работа. */
  maxSegments: Number(process.env.DSHOW_MAX_SEGMENTS || 12),
  maxOutputTokens: 16000,
};

const MB = 1024 * 1024;

export const LIMITS = {
  jsonBody: 8 * MB,
  uploadBody: 160 * MB,
  maxAttachmentBytes: Number(process.env.DSHOW_MAX_ATTACHMENT_MB || 128) * MB,
  /** Не принимать файлы, если на диске останется меньше этого запаса. */
  minFreeBytes: Number(process.env.DSHOW_MIN_FREE_MB || 64) * MB,
  /** Файлы крупнее этого не разбираем в память — только сохраняем и предупреждаем. */
  maxParseBytes: Number(process.env.DSHOW_MAX_PARSE_MB || 32) * MB,
  maxFileTextChars: 200000,
  maxAttachmentsPerMessage: 24,
  attachmentsContextChars: 60000,
  /** Сколько ответов может идти одновременно у одного аккаунта: по одному на
   *  устройство (ноутбук + телефон), чтобы работа с двух мест не блокировала
   *  друг друга. Внутри одного диалога всегда ровно один ответ. */
  agentConcurrencyPerUser: 2,
  pythonTimeoutMs: 60000,
  fetchTimeoutMs: 30000,
  transcribeBody: 24 * MB,
  proofreadChars: 24000,
};

/* Срок жизни входа можно задать переменной окружения — это нужно и облаку,
   и проверкам, которые не могут ждать месяц. */
function sessionDaysFromEnv(value, fallback) {
  const n = Number(value);
  return (Number.isFinite(n) && n > 0 ? n : fallback) * 24 * 60 * 60 * 1000;
}

/* Сколько живёт вход. Срок скользящий: пока человек заходит, он продлевается и
   на сервере, и в браузере (см. currentUser в server.mjs). Тридцать дней — это
   «открыл ярлык через месяц отпуска и остался внутри»; раньше было семь, и
   у приложения с домашнего экрана ровно через неделю просили пароль. */
export const SESSION = {
  cookie: 'dshow_session',
  ttlMs: sessionDaysFromEnv(process.env.DSHOW_SESSION_DAYS, 30),
  sliding: true,
};

/* Аккаунт держит несколько живых сеансов сразу: ноутбук, браузер телефона и
   ярлык-приложение с домашнего экрана работают одновременно и друг друга не
   выбивают. Мест всего `maxSessions`; когда их больше, закрывается самый давно
   не использованный сеанс, а не «второй такой же по типу». Ниже — пороги, по
   которым администратор узнаёт о подозрительных входах. */
const hours = (value, fallback) => {
  const n = Number(value);
  return (Number.isFinite(n) && n > 0 ? n : fallback) * 60 * 60 * 1000;
};

const count = (value, fallback) => {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
};

export const DEVICE = {
  cookie: 'dshow_device',
  cookieMs: 400 * 24 * 60 * 60 * 1000,
  /* Окно, за которое считаем устройства и адреса. */
  windowMs: hours(process.env.DSHOW_DEVICE_WINDOW_HOURS, 24),
  /* Сколько храним историю входов (для разбора и показа в панели). */
  keepMs: 14 * 24 * 60 * 60 * 1000,
  maxEvents: 200,
  /* Порог подозрения: столько разных устройств / адресов за окно. */
  alertDevices: Number(process.env.DSHOW_ALERT_DEVICES || 3),
  alertIps: Number(process.env.DSHOW_ALERT_IPS || 4),
  /* Сколько раз за окно у пользователя выбивали активный сеанс новым входом. */
  alertDisplaced: Number(process.env.DSHOW_ALERT_DISPLACED || 3),
  /* Не чаще одного сообщения в столько часов на аккаунт. */
  cooldownMs: hours(process.env.DSHOW_ALERT_COOLDOWN_HOURS, 12),
  /* Сколько живёт пометка «сеанс закрыт новым входом» — чтобы старый браузер
     показал понятное объяснение вместо пустого экрана входа. */
  kickedTtlMs: 30 * 60 * 1000,
  /* Сколько живых сеансов человек может держать одновременно. Три места — это
     ровно «ноутбук + браузер телефона + ярлык-приложение»; четвёртый вход
     закрывает самый давно не использованный сеанс, а не тот, что того же типа.
     Так обычная работа с нескольких устройств не выкидывает из аккаунта. */
  maxSessions: count(process.env.DSHOW_SESSIONS_MAX, 3),
};

/** Классы устройств — нужны для истории входов и для ярлыка, а не для выбивания. */
export const DEVICE_KINDS = ['desktop', 'mobile', 'app'];

/** Сколько сеансов одного аккаунта разрешено держать активными. */
export function sessionLimit() {
  const value = DEVICE.maxSessions;
  return Number.isInteger(value) && value >= 1 ? value : 3;
}

export const SECURITY = {
  loginWindowMs: 10 * 60 * 1000,
  loginMaxPerIp: 12,
  loginMaxPerUser: 6,
  passwordMinLength: 8,
  scrypt: { N: 16384, r: 8, p: 1, keylen: 32 },
};

/* Свободная регистрация: по умолчанию выключена, включается DSHOW_OPEN_SIGNUP=1.
   Пока выключена, аккаунты создаёт только администратор. */
export const SIGNUP = {
  open: process.env.DSHOW_OPEN_SIGNUP === '1',
  maxPerIpPerHour: Number(process.env.DSHOW_SIGNUP_PER_HOUR || 3),
};

/** Служебная модель. Наружу (в интерфейс) не выводится. */
export const MODEL = {
  baseURL: process.env.DSHOW_MODEL_BASE || 'https://api.deepseek.com',
  name: process.env.DSHOW_MODEL || 'deepseek-flash',
  effort: process.env.DSHOW_EFFORT || 'high',
  visionFallback: true,
};

/**
 * Оценка стоимости работы модели — только для внутреннего учёта и предупреждений.
 * Наружу ни цена, ни модель не показываются.
 */
export const PRICING = {
  inputPerM: Number(process.env.DSHOW_PRICE_IN || 0.28),
  outputPerM: Number(process.env.DSHOW_PRICE_OUT || 0.42),
};

export function costUsd(tokensIn = 0, tokensOut = 0) {
  const inCost = (Number(tokensIn) || 0) / 1e6 * PRICING.inputPerM;
  const outCost = (Number(tokensOut) || 0) / 1e6 * PRICING.outputPerM;
  return inCost + outCost;
}

/**
 * Сколько списывается с баланса пользователя. Считается всегда по «часу пик»
 * (это и есть цена из PRICING) с внутренним коэффициентом. Коэффициент, как и
 * сами цены, наружу не выводится: ни в интерфейсе, ни в ответах ассистента.
 */
export const BILLING = {
  multiplier: Number(process.env.DSHOW_BILL_MULTIPLIER || 2),
  /** Стартовый баланс старых пользователей при первом включении счётчика. */
  migrationCreditUsd: Number(process.env.DSHOW_START_CREDIT_USD || 20),
};

export function chargeUsd(tokensIn = 0, tokensOut = 0) {
  const raw = costUsd(tokensIn, tokensOut) * (Number.isFinite(BILLING.multiplier) ? BILLING.multiplier : 2);
  return Number(raw.toFixed(6));
}

/**
 * Порог «тяжёлой» задачи: стоимость ОДНОЙ задачи. Пока задача дешевле порога,
 * она идёт молча, в фоне, без уведомлений. Когда перевалила — работа
 * приостанавливается, пользователь получает предупреждение, а администратор
 * запрос на подтверждение. Порог — $10 на задачу: этого хватает на большой
 * проект (десятки документов и страниц), и до него ничего согласовывать не
 * нужно. Смысл именно в дорогих задачах, а не в накопленном расходе проекта:
 * сотня мелких задач не должна упираться в лимит.
 */
function usdFromEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export const BUDGET = {
  limitUsd: usdFromEnv('DSHOW_TASK_LIMIT_USD', 10),
  /** Сколько добавляется к порогу после одобрения администратора. */
  stepUsd: usdFromEnv('DSHOW_TASK_STEP_USD', 10),
};

/**
 * Порог для одной задачи с учётом того, что администратор уже разрешил.
 * Одобрение может только ПОДНЯТЬ порог: крошечные значения, оставшиеся от
 * ранних версий (например, $0.0005 в старых проектах), не опускают его до нуля —
 * иначе дешёвая задача сразу упирается в «лимит $0.00» и уходит на подтверждение.
 */
export function taskLimitUsd(storedBudgetUsd) {
  const stored = Number(storedBudgetUsd);
  return Number.isFinite(stored) && stored > BUDGET.limitUsd ? stored : BUDGET.limitUsd;
}

/** Уведомления администратору в Telegram (бот «Василина»). */
export const TELEGRAM = {
  token: process.env.DSHOW_TG_TOKEN || '',
  chatId: process.env.DSHOW_TG_CHAT || '660339011',
  publicUrl: process.env.DSHOW_PUBLIC_URL || 'https://dshopen-vladimir00177.msk1.amvera.tech',
};

/**
 * Цепочка бесплатных визуальных моделей для распознавания изображений.
 * Используется только на стороне сервера.
 */
export const VISION = {
  baseURL: 'https://openrouter.ai/api/v1',
  timeoutMs: 45000,
  totalBudgetMs: 100000,
  attemptsPerModel: 2,
  maxTokens: 3000,
  maxImageBytes: 8 * 1024 * 1024,
  models: [
    'dots-studio/dots-3-note-preview:free',
    'qwen/qwen3.8-27b:free',
    'inclusionai/ling-3.0-flash-vl',
    'google/gemini-2.5-flash',
    'google/gemma-3-12b-it',
  ],
};

export const ADMIN = {
  username: process.env.DSHOW_ADMIN_USER || 'DSHOPENWEB',
  password: process.env.DSHOW_ADMIN_PASSWORD || '',
  displayName: 'Администратор',
};

/**
 * Распознавание речи. Как и визуальные модели — только на сервере.
 * Первыми идут бесплатные модели, дальше дешёвый резерв.
 */
export const ASR = {
  baseURL: 'https://openrouter.ai/api/v1',
  timeoutMs: 45000,
  attemptsPerModel: 2,
  maxTokens: 1600,
  maxAudioBytes: 16 * 1024 * 1024,
  models: [
    'google/gemini-2.5-flash-lite',
    'mistralai/voxtral-small-24b-2507',
    'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
  ],
};

export function ensureDirs() {
  for (const dir of [DATA_DIR, WORKSPACES_DIR, CHATS_DIR, UPLOADS_DIR, LOGS_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function dataHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}
