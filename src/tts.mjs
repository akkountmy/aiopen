/**
 * Озвучка документов: книга или отчёт превращаются в MP3, который можно
 * слушать в плеере телефона по дороге.
 *
 * Устройство простое и намеренно без внешних сервисов с ключами:
 *   1. текст документа режется на куски по границам предложений;
 *   2. каждый кусок синтезируется нейроголосом Edge (`src/edge-tts.mjs`);
 *   3. куски склеиваются в один MP3 — формат и битрейт у сервиса постоянные,
 *      поэтому склейка даёт валидный файл без перекодирования (ffmpeg не нужен).
 *
 * Ошибки лечатся на трёх уровнях: повтор куска с паузой, подстройка часов при
 * 403 от сервиса (см. `edge-tts.mjs`) и полный переход на резервный движок
 * Google, если Edge недоступен целиком. Смешивать движки внутри одного файла
 * нельзя: у Google другая частота дискретизации, и время в плеере поедет —
 * поэтому переключение делается только на первом куске.
 */

import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { listVoices, synthesizeChunk } from './edge-tts.mjs';

/** Голоса, которые предлагаем по умолчанию: остальные 300 — избыточный выбор. */
export const VOICE_CHOICES = [
  {
    id: 'ru-RU-SvetlanaNeural',
    label: 'Светлана — женский, спокойный',
    hint: 'Лучший выбор для книги: ровная интонация, не утомляет на длинной главе.',
    locale: 'ru-RU',
  },
  {
    id: 'ru-RU-DmitryNeural',
    label: 'Дмитрий — мужской, низкий',
    hint: 'Плотный голос для деловых документов и отчётов.',
    locale: 'ru-RU',
  },
  {
    id: 'en-US-AriaNeural',
    label: 'Aria — английский, женский',
    hint: 'Для англоязычных книг и статей.',
    locale: 'en-US',
  },
  {
    id: 'en-US-GuyNeural',
    label: 'Guy — английский, мужской',
    hint: 'Для англоязычных книг и статей.',
    locale: 'en-US',
  },
];

export const DEFAULT_VOICE = 'ru-RU-SvetlanaNeural';

/** Темп: множитель → как его понимает сервис. */
export const RATE_CHOICES = [
  { id: '0.85', label: 'Медленнее — для сложного текста' },
  { id: '0.9', label: 'Чуть медленнее' },
  { id: '1', label: 'Обычный темп' },
  { id: '1.15', label: 'Чуть быстрее' },
  { id: '1.3', label: 'Быстро — для знакомого материала' },
];
export const DEFAULT_RATE = '1';

/* Кусок в 700 знаков — это примерно минута речи: короткие куски дают ровное
   произношение и частый прогресс, длинные сервис иногда обрывает по таймауту. */
const EDGE_CHUNK = 700;
const GOOGLE_CHUNK = 180;
/** Потолок на одну озвучку: 400 000 знаков — это около 10 часов звука. */
export const MAX_TTS_CHARS = 400_000;

const CHUNK_ATTEMPTS = 3;
const RETRY_BASE_MS = 1200;
/**
 * Сколько кусков синтезируем одновременно.
 *
 * Узкое место — не процессор, а сеть до сервиса: один кусок отвечает от
 * секунды до сорока, и на 0.1 ядра тарифа разница между двумя и тремя
 * параллельными запросами видна в минутах. Память при этом почти не растёт:
 * кусок — сотни килобайт, и он сразу уходит на диск.
 */
const WORKERS = Math.min(4, Math.max(1, Number(process.env.DSHOW_TTS_WORKERS) || 3));
/** Сколько ждём хоть какого-то движения, прежде чем честно позвать на помощь. */
const STALL_MS = 5 * 60 * 1000;
/** Сколько задание может простоять в очереди, пока другие занимают слоты. */
const QUEUE_WAIT_MS = 20 * 60 * 1000;
/** Версия журнала: старые файлы после больших правок просто не читаем. */
const JOURNAL_VERSION = 1;

const ABBREVIATIONS = new Set([
  'г',
  'гг',
  'т',
  'тт',
  'д',
  'др',
  'проф',
  'акад',
  'ул',
  'пер',
  'пр',
  'им',
  'рис',
  'табл',
  'стр',
  'с',
  'см',
  'тыс',
  'млн',
  'млрд',
  'руб',
  'коп',
  'т.е',
  'т.к',
  'т.д',
  'т.п',
  'др',
  'ред',
  'изд',
  'напр',
  'англ',
]);

/** Приводит текст документа к виду, удобному для чтения вслух. */
export function normalizeText(raw) {
  let text = String(raw || '');
  text = text.replace(/\r\n?/g, '\n');
  /* Переносы внутри абзаца — это вёрстка книги, а не пауза: склеиваем строки,
     кроме пустых (пустая строка = новый абзац). */
  text = text.replace(/([^\n])\n(?![ \t\n])/g, '$1 ');
  text = text.replace(/[ \t\u00a0]+/g, ' ');
  /* Мягкие переносы и «висячие» дефисы от вёрстки: «слово-\nпродолжение». */
  text = text.replace(/(\p{L})-\s+(\p{Ll})/gu, '$1$2');
  /* Сноски, номера страниц в колонтитулах и служебные пометки книг. */
  text = text.replace(/^\s*\d{1,4}\s*$/gm, '');
  text = text.replace(/^[•·▪]\s*/gm, '');
  /* Колонтитулы и метаданные docx — не текст книги: иначе диктор читает
     «стр. 3 из 12» и название файла посреди главы. */
  text = text.replace(/^\[(?:Колонтитул|Нижний колонтитул)\][^\n]*$/gm, '');
  text = text.replace(/^Заголовок документа:[^\n]*$/gm, '');
  text = text.replace(/\n{3,}/g, '\n\n');
  return text.trim();
}

