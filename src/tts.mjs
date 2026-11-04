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
/** Сколько кусков синтезируем одновременно: два — компромисс скорости и памяти. */
const WORKERS = 2;

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
      name: part.file?.name || '',
      size: part.file?.size || 0,
      seconds: part.file?.seconds || 0,
      duration: part.file?.duration || '',
    })),
    files: job.files.map((file) => ({ ...file })),
    partIndex: job.partIndex,
    error: job.error || '',
    warnings: job.warnings.slice(),
    etaSeconds: job.etaSeconds,
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

/** Чистка памяти: готовые задания живут час, этого хватает интерфейсу. */
const jobCleaner = setInterval(() => {
  const limit = Date.now() - 60 * 60 * 1000;
  for (const [id, job] of jobs) {
    if (job.finishedAt && job.finishedAt < limit) jobs.delete(id);
  }
}, 10 * 60 * 1000);
if (typeof jobCleaner.unref === 'function') jobCleaner.unref();

function finish(job, status, patch = {}) {
  Object.assign(job, patch);
  job.status = status;
  job.finishedAt = Date.now();
  if (status === 'done') {
    job.percent = 100;
    job.stage = 'Готово';
  } else if (status === 'cancelled') {
    job.stage = 'Остановлено';
  }
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
    startedAt: Date.now(),
    finishedAt: 0,
  };
  jobs.set(job.id, job);
  queueJob(job);
  return job;
}

async function runJob(job) {
  if (job.cancelled) return finish(job, 'cancelled');
  job.status = 'running';
  job.stage = 'Разбираю текст';
  const many = job.parts.length > 1;
  try {
    /* Общий счётчик кусков: прогресс в интерфейсе один на всю книгу. */
    let totalChunks = 0;
    for (const part of job.parts) {
      part.chunks = chunkText(part.text, EDGE_CHUNK);
      totalChunks += part.chunks.length;
    }
    job.chunks = totalChunks;
    if (!totalChunks) throw new Error('Не удалось разбить текст на фразы');

    for (const part of job.parts) {
      if (job.cancelled) return finish(job, 'cancelled');
      job.partIndex = part.index;
      job.stage = many ? `Часть ${part.index} из ${job.parts.length}: синтез речи` : 'Синтезирую речь';
      part.status = 'running';
      const cacheKey = job.cacheDir
        ? hashKey([job.voice, job.rate, job.provider, part.chars, part.text.slice(0, 4000), part.text.length])
        : '';
      const cached = cacheKey ? path.join(job.cacheDir, `${cacheKey}.mp3`) : '';
      let buffer = null;
      if (cached && fs.existsSync(cached) && fs.statSync(cached).size > 1000) {
        buffer = fs.readFileSync(cached);
      } else {
        const pieces = await synthesizeAll(job, part.chunks, part.text);
        if (job.cancelled) return finish(job, 'cancelled');
        buffer = Buffer.concat(pieces);
        if (buffer.length < 2000) throw new Error('Сервис вернул пустой звук');
        if (cached) {
          try {
            fs.mkdirSync(job.cacheDir, { recursive: true });
            fs.writeFileSync(cached, buffer);
          } catch {
            /* кеш необязателен: без него просто синтезируем заново */
          }
        }
      }
      fs.mkdirSync(path.dirname(part.outPath), { recursive: true });
      fs.writeFileSync(part.outPath, buffer);
      const seconds = mp3Duration(buffer);
      part.file = {
        index: part.index,
        label: part.label,
        name: path.basename(part.outPath),
        size: buffer.length,
        seconds,
        duration: humanDuration(seconds),
        cached: Boolean(cached),
      };
      part.status = 'done';
      job.files.push(part.file);
      job.seconds += seconds;
      if (!seconds) job.warnings.push(`Длительность части ${part.index} не определилась.`);
      /* Промежуточный прогресс: файл уже лежит в папке проекта — интерфейс
         может показать его, не дожидаясь конца книги. */
      job.percent = Math.max(job.percent, Math.round((job.doneChunks / totalChunks) * 100));
    }
    job.file = job.files.length === 1 ? { ...job.files[0] } : null;
    complete(job);
  } catch (error) {
    if (job.cancelled) return finish(job, 'cancelled');
    job.error = error.message || 'Не удалось озвучить документ';
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
async function synthesizeAll(job, chunks, sourceText) {
  const results = new Array(chunks.length);
  const started = Date.now();
  let cursor = 0;
  let failure = null;
  const base = job.doneChunks;

  const worker = async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= chunks.length || failure || job.cancelled) return;
      try {
        results[index] = await speakWithRetry(job, chunks[index], index);
      } catch (error) {
        if (job.provider === 'edge' && index === 0) {
          job.provider = 'google';
          job.warnings.push('Голос Edge недоступен — озвучил резервным движком Google.');
          failure = { retry: true };
          return;
        }
        failure = { error };
        return;
      }
      job.doneChunks += 1;
      const done = job.doneChunks - base;
      job.percent = Math.max(job.percent, Math.min(99, Math.round((job.doneChunks / Math.max(1, job.chunks)) * 100)));
      const spent = (Date.now() - started) / 1000;
      job.etaSeconds = done ? Math.round((spent / done) * (chunks.length - done)) : null;
    }
  };

  await Promise.all(Array.from({ length: Math.min(WORKERS, chunks.length) }, () => worker()));
  if (failure?.retry && !job.cancelled) {
    const rest = chunkText(sourceText ?? job.text, GOOGLE_CHUNK);
    job.chunks = job.doneChunks + rest.length;
    return synthesizeAll(job, rest, sourceText);
  }
  if (failure?.error) throw failure.error;
  if (job.cancelled) throw Object.assign(new Error('Остановлено'), { cancelled: true });
  return results;
}

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
const CHARS_PER_MINUTE = 750;

/** Заголовок раздела: короткая строка без точки в конце, капсом или с ключевым словом. */
const HEADING_RE =
  /^(глава|часть|раздел|приложение|введение|заключение|содержание|предисловие|послесловие|итоги|методика|обзор|резюме)\b/i;

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
 * Режет документ на части по ~30 минут звука, стараясь рвать по границам
 * разделов: слушателю важно начинать часть с заголовка, а не с середины фразы.
 * Возвращает массив строк — по одной на часть. Одна часть — когда документ
 * короче целевого размера.
 */
export function splitIntoParts(raw, { minutes = PART_MINUTES } = {}) {
  const text = normalizeText(raw);
  if (!text) return [];
  const target = Math.max(3000, Math.round(minutes * CHARS_PER_MINUTE));

  /* Блоки: заголовок вместе со следующим за ним текстом до следующего заголовка.
     Так часть не начинается посреди главы, если глава помещается в часть. */
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
    /* Блок больше полутора частей (оглавление, таблица, глава-простыня) —
       делим по предложениям, иначе одна часть окажется в разы больше других. */
    const pieces = block.length > target * 1.5 ? chunkText(block, target) : [block];
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
export function planParts(raw, { minutes = PART_MINUTES } = {}) {
  return splitIntoParts(raw, { minutes }).map((text, index) => ({
    index: index + 1,
    chars: text.length,
    minutes: Math.round((text.length / CHARS_PER_MINUTE) * 10) / 10,
  }));
}