/** Режет текст на куски не длиннее `maxLength`, стараясь рвать по предложениям. */
export function chunkText(text, maxLength = EDGE_CHUNK) {
  const clean = normalizeText(text);
  if (!clean) return [];
  const sentences = [];
  let buffer = '';
  for (const char of clean) {
    buffer += char;
    if (/[.!?…]/.test(char)) {
      /* Точка в «т. д.» или инициалах не закрывает предложение. */
      const tail = buffer.trimEnd();
      const lastWord = tail.split(/[\s(«"']+/).pop() || '';
      const token = lastWord.replace(/[.!?…]+$/, '').toLowerCase();
      if (char === '.' && ABBREVIATIONS.has(token)) continue;
      sentences.push(buffer);
      buffer = '';
    }
  }
  if (buffer.trim()) sentences.push(buffer);

  const chunks = [];
  let current = '';
  const push = () => {
    const value = current.trim();
    if (value) chunks.push(value);
    current = '';
  };
  for (const sentence of sentences) {
    if (sentence.length > maxLength) {
      push();
      for (const piece of splitLong(sentence, maxLength)) chunks.push(piece);
      continue;
    }
    if (current && current.length + sentence.length > maxLength) push();
    current += sentence;
  }
  push();
  return chunks;
}

/** Предложение длиннее куска (бывает в юридических текстах) режем по запятым. */
function splitLong(sentence, maxLength) {
  const out = [];
  let current = '';
  for (const part of sentence.split(/(?<=[,;:—–-])\s+/)) {
    if (part.length > maxLength) {
      /* Совсем без знаков: режем по словам, чтобы не разорвать слово. */
      let rest = part;
      while (rest.length > maxLength) {
        let cut = rest.lastIndexOf(' ', maxLength);
        if (cut < maxLength / 2) cut = maxLength;
        out.push(rest.slice(0, cut).trim());
        rest = rest.slice(cut).trim();
      }
      if (current && current.length + rest.length > maxLength) {
        out.push(current.trim());
        current = '';
      }
      current += `${rest} `;
      continue;
    }
    if (current && current.length + part.length > maxLength) {
      out.push(current.trim());
      current = '';
    }
    current += `${part} `;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

/** Множитель темпа → строка для сервиса («0.9» → «-10%»). */
export function ratePercent(rate) {
  const value = Number(rate);
  if (!Number.isFinite(value) || value <= 0) return '+0%';
  const percent = Math.round((value - 1) * 100);
  return `${percent >= 0 ? '+' : ''}${percent}%`;
}

/**
 * Длительность MP3 без ffmpeg: считаем кадры по заголовку.
 * Битрейт и частота у наших файлов постоянные, но парсим честно — файл может
 * прийти и из резервного движка с другими параметрами.
 */
export function mp3Duration(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return 0;
  let offset = 0;
  /* ID3v2 в начале файла пропускаем: у него свой размер в заголовке. */
  if (buffer.subarray(0, 3).toString('latin1') === 'ID3') {
    const size = ((buffer[6] & 0x7f) << 21) | ((buffer[7] & 0x7f) << 14) | ((buffer[8] & 0x7f) << 7) | (buffer[9] & 0x7f);
    offset = 10 + size;
  }
  const bitrates = {
    '1-1': [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
    '1-2': [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
    '1-3': [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
    '2-1': [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
    '2-2': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
    '2-3': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  };
  const sampleRates = { 1: [44100, 48000, 32000], 2: [22050, 24000, 16000], 25: [11025, 12000, 8000] };
  let frames = 0;
  let seconds = 0;
  let guard = 0;
  while (offset + 4 <= buffer.length && guard < 2_000_000) {
    guard += 1;
    if (buffer[offset] !== 0xff || (buffer[offset + 1] & 0xe0) !== 0xe0) {
      offset += 1;
      continue;
    }
    const versionBits = (buffer[offset + 1] >> 3) & 0x03;
    const layerBits = (buffer[offset + 1] >> 1) & 0x03;
    const version = versionBits === 3 ? 1 : versionBits === 2 ? 2 : versionBits === 0 ? 25 : 0;
    const layer = 4 - layerBits;
    if (!version || !layerBits || layerBits === 4) {
      offset += 1;
      continue;
    }
    const bitrateIndex = (buffer[offset + 2] >> 4) & 0x0f;
    const rateIndex = (buffer[offset + 2] >> 2) & 0x03;
    if (!bitrateIndex || bitrateIndex === 15 || rateIndex === 3) {
      offset += 1;
      continue;
    }
    const table = bitrates[`${version === 25 ? 2 : version}-${layer}`];
    const bitrate = table ? table[bitrateIndex] * 1000 : 0;
    const sampleRate = sampleRates[version][rateIndex];
    if (!bitrate || !sampleRate) {
      offset += 1;
      continue;
    }
    const padding = (buffer[offset + 2] >> 1) & 0x01;
    /* Длина кадра: у MPEG-1 коэффициент 144, у MPEG-2/2.5 — 72 (тот же кадр,
       вдвое меньшая частота дискретизации). Для Layer I коэффициент 12. */
    const coefficient = layer === 1 ? 12 : version === 1 ? 144 : 72;
    const frameLength = Math.floor((coefficient * bitrate) / sampleRate) + padding;
    if (frameLength <= 4) {
      offset += 1;
      continue;
    }
    /* Отсчётов в кадре: Layer II всегда 1152, Layer III у MPEG-1 — 1152,
       у MPEG-2/2.5 — 576. */
    const samples = layer === 1 ? 384 : layer === 3 && version !== 1 ? 576 : 1152;
    seconds += samples / sampleRate;
    frames += 1;
    offset += frameLength;
  }
  return frames ? Number(seconds.toFixed(2)) : 0;
}

/** Секунды → «2 ч 14 мин»: так длительность понятна без калькулятора. */
export function humanDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;
  if (hours) return `${hours} ч ${String(minutes).padStart(2, '0')} мин`;
  if (minutes) return `${minutes} мин ${String(rest).padStart(2, '0')} с`;
  return `${rest} с`;
}

/* ─────────────────────────── резервный движок ─────────────────────────── */

/**
 * Google translate_tts: без ключа и без токена, но недокументированный.
 * Держим как страховку — голос роботизированнее, зато сервис отвечает почти
 * всегда. Частота дискретизации здесь 24 кГц, поэтому переключаться на него
 * можно только целиком, а не в середине книги.
 */
export async function googleSpeak({ text, lang = 'ru', timeoutMs = 30000 }) {
  const url =
    'https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob' +
    `&tl=${encodeURIComponent(lang)}&q=${encodeURIComponent(text)}&total=1&idx=0&textlen=${text.length}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36',
        Referer: 'https://translate.google.com/',
        Accept: 'audio/mpeg,*/*',
      },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Резервный синтез: HTTP ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length < 1000) throw new Error('Резервный синтез: пустой звук');
    return buffer;
  } finally {
    clearTimeout(timer);
  }
}

/* ─────────────────────────────── голоса ─────────────────────────────── */

let voiceCache = { at: 0, list: null };

/** Голоса сервиса с кешем на сутки; при сбое сети отдаём хотя бы встроенный список. */
export async function voiceCatalog() {
  if (voiceCache.list && Date.now() - voiceCache.at < 24 * 3600 * 1000) return voiceCache.list;
  try {
    const live = await listVoices();
    voiceCache = { at: Date.now(), list: live };
    return live;
  } catch {
    return VOICE_CHOICES.map((voice) => ({
      name: voice.id,
      locale: voice.locale,
      gender: '',
      friendly: voice.label,
      local: voice.locale.split('-')[0],
    }));
  }
}

/* ─────────────────────────────── задания ─────────────────────────────── */

const jobs = new Map();
/** Ограничитель: одновременно синтезируем не больше двух книг. */
let running = 0;
const pending = [];

function queueJob(job) {
  pending.push(job);
  drain();
}

function drain() {
  while (running < WORKERS && pending.length) {
    const job = pending.shift();
    running += 1;
    runJob(job)
      .catch(() => {})
      .finally(() => {
        running -= 1;
        drain();
      });
  }
}

function hashKey(parts) {
  const hash = createHash('sha1');
  for (const part of parts) hash.update(String(part));
  return hash.digest('hex').slice(0, 20);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Публичное состояние задания: без внутренних полей и буферов. */
export function publicJob(job) {
  if (!job) return null;
  return {
    id: job.id,
    title: job.title,
    status: job.status,
    provider: job.provider,
    voice: job.voice,
    rate: job.rate,
    chars: job.chars,
    chunks: job.chunks,
    doneChunks: job.doneChunks,
    percent: job.percent,
    stage: job.stage,
    seconds: job.seconds,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    file: job.file ? { ...job.file } : null,
    word: job.wordPath ? { name: path.basename(job.wordPath) } : null,
    parts: job.parts.map((part) => ({
      index: part.index,
      label: part.label,
      chars: part.chars,
      minutes: Math.round((part.chars / CHARS_PER_MINUTE) * 10) / 10,
      status: part.status,
      name: part.file?.name || path.basename(part.outPath || ''),
      size: part.file?.size || part.writtenBytes || 0,
      seconds: part.file?.seconds || part.seconds || 0,
      duration: part.file?.duration || humanDuration(part.seconds || 0),
      writtenChunks: part.writtenChunks || 0,
      totalChunks: (part.chunks || []).length,
      /* Файл уже лежит в папке, но часть ещё дописывается: слушать можно,
         конец появится через несколько минут. */
      partial: part.status === 'running' && (part.writtenBytes || 0) > 0,
      cached: Boolean(part.file?.cached),
    })),
    files: job.files.map((file) => ({ ...file })),
    partIndex: job.partIndex,
    error: job.error || '',
    warnings: job.warnings.slice(),
    etaSeconds: job.etaSeconds,
    /* Сколько раз задание поднимали после перезапуска приложения: по этому
       числу видно, что озвучка не потерялась, а продолжилась. */
    resumed: job.resumed || 0,
  };
}

export function getJob(id, ownerId) {
  const job = jobs.get(String(id));
  if (!job || (ownerId && job.ownerId !== ownerId)) return null;
  return job;
}

export function cancelJob(id, ownerId) {
  const job = getJob(id, ownerId);
  if (!job) return null;
  if (job.status === 'running' || job.status === 'queued') {
    job.cancelled = true;
    job.stage = 'Останавливаю';
    const index = pending.indexOf(job);
    if (index >= 0) pending.splice(index, 1);
    if (job.status === 'queued') finish(job, 'cancelled');
  }
  return job;
}

export function jobsFor(ownerId) {
  return [...jobs.values()].filter((job) => job.ownerId === ownerId).map(publicJob);
}

/**
 * Уже идущая озвучка того же файла — вместо второго задания.
 *
 * Два задания на один MP3 пишут в один и тот же файл с двух сторон: куски
 * перемешиваются, звук рвётся, а оба ответа говорят «готово». Повторная просьба
 * (человек нажал кнопку дважды, агент переспросил после перезапуска) должна
 * возвращать то задание, которое уже работает.
 */
export function findActiveNarration(ownerId, outPaths) {
  const wanted = (Array.isArray(outPaths) ? outPaths : [outPaths])
    .filter(Boolean)
    .map((item) => path.resolve(String(item)));
  if (!wanted.length) return null;
  for (const job of jobs.values()) {
    if (job.ownerId !== ownerId) continue;
    if (job.status !== 'running' && job.status !== 'queued') continue;
    /* Остановленное задание уже не пишет в файл: человек вправе запустить заново
       сразу после «Остановить», не дожидаясь, пока оно закроется. */
    if (job.cancelled) continue;
    const own = (job.parts || []).map((part) => (part.outPath ? path.resolve(part.outPath) : '')).filter(Boolean);
    if (own.some((item) => wanted.includes(item))) return job;
  }
  return null;
}

/** Чистка памяти: готовые задания живут час, этого хватает интерфейсу. */
const jobCleaner = setInterval(() => {
  const limit = Date.now() - 60 * 60 * 1000;
  for (const [id, job] of jobs) {
    if (job.finishedAt && job.finishedAt < limit) {
      jobs.delete(id);
      forgetJournal(id);
    }
  }
}, 10 * 60 * 1000);
if (typeof jobCleaner.unref === 'function') jobCleaner.unref();

/**
 * Сторож: молчащий синтез не должен висеть часами.
 *
 * Бывает, что соединение с сервисом зависло, а человек уже закрыл вкладку:
 * без сторожа задание висело бы «в процессе» до следующего перезапуска, и
 * человек так и не узнал бы, что файла не будет. Здесь задание честно падает
 * с причиной — её видно и в окне озвучки, и в tts_status.
 */
const stallGuard = setInterval(() => {
  const now = Date.now();
  for (const job of jobs.values()) {
    if (job.settled) continue;
    if (job.status === 'running' && now - (job.heartbeatAt || job.startedAt || now) > STALL_MS) {
      job.cancelled = true;
      job.error = `Синтез не отвечал ${Math.round(STALL_MS / 60000)} мин — остановил, чтобы не врать про готовый файл. Уже записанное осталось в файле; запустите озвучку ещё раз.`;
      finish(job, 'failed');
    } else if (job.status === 'queued' && now - (job.startedAt || now) > QUEUE_WAIT_MS) {
      const index = pending.indexOf(job);
      if (index >= 0) pending.splice(index, 1);
      job.cancelled = true;
      job.error = 'Озвучка простояла в очереди 20 минут — другие задания занимали все слоты. Запустите её ещё раз.';
      finish(job, 'failed');
    }
  }
}, 30 * 1000);
if (typeof stallGuard.unref === 'function') stallGuard.unref();

/* ───────────────────────── журнал заданий на диске ───────────────────────── */

/**
 * Задание живёт в памяти, а память контейнера не переживает развёртывание.
 *
 * Раньше это выглядело так: человек просит озвучку, агент отвечает «запущено»,
 * облако поднимает новую версию — и MP3 не появляется никогда, потому что
 * задание исчезло вместе со старым процессом. Теперь состояние пишется в
 * `<данные>/tts-jobs/<id>.json`, а на старте незакрытые задания возвращаются
 * в очередь и продолжаются с того же куска.
 */
let journalDir = '';

/** Куда складывать журнал озвучек. Вызывается один раз при старте сервера. */
export function setNarrationJournal(dir) {
  journalDir = dir ? path.resolve(dir) : '';
  if (!journalDir) return '';
  try {
    fs.mkdirSync(journalDir, { recursive: true });
  } catch {
    journalDir = '';
  }
  return journalDir;
}

export function narrationJournalDir() {
  return journalDir;
}

let lastResume = { resumed: 0, restored: 0, failed: 0 };

/** Что известно про журнал озвучек: для /api/health, без текстов и адресов. */
export function narrationStatus() {
  const active = [...jobs.values()].filter((job) => job.status === 'queued' || job.status === 'running').length;
  return {
    journal: Boolean(journalDir),
    resumedAfterRestart: lastResume.resumed,
    restoredFromJournal: lastResume.restored,
    active,
  };
}

function journalSnapshot(job) {
  return {
    version: JOURNAL_VERSION,
    id: job.id,
    ownerId: job.ownerId || null,
    title: job.title,
    voice: job.voice,
    rate: job.rate,
    provider: job.provider,
    outPath: job.outPath,
    wordPath: job.wordPath,
    sourcePath: job.sourcePath,
    cacheDir: job.cacheDir,
    status: job.status,
    stage: job.stage,
    chars: job.chars,
    chunks: job.chunks,
    doneChunks: job.doneChunks,
    percent: job.percent,
    seconds: job.seconds,
    etaSeconds: job.etaSeconds,
    partIndex: job.partIndex,
    file: job.file || null,
    files: job.files || [],
    error: job.error || '',
    warnings: job.warnings || [],
    resumed: job.resumed || 0,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    updatedAt: Date.now(),
    parts: (job.parts || []).map((part) => ({
      index: part.index,
      label: part.label,
      text: part.text,
      outPath: part.outPath,
      chars: part.chars,
      status: part.status,
      writtenChunks: part.writtenChunks || 0,
      writtenBytes: part.writtenBytes || 0,
      seconds: part.seconds || 0,
      file: part.file || null,
    })),
  };
}

/** Сохраняет состояние задания: страховка от перезапуска, ошибки не страшны. */
function saveJournal(job) {
  if (!journalDir || !job?.id) return;
  const file = path.join(journalDir, `${job.id}.json`);
  try {
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(journalSnapshot(job)), 'utf8');
    fs.renameSync(`${file}.tmp`, file);
  } catch {
    /* журнал — страховка: без него озвучка всё равно идёт */
  }
}

function forgetJournal(id) {
  if (!journalDir || !id) return;
  try {
    fs.rmSync(path.join(journalDir, `${id}.json`), { force: true });
    fs.rmSync(path.join(journalDir, `${id}.json.tmp`), { force: true });
  } catch {
    /* файла уже нет */
  }
}

/**
 * Возвращает в работу всё, что не успело закончиться до перезапуска.
 *
 * Части, записанные раньше, не синтезируются заново: у них есть файл на диске
 * и число записанных кусков. Часть, оборванная на середине, продолжается с
 * первого недописанного куска — файл к этому моменту уже обрезан до целой
 * границы, поэтому конец не хрустит.
 */
export function resumeNarrations() {
  if (!journalDir) return { resumed: 0, restored: 0, failed: 0 };
  let names = [];
  try {
    names = fs.readdirSync(journalDir);
  } catch {
    return { resumed: 0, restored: 0, failed: 0 };
  }
  const keepMs = 60 * 60 * 1000;
  let resumed = 0;
  let restored = 0;
  let failed = 0;
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(journalDir, name);
    let saved = null;
    try {
      saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      forgetJournal(name.replace(/\.json$/, ''));
      continue;
    }
    if (!saved?.id || saved.version !== JOURNAL_VERSION || !Array.isArray(saved.parts) || !saved.parts.length) {
      forgetJournal(name.replace(/\.json$/, ''));
      continue;
    }
    const unfinished = saved.status === 'queued' || saved.status === 'running';
    if (!unfinished && saved.finishedAt && Date.now() - saved.finishedAt > keepMs) {
      forgetJournal(saved.id);
      continue;
    }
    const job = {
      ...saved,
      parts: saved.parts.map((part) => ({
        ...part,
        writtenChunks: Math.max(0, Math.trunc(part.writtenChunks || 0)),
        writtenBytes: Math.max(0, Math.trunc(part.writtenBytes || 0)),
        seconds: Number(part.seconds) || 0,
      })),
      warnings: Array.isArray(saved.warnings) ? saved.warnings.slice() : [],
      files: Array.isArray(saved.files) ? saved.files.slice() : [],
      cancelled: false,
      settled: false,
      heartbeatAt: Date.now(),
    };
    jobs.set(job.id, job);
    restored += 1;
    if (!unfinished) continue;

    /* Файл мог не дожить до диска: тогда часть честно начинается заново. */
    for (const part of job.parts) {
      const alive = part.outPath && existsAudio(part.outPath);
      if (part.status === 'done' && !alive) {
        part.status = 'queued';
        part.writtenChunks = 0;
        part.writtenBytes = 0;
        part.seconds = 0;
        part.file = null;
      }
      if (part.status !== 'done' && alive && part.writtenChunks > 0) {
        /* Проверяем, что в файле действительно столько байт. */
        try {
          if (fs.statSync(part.outPath).size < part.writtenBytes) {
            part.writtenChunks = 0;
            part.writtenBytes = 0;
            part.seconds = 0;
          }
        } catch {
          part.writtenChunks = 0;
          part.writtenBytes = 0;
        }
      }
      if (part.status === 'running') part.status = 'queued';
    }
    job.files = job.parts.filter((part) => part.status === 'done' && part.file).map((part) => part.file);
    job.status = 'queued';
    job.stage = 'Продолжаю после перезапуска';
    job.error = '';
    job.finishedAt = 0;
    job.resumed = (job.resumed || 0) + 1;
    job.settled = false;
    saveJournal(job);
    resumed += 1;
    queueJob(job);
  }
  if (resumed) {
    /* В журнал облака это не попадёт (stdout не читается через API), но в
       локальном запуске строка сразу объясняет, что происходит. */
    console.log(`[tts] продолжил после перезапуска: ${resumed} заданий`);
  }
  lastResume = { resumed, restored, failed };
  return { resumed, restored, failed };
}

function existsAudio(file) {
  if (!file) return false;
  try {
    return fs.statSync(file).size > 1000;
  } catch {
    return false;
  }
}

function finish(job, status, patch = {}) {
  if (job.settled) return;
  Object.assign(job, patch);
  job.settled = true;
  job.status = status;
  job.finishedAt = Date.now();
  if (status === 'done') {
    job.percent = 100;
    job.stage = 'Готово';
  } else if (status === 'cancelled') {
    job.stage = 'Остановлено';
  }
  saveJournal(job);
}

/**
 * Ставит озвучку в очередь.
 *
 * Документ режется на части (`parts`, по ~30 минут звука), каждая часть
 * синтезируется в свой MP3 и сразу появляется в папке проекта — не нужно ждать
 * пять часов, чтобы начать слушать. `outPath` — имя MP3 для одного файла;
 * для нескольких частей сервер передаёт `parts` со своими путями.
 */
export function startNarration({ ownerId, title, text, voice, rate, outPath, parts, wordPath = '', sourcePath = '', cacheDir = '' }) {
  const clean = normalizeText(text ?? (parts || []).map((part) => part.text).join('\n\n'));
  const plan = (parts && parts.length ? parts : [{ text: clean, outPath, label: '' }]).map((part, index) => ({
    index: index + 1,
    text: normalizeText(part.text),
    outPath: part.outPath || outPath,
    label: part.label || '',
    chars: normalizeText(part.text).length,
    status: 'queued',
    file: null,
    /* Сколько кусков этой части уже записано в файл: по этим числам озвучка
       продолжается с места остановки, а не начинается заново. */
    writtenChunks: 0,
    writtenBytes: 0,
    seconds: 0,
  }));
  if (!plan.length || plan.every((part) => !part.text)) {
    const error = new Error('В документе нет текста для озвучки');
    error.status = 400;
    throw error;
  }
  const total = plan.reduce((sum, part) => sum + part.chars, 0);
  if (total > MAX_TTS_CHARS) {
    const error = new Error(`Документ слишком большой для одной озвучки: ${total} знаков при потолке ${MAX_TTS_CHARS}`);
    error.status = 400;
    throw error;
  }
  const job = {
    id: randomUUID().replace(/-/g, '').slice(0, 16),
    ownerId,
    title,
    text: clean,
    chars: total,
    voice: VOICE_CHOICES.some((item) => item.id === voice) ? voice : DEFAULT_VOICE,
    rate: RATE_CHOICES.some((item) => item.id === String(rate)) ? String(rate) : DEFAULT_RATE,
    outPath,
    wordPath,
    parts: plan,
    partIndex: 0,
    files: [],
    sourcePath,
    cacheDir,
    provider: 'edge',
    status: 'queued',
    stage: 'В очереди',
    chunks: 0,
    doneChunks: 0,
    percent: 0,
    etaSeconds: null,
    seconds: 0,
    file: null,
    error: '',
    warnings: [],
    cancelled: false,
    settled: false,
    resumed: 0,
    heartbeatAt: Date.now(),
    startedAt: Date.now(),
    finishedAt: 0,
  };
  jobs.set(job.id, job);
  /* Журнал пишем до старта: если контейнер перезапустится через секунду,
     задание всё равно вернётся в работу, а не исчезнет. */
  saveJournal(job);
  queueJob(job);
  return job;
}

/** Сводит прогресс к частям: каждый кусок считается один раз, даже после resume. */
function recount(job) {
  let done = 0;
  let seconds = 0;
  for (const part of job.parts) {
    done += Math.min(part.writtenChunks || 0, (part.chunks || []).length);
    if (part.status === 'done') seconds += Number(part.seconds || part.file?.seconds || 0) || 0;
  }
  job.doneChunks = done;
  job.seconds = Math.round(seconds * 10) / 10;
  if (job.chunks) job.percent = Math.min(99, Math.round((done / job.chunks) * 100));
  return done;
}

function partCacheKey(job, part) {
  if (!job.cacheDir) return '';
  return hashKey([job.voice, job.rate, job.provider, part.chars, part.text.slice(0, 4000), part.text.length]);
}

/** Длительность готовой части из кеша: рядом лежит побочный файл с числами. */
function cachedPartSeconds(cached) {
  try {
    const sidecar = JSON.parse(fs.readFileSync(`${cached}.json`, 'utf8'));
    if (Number(sidecar?.seconds) > 0) return Number(sidecar.seconds);
  } catch {
    /* побочного файла нет — посчитаем по кадрам */
  }
  try {
    return mp3Duration(fs.readFileSync(cached));
  } catch {
    return 0;
  }
}

/** Часть готова: файл уже на диске, осталось записать это в задание. */
function finishPart(job, part, seconds, cached) {
  const size = fs.statSync(part.outPath).size;
  if (size < 2000) throw new Error('Сервис вернул пустой звук');
  part.status = 'done';
  part.seconds = seconds;
  part.writtenChunks = part.chunks.length;
  part.writtenBytes = size;
  part.file = {
    index: part.index,
    label: part.label,
    name: path.basename(part.outPath),
    size,
    seconds,
    duration: humanDuration(seconds),
    cached: Boolean(cached),
  };
  if (!job.files.some((file) => file.name === part.file.name)) job.files.push(part.file);
  if (!seconds) job.warnings.push(`Длительность части ${part.index} не определилась.`);
  recount(job);
  job.stage = job.parts.length > 1 ? `Часть ${part.index} готова` : 'Файл готов';
  job.heartbeatAt = Date.now();
  saveJournal(job);
}

/**
 * Синтез части сразу в файл.
 *
 * Куски пишутся на диск по порядку, как только готовы, поэтому MP3 появляется
 * в папке проекта через секунды после старта и растёт по мере синтеза. Раньше
 * файл создавался один раз в самом конце: если контейнер перезапускался или
 * сервис зависал, от получаса работы не оставалось ничего.
 *
 * При обрыве в файле остаётся всё уже сказанное, а числа `writtenChunks` /
 * `writtenBytes` позволяют потом дописать ровно с этого места.
 */
async function writePartAudio(job, part) {
  const chunks = part.chunks;
  fs.mkdirSync(path.dirname(part.outPath), { recursive: true });

  let start = Math.max(0, Math.min(part.writtenChunks || 0, chunks.length));
  let fileSize = -1;
  try {
    fileSize = fs.statSync(part.outPath).size;
  } catch {
    fileSize = -1;
  }
  /* Продолжаем только если в файле ровно столько байт, сколько обещал журнал:
     иначе файл сдвинулся и склейка получится со мусором в середине. */
  if (start > 0 && (fileSize < (part.writtenBytes || 0) || fileSize < 1000)) start = 0;
  if (start > 0 && !part.writtenBytes) start = 0;
  if (start > 0) {
    try {
      fs.truncateSync(part.outPath, part.writtenBytes || 0);
    } catch {
      start = 0;
    }
  }
  if (!start) {
    /* Файл не создаём заранее: пустой MP3 в папке проекта выглядел бы как
       сломанная озвучка. Убираем и старый звук прошлого запуска — иначе человек
       начинал бы слушать прошлую версию, а новый файл подменил бы её посреди
       прослушивания. Новый появится вместе с первым готовым куском. */
    try {
      fs.unlinkSync(part.outPath);
    } catch {
      /* файла не было — и хорошо */
    }
    part.writtenChunks = 0;
    part.writtenBytes = 0;
    part.seconds = 0;
  }

  let offset = part.writtenBytes || 0;
  let seconds = part.seconds || 0;
  const ready = new Map();
  let failure = null;
  let cursor = start;
  const startedAt = Date.now();
  let fd = start && part.writtenBytes ? fs.openSync(part.outPath, 'r+') : null;

  const flush = () => {
    let written = false;
    while (ready.has(part.writtenChunks)) {
      const buffer = ready.get(part.writtenChunks);
      ready.delete(part.writtenChunks);
      /* Дескриптор открывается на первом куске: до этого файла ещё нет. */
      if (fd === null) fd = fs.openSync(part.outPath, 'w');
      fs.writeSync(fd, buffer, 0, buffer.length, offset);
      offset += buffer.length;
      part.writtenBytes = offset;
      part.writtenChunks += 1;
      seconds += mp3Duration(buffer);
      part.seconds = Math.round(seconds * 10) / 10;
      written = true;
    }
    if (!written) return;
    job.heartbeatAt = Date.now();
    recount(job);
    const doneNow = Math.max(1, part.writtenChunks - start);
    const spent = (Date.now() - startedAt) / 1000;
    const left = Math.max(0, (job.chunks || chunks.length) - job.doneChunks);
    job.etaSeconds = Math.round((spent / doneNow) * left);
    /* Файл в папке проекта обновляется на каждом куске — плеер видит рост. */
    saveJournal(job);
  };

  const worker = async () => {
    for (;;) {
      if (failure || job.cancelled) return;
      const index = cursor;
      cursor += 1;
      if (index >= chunks.length) return;
      if (index < part.writtenChunks) continue;
      try {
        const buffer = await speakWithRetry(job, chunks[index], index);
        if (job.cancelled) return;
        ready.set(index, buffer);
        flush();
      } catch (error) {
        failure = error;
        return;
      }
    }
  };

  try {
    const workers = Math.max(1, Math.min(WORKERS, chunks.length - start));
    await Promise.all(Array.from({ length: workers }, () => worker()));
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* дескриптор мог закрыться сам */
      }
    }
  }
  if (failure) throw failure;
  if (job.cancelled) throw Object.assign(new Error('Остановлено'), { cancelled: true });
  if (part.writtenChunks < chunks.length) throw new Error('Синтез оборвался на середине части');
  return seconds;
}

async function runJob(job) {
  if (job.cancelled) return finish(job, 'cancelled');
  job.status = 'running';
  job.stage = 'Разбираю текст';
  job.heartbeatAt = Date.now();
  job.settled = false;
  saveJournal(job);
  const many = job.parts.length > 1;
  try {
    /* Общий счётчик кусков: прогресс в интерфейсе один на всю книгу. */
    for (const part of job.parts) {
      part.chunks = chunkText(part.text, job.provider === 'google' ? GOOGLE_CHUNK : EDGE_CHUNK);
    }
    const totalChunks = job.parts.reduce((sum, part) => sum + part.chunks.length, 0);
    job.chunks = totalChunks;
    if (!totalChunks) throw new Error('Не удалось разбить текст на фразы');
    recount(job);

    for (const part of job.parts) {
      if (job.cancelled) return finish(job, 'cancelled');
      if (part.status === 'done' && part.file && existsAudio(part.outPath)) {
        if (!job.files.some((file) => file.name === part.file.name)) job.files.push(part.file);
        recount(job);
        continue;
      }
      job.partIndex = part.index;
      job.stage = many ? `Часть ${part.index} из ${job.parts.length}: синтез речи` : 'Синтезирую речь';
      part.status = 'running';
      saveJournal(job);

      /* Этот же текст уже озвучивали — берём готовый файл без синтеза. */
      const cacheKey = partCacheKey(job, part);
      const cached = cacheKey ? path.join(job.cacheDir, `${cacheKey}.mp3`) : '';
      if (cached && existsAudio(cached)) {
        fs.copyFileSync(cached, part.outPath);
        part.writtenChunks = part.chunks.length;
        part.writtenBytes = fs.statSync(part.outPath).size;
        finishPart(job, part, cachedPartSeconds(cached), true);
        continue;
      }

      /* Первый кусок не пошёл — переключаемся на резервный движок целиком:
         смешивать голоса и частоты в одной книге нельзя. */
      let seconds = 0;
      for (let attempt = 0; ; attempt += 1) {
        try {
          seconds = await writePartAudio(job, part);
          break;
        } catch (error) {
          const nothingWritten = (part.writtenChunks || 0) === 0;
          if (attempt === 0 && nothingWritten && job.provider === 'edge' && !job.cancelled) {
            job.provider = 'google';
            job.warnings.push('Голос Edge недоступен — озвучил резервным движком Google.');
            for (const item of job.parts) {
              item.chunks = chunkText(item.text, GOOGLE_CHUNK);
              item.writtenChunks = 0;
              item.writtenBytes = 0;
              item.seconds = 0;
              if (item.status !== 'done') item.status = 'queued';
            }
            job.chunks = job.parts.reduce((sum, item) => sum + item.chunks.length, 0);
            recount(job);
            saveJournal(job);
            continue;
          }
          throw error;
        }
      }
      if (job.cancelled) return finish(job, 'cancelled');
      finishPart(job, part, seconds, false);
      /* Кеш на будущее: повторная озвучка того же текста займёт секунды. */
      if (cached) {
        try {
          fs.mkdirSync(job.cacheDir, { recursive: true });
          fs.copyFileSync(part.outPath, cached);
          fs.writeFileSync(`${cached}.json`, JSON.stringify({ size: fs.statSync(cached).size, seconds }), 'utf8');
        } catch {
          /* кеш необязателен: без него просто синтезируем заново */
        }
      }
    }
    job.file = job.files.length === 1 ? { ...job.files[0] } : null;
    complete(job);
  } catch (error) {
    if (job.cancelled) return finish(job, 'cancelled');
    job.error = error.message || 'Не удалось озвучить документ';
    const partial = job.parts.find((part) => part.status === 'running' && (part.writtenBytes || 0) > 2000);
    if (partial) {
      job.warnings.push(
        `«${path.basename(partial.outPath)}» записан не полностью: в нём ${humanDuration(partial.seconds || 0)} звука.`,
      );
    }
    finish(job, 'failed');
  }
}


function complete(job) {
  const count = job.files.length;
  job.stage = count > 1 ? `Готово: частей ${count}` : 'Готово';
  finish(job, 'done');
}

/**
 * Синтез всех кусков по два параллельно: порядок склейки сохраняется, поэтому
 * аудио не перепутается. При отказе Edge на первом же куске переходим на Google
 * целиком — середина книги не должна звучать другим голосом.
 */
async function speakWithRetry(job, text, index) {
  if (job.provider === 'google') {
    for (let attempt = 1; attempt <= CHUNK_ATTEMPTS; attempt += 1) {
      try {
        const lang = String(job.voice).startsWith('en') ? 'en' : 'ru';
        return await googleSpeak({ text, lang });
      } catch (error) {
        if (attempt === CHUNK_ATTEMPTS) throw error;
        await sleep(RETRY_BASE_MS * attempt);
      }
    }
  }
  for (let attempt = 1; attempt <= CHUNK_ATTEMPTS; attempt += 1) {
    if (job.cancelled) throw Object.assign(new Error('Остановлено'), { cancelled: true });
    try {
      return await synthesizeChunk({ text, voice: job.voice, rate: ratePercent(job.rate) });
    } catch (error) {
      /* 403 «skew» уже обработан внутри движка; здесь только паузы и повтор. */
      if (attempt === CHUNK_ATTEMPTS) throw error;
      await sleep(RETRY_BASE_MS * attempt * (index === 0 ? 1 : 2));
    }
  }
  throw new Error('Кусок не синтезировался');
}

/** Тесты и интерфейс: сколько знаков и сколько примерно минут получится. */
export function estimateNarration(text) {
  const clean = normalizeText(text);
  const chunks = chunkText(clean, EDGE_CHUNK);
  /* Нейроголос читает примерно 750 знаков в минуту (замер на книге: 13 846
     знаков = 19 мин 28 с; прежние 900 давали оценку в полтора раза меньше факта). */
  const minutes = clean.length / 750;
  return { chars: clean.length, chunks: chunks.length, minutes: Math.round(minutes * 10) / 10 };
}

/* ───────────────────────────── части книги ───────────────────────────── */

/** Сколько минут звука в одной части: 30 — это дорога в одну сторону. */
export const PART_MINUTES = 30;
/* Замер на живом Edge (Светлана, темп 1): 37 346 знаков дали 44 мин 13 с,
   то есть ≈844 знака в минуту. Прежние 750 завышали длину на 12 %: выжимка
   «на 50 минут» выходила на 44 минуты и не попадала в заказ 45–50. 820 —
   запас в 3 % на паузы и другой голос. */
export const CHARS_PER_MINUTE = 820;

/**
 * Короче этого — один MP3, даже если в тексте есть главы.
 *
 * Делить получасовую выжимку на «часть 1 из 2» незачем: она и так укладывается
 * в одну дорогу, а лишнее имя только мешает искать запись в папке. Порог равен
 * верхней границе части (50 минут): заказ «выжимка на 45–50 минут» должен
 * получаться одним файлом, а не двумя огрызками. Длиннее — режем по главам.
 */
export const SINGLE_FILE_MINUTES = 50;
/* Верхняя граница одной части. Час в одном файле — это долгий синтез без
   промежуточного результата: при перезапуске приложения теряется всё. 45 минут
   остаются удобной «дорогой», но каждая часть успевает записаться отдельно. */
export const MAX_PART_MINUTES = 45;

/* Заголовок раздела: короткая строка без точки в конце, капсом или с ключевым
   словом. Границу слова задаём явно: `\b` в JavaScript считает словесными
   только латиницу с цифрами, поэтому после «глава» кириллица границы не даёт
   и заголовки не находились вовсе — части резались по предложениям. */
const HEADING_RE =
  /^(глава|часть|раздел|приложение|введение|заключение|содержание|оглавление|предисловие|послесловие|итоги|выводы|методика|обзор|резюме)(?=$|\s|[:.,;—–-])/i;

function isHeading(line) {
  const value = line.trim();
  if (!value || value.length > 90) return false;
  if (/[.!?;:,]$/.test(value)) return false;
  if (HEADING_RE.test(value)) return true;
  const letters = value.match(/\p{L}/gu) ?? [];
  if (letters.length < 4) return false;
  const upper = letters.filter((char) => char === char.toUpperCase()).length;
  return upper / letters.length >= 0.7;
}

/**
 * Блоки документа: заголовок вместе со следующим за ним текстом до следующего
 * заголовка. Так часть не начинается посреди главы, если глава помещается
 * в часть. Число блоков нужно и наружу: по нему видно, есть ли в документе
 * главы, — от этого зависит, что честно написать в окне озвучки.
 */
export function splitBlocks(text) {
  const lines = text.split('\n');
  const blocks = [];
  let current = [];
  const pushBlock = () => {
    const body = current.join('\n').trim();
    if (body) blocks.push(body);
    current = [];
  };
  for (const line of lines) {
    if (isHeading(line) && current.length) pushBlock();
    current.push(line);
  }
  pushBlock();
  return blocks;
}

/**
 * Какой длине части соответствует сама книга, без вопросов человеку.
 * Смотрим на главы: короткие (до 20 минут) собираем в получасовые части —
 * иначе получается десяток файлов по пять минут; главы по 20–45 минут
 * отдаём целиком, по главе на файл; глава длиннее 45 минут режется внутри
 * по предложениям, потому что час в наушниках — это уже не «часть».
 * Документ без заголовков (PDF-выгрузка, договор) режется по полчаса.
 */
export function choosePartMinutes(raw) {
  const text = normalizeText(raw);
  if (!text) return PART_MINUTES;
  const minutes = splitBlocks(text).map((block) => block.length / CHARS_PER_MINUTE);
  if (minutes.length <= 1) return PART_MINUTES;
  const total = minutes.reduce((sum, value) => sum + value, 0);
  if (total <= PART_MINUTES * 0.8) return PART_MINUTES;
  const sorted = [...minutes].sort((left, right) => left - right);
  const median = sorted[Math.floor(sorted.length / 2)];
  if (median < 20) return PART_MINUTES;
  return Math.min(45, Math.max(20, Math.round(median)));
}

/**
 * Сколько файлов и каких получится из документа — единственное место, где
 * решается «резать или не резать», чтобы окно озвучки, сервер и инструмент
 * агента отвечали одинаково.
 *
 * Правила:
 *   • короткая выжимка (до SINGLE_FILE_MINUTES) — всегда один MP3, даже если
 *     в ней есть главы: тридцать минут звука делить не на что;
 *   • длинная книга — части по её структуре (choosePartMinutes);
 *   • явный размер части (minutes из чата) уважаем как заказ: если модель
 *     осознанно просит по 10 минут — режем по 10, даже короткий текст. Но не
 *     больше MAX_PART_MINUTES: 60–65 минут — это хронометраж книги, а не
 *     размер одной части.
 */
export function narrationParts(raw, { minutes } = {}) {
  const text = normalizeText(raw);
  if (!text) return [];
  const requested =
    Number(minutes) > 0 ? Math.min(MAX_PART_MINUTES, Math.max(5, Number(minutes))) : 0;
  if (!requested && text.length / CHARS_PER_MINUTE <= SINGLE_FILE_MINUTES) return [text];
  return splitIntoParts(text, { minutes: requested || choosePartMinutes(text) });
}

/**
 * Режет документ на части по ~30 минут звука, стараясь рвать по границам
 * разделов: слушателю важно начинать часть с заголовка, а не с середины фразы.
 * Возвращает массив строк — по одной на часть. Одна часть — когда документ
 * короче целевого размера.
 */
export function splitIntoParts(raw, { minutes = PART_MINUTES } = {}) {
  const text = normalizeText(raw);
  if (!text) return [];
  const target = Math.max(3000, Math.round(minutes * CHARS_PER_MINUTE));

  const blocks = splitBlocks(text);

  const parts = [];
  let pack = [];
  let size = 0;
  const flush = () => {
    const body = pack.join('\n\n').trim();
    if (body) parts.push(body);
    pack = [];
    size = 0;
  };
  for (const block of blocks) {
    /* Блок больше части с запасом (оглавление, таблица, глава-простыня) —
       делим по предложениям, иначе одна часть окажется в разы больше других.
       Порог 1.15, а не 1.5: текст на 51 тыс. знаков иначе оставался одним
       файлом на 62 минуты, хотя максимум части — 45. */
    const pieces = block.length > target * 1.15 ? chunkText(block, target) : [block];
    for (const piece of pieces) {
      if (size && size + piece.length > target * 1.15) flush();
      pack.push(piece);
      size += piece.length + 2;
      if (size >= target * 1.15) flush();
    }
  }
  flush();

  /* Хвост короче трети части — приклеиваем к предыдущей: отдельный файл на
     две минуты неудобно искать в папке. */
  if (parts.length > 1) {
    const last = parts[parts.length - 1];
    if (last.length < target * 0.35) {
      parts[parts.length - 2] += `\n\n${last}`;
      parts.pop();
    }
  }
  return parts;
}

/** План частей для интерфейса: размеры и длительность без синтеза. */
export function planParts(raw, { minutes } = {}) {
  return narrationParts(raw, { minutes }).map((text, index) => ({
    index: index + 1,
    chars: text.length,
    minutes: Math.round((text.length / CHARS_PER_MINUTE) * 10) / 10,
  }));
}

