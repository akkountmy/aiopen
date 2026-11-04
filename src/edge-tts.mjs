/**
 * Microsoft Edge — нейроголоса без ключа и без Python.
 *
 * Голоса Svetlana/Dmitry отдают живой MP3 (24 кГц, 48 кбит/с), и для книг это
 * заметно приятнее любого локального синтезатора. Но сервер требует подписанный
 * `Sec-MS-GEC` токен: он считается из текущего времени, усечённого до пяти
 * минут, нестандартным SHA-256 (часть констант подменена) и 64-битным
 * перемешиванием. Токен — единственная причина, по которой сервис нельзя
 * вызывать обычным HTTP-запросом, поэтому алгоритм перенесён сюда дословно.
 *
 * Правило сопровождения: правки в этом файле сверяются с эталоном
 * (`edge-tts` 7.3.1, `drm.py`) тестом `test/tts-drm.mjs` — эталон даёт
 * контрольные значения токена на фиксированных отметках времени. Если Microsoft
 * сменит схему, покраснеет тест, а не только прод.
 */

import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';

const M32 = 0xffffffffn;
const N64 = 0x100000001n;

export const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const WIN_EPOCH = 11644473600;
const CHROMIUM_FULL_VERSION = '143.0.3650.75';
const CHROMIUM_MAJOR_VERSION = CHROMIUM_FULL_VERSION.split('.')[0];
export const SEC_MS_GEC_VERSION = `2-${CHROMIUM_FULL_VERSION}`;

const BASE_URL = 'speech.platform.bing.com/consumer/speech/synthesize/readaloud';
const WSS_URL = `wss://${BASE_URL}/edge/v1?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}`;
export const VOICE_LIST_URL = `https://${BASE_URL}/voices/list?trustedclienttoken=${TRUSTED_CLIENT_TOKEN}`;
export const AUDIO_FORMAT = 'audio-24khz-48kbitrate-mono-mp3';

const BASE_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' +
    ` (KHTML, like Gecko) Chrome/${CHROMIUM_MAJOR_VERSION}.0.0.0 Safari/537.36` +
    ` Edg/${CHROMIUM_MAJOR_VERSION}.0.0.0`,
  'Accept-Encoding': 'gzip, deflate, br, zstd',
  'Accept-Language': 'en-US,en;q=0.9',
};

const WSS_HEADERS = {
  Pragma: 'no-cache',
  'Cache-Control': 'no-cache',
  Origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
  'Sec-WebSocket-Version': '13',
  ...BASE_HEADERS,
};

const VOICE_HEADERS = {
  Authority: 'speech.platform.bing.com',
  'Sec-CH-UA':
    `" Not;A Brand";v="99", "Microsoft Edge";v="${CHROMIUM_MAJOR_VERSION}",` +
    ` "Chromium";v="${CHROMIUM_MAJOR_VERSION}"`,
  'Sec-CH-UA-Mobile': '?0',
  Accept: '*/*',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Dest': 'empty',
  ...BASE_HEADERS,
};

/* ─────────────────────────────── токен ─────────────────────────────── */

const SHA256_INITIAL = [
  0x6a09e667n, 0xbb67ae85n, 0x3c6ef372n, 0xa54ff53an, 0x510e527fn, 0x9b05688cn, 0x1f83d9abn, 0x5be0cd19n,
];
const SHA256_STATE = [
  0xfd9fbea2n, 0x91243ce7n, 0xbe499094n, 0xcd2e1e0an, 0x6c006f49n, 0x04bd35abn, 0xfeb0a7e4n, 0x03effbd2n,
];
const SHA256_SCHEDULE = [
  0xeb24bf9en, 0x1558691fn, 0xa0c09ee2n, 0x0cfa32ban, 0xa622ee8cn, 0xd1dd9491n, 0xc0dd25a0n, 0xf9e70ab6n,
  0xf0c31573n, 0x7058ce4en, 0x7188e606n, 0x00e5ab33n, 0xd258b060n, 0x72766564n,
];
const SHA256_ROUND_CONSTANTS = [
  0x428a2f98n, 0x71374491n, 0xb5c0fbcfn, 0xe9b5dba5n, 0x3956c25bn, 0x59f111f1n, 0x923f82a4n, 0xab1c5ed5n,
  0xd807aa98n, 0x12835b01n, 0x243185ben, 0x550c7dc3n, 0x72be5d74n, 0x80deb1fen, 0x9bdc06a7n, 0xc19bf174n,
  0xe49b69c1n, 0xefbe4786n, 0x0fc19dc6n, 0x240ca1ccn, 0x2de92c6fn, 0x4a7484aan, 0x5cb0a9dcn, 0x76f988dan,
  0x983e5152n, 0xa831c66dn, 0xb00327c8n, 0xbf597fc7n, 0xc6e00bf3n, 0xd5a79147n, 0x06ca6351n, 0x14292967n,
  0x27b70a85n, 0x2e1b2138n, 0x4d2c6dfcn, 0x53380d13n, 0x650a7354n, 0x766a0abbn, 0x81c2c92en, 0x92722c85n,
  0xa2bfe8a1n, 0xa81a664bn, 0xc24b8b70n, 0xc76c51a3n, 0xd192e819n, 0xd6990624n, 0xf40e3585n, 0x106aa070n,
  0x19a4c116n, 0x1e376c08n, 0x2748774cn, 0x34b0bcb5n, 0x391c0cb3n, 0x4ed8aa4an, 0x5b9cca4fn, 0x682e6ff3n,
  0x748f82een, 0x78a5636fn, 0x84c87814n, 0x8cc70208n, 0x90befffan, 0xa4506cebn, 0xbef9a3f7n, 0xc67178f2n,
];
const SHA256_ADJUSTMENT = 0xc9dc06a7n;
const SHA256_SIGMA0_ADJUSTMENT = 0x059c0b80n;
const SHA256_SIGMA1_ADJUSTMENT = 0x000b92c0n;
const CS64_COEFFICIENTS = [
  [0xe82e91b1n, 0xb32700d0n],
  [0x44de24c6n, 0x88dff51dn],
  [0x3beb65bcn, 0x29514038n],
  [0xc89c5933n, 0xb328cbdfn],
  [0x8d1ec211n, 0xd405b4d5n],
  [0x314ef5d5n, 0x26e55f3cn],
  [0xe92491b1n, 0x607801c6n],
  [0xf0a5b9d5n, 0x82b2c1fbn],
  [0x06064cf3n, 0xfa51a3dan],
  [0xda79fa60n, 0x207cc464n],
  [0xbed20560n, 0x3c3c74f3n],
  [0x89f9c9f8n, 0xd2d14b61n],
  [0x35fa38c6n, 0xbb04a2c1n],
  [0xcb49e3c6n, 0xc5626167n],
];
const CS64_FACTOR = 0x82893933n;
const CS64_ADJUSTMENT0 = 0xf2f90b1an;
const CS64_ADJUSTMENT1 = 0x0b1a0000n;

/* Первые 14 раундов первого блока считаются с подменённой константой. */
const SHA256_BLOCK_CONSTANTS = [
  ...SHA256_ROUND_CONSTANTS.slice(0, 14),
  SHA256_ADJUSTMENT,
  ...SHA256_ROUND_CONSTANTS.slice(15),
];

/** Поворот 32-битного слова влево на 16: как в эталоне — сперва маска. */
function rol16(value) {
  const v = value & M32;
  return ((v << 16n) | (v >> 16n)) & M32;
}

/** Байты → 32-битные слова по little-endian, добитые до чётного числа слов. */
function wordsLe4Even(data) {
  const pad = (4 - (data.length % 4)) % 4;
  const padded = Buffer.concat([data, Buffer.alloc(pad)]);
  if (!padded.length) return [];
  const words = [];
  for (let offset = 0; offset < padded.length; offset += 4) words.push(BigInt(padded.readUInt32LE(offset)));
  if (words.length % 2) words.push(0n);
  return words;
}

function sigma0(value) {
  return ((value >> 7n) ^ (value << 25n) ^ (value >> 18n) ^ (value << 14n) ^ (value >> 3n)) & M32;
}

function sigma1(value) {
  return ((value >> 17n) ^ (value << 15n) ^ (value >> 19n) ^ (value << 13n) ^ (value >> 10n)) & M32;
}

/**
 * Раунды хеша. `firstRound` нужен, чтобы продолжить счёт внутри первого блока:
 * первые 14 раундов посчитаны ещё в инициализации состояния.
 */
function sha256Rounds(state, words, firstRound = 0) {
  let [a, b, c, d, e, f, g, h] = state;
  const constants = firstRound === 14 ? SHA256_BLOCK_CONSTANTS : SHA256_ROUND_CONSTANTS;
  const aligned = Math.min(64, Math.floor((firstRound + 7) / 8) * 8);
  for (let i = firstRound; i < aligned; i += 1) {
    const rotE = e * N64;
    const rotA = a * N64;
    const t1 =
      h +
      ((rotE >> 6n) ^ (rotE >> 11n) ^ (rotE >> 25n)) +
      (g ^ (e & (f ^ g))) +
      constants[i] +
      words[i];
    const t2 = ((rotA >> 2n) ^ (rotA >> 13n) ^ (rotA >> 22n)) + ((a & b) | (c & (a | b)));
    const nextA = (t1 + t2) & M32;
    const nextD = (d + t1) & M32;
    [a, b, c, d, e, f, g, h] = [nextA, a, b, c, nextD, e, f, g];
  }
  for (let i = aligned; i < 64; i += 8) {
    let rotE = e * N64;
    let rotA = a * N64;
    let t1 = h + ((rotE >> 6n) ^ (rotE >> 11n) ^ (rotE >> 25n)) + (g ^ (e & (f ^ g))) + constants[i] + words[i];
    d = (d + t1) & M32;
    h = (t1 + ((rotA >> 2n) ^ (rotA >> 13n) ^ (rotA >> 22n)) + ((a & b) | (c & (a | b)))) & M32;

    rotE = d * N64;
    rotA = h * N64;
    t1 = g + ((rotE >> 6n) ^ (rotE >> 11n) ^ (rotE >> 25n)) + (f ^ (d & (e ^ f))) + constants[i + 1] + words[i + 1];
    c = (c + t1) & M32;
    g = (t1 + ((rotA >> 2n) ^ (rotA >> 13n) ^ (rotA >> 22n)) + ((h & a) | (b & (h | a)))) & M32;

    rotE = c * N64;
    rotA = g * N64;
    t1 = f + ((rotE >> 6n) ^ (rotE >> 11n) ^ (rotE >> 25n)) + (e ^ (c & (d ^ e))) + constants[i + 2] + words[i + 2];
    b = (b + t1) & M32;
    f = (t1 + ((rotA >> 2n) ^ (rotA >> 13n) ^ (rotA >> 22n)) + ((g & h) | (a & (g | h)))) & M32;

    rotE = b * N64;
    rotA = f * N64;
    t1 = e + ((rotE >> 6n) ^ (rotE >> 11n) ^ (rotE >> 25n)) + (d ^ (b & (c ^ d))) + constants[i + 3] + words[i + 3];
    a = (a + t1) & M32;
    e = (t1 + ((rotA >> 2n) ^ (rotA >> 13n) ^ (rotA >> 22n)) + ((f & g) | (h & (f | g)))) & M32;

    rotE = a * N64;
    rotA = e * N64;
    t1 = d + ((rotE >> 6n) ^ (rotE >> 11n) ^ (rotE >> 25n)) + (c ^ (a & (b ^ c))) + constants[i + 4] + words[i + 4];
    h = (h + t1) & M32;
    d = (t1 + ((rotA >> 2n) ^ (rotA >> 13n) ^ (rotA >> 22n)) + ((e & f) | (g & (e | f)))) & M32;

    rotE = h * N64;
    rotA = d * N64;
    t1 = c + ((rotE >> 6n) ^ (rotE >> 11n) ^ (rotE >> 25n)) + (b ^ (h & (a ^ b))) + constants[i + 5] + words[i + 5];
    g = (g + t1) & M32;
    c = (t1 + ((rotA >> 2n) ^ (rotA >> 13n) ^ (rotA >> 22n)) + ((d & e) | (f & (d | e)))) & M32;

    rotE = g * N64;
    rotA = c * N64;
    t1 = b + ((rotE >> 6n) ^ (rotE >> 11n) ^ (rotE >> 25n)) + (a ^ (g & (h ^ a))) + constants[i + 6] + words[i + 6];
    f = (f + t1) & M32;
    b = (t1 + ((rotA >> 2n) ^ (rotA >> 13n) ^ (rotA >> 22n)) + ((c & d) | (e & (c | d)))) & M32;

    rotE = f * N64;
    rotA = b * N64;
    t1 = a + ((rotE >> 6n) ^ (rotE >> 11n) ^ (rotE >> 25n)) + (h ^ (f & (g ^ h))) + constants[i + 7] + words[i + 7];
    e = (e + t1) & M32;
    a = (t1 + ((rotA >> 2n) ^ (rotA >> 13n) ^ (rotA >> 22n)) + ((b & c) | (d & (b | c)))) & M32;
  }
  return [a, b, c, d, e, f, g, h];
}

/** Достраивает расписание слов до 64: комбинация поворотов до общего сложения. */
function expandSchedule(words, firstWord = 16) {
  for (let i = firstWord; i < 64; i += 1) {
    const x = words[i - 2];
    const y = words[i - 15];
    const s1 = (x >> 17n) ^ (x << 15n) ^ (x >> 19n) ^ (x << 13n) ^ (x >> 10n);
    const s0 = (y >> 7n) ^ (y << 25n) ^ (y >> 18n) ^ (y << 14n) ^ (y >> 3n);
    words.push((s1 + words[i - 7] + s0 + words[i - 16]) & M32);
  }
}

/** Начальное состояние для первых семи байт данных (они сворачиваются в слова). */
function sha256Init(data) {
  const words = new Array(14).fill(0n);
  words.push(BigInt(data.readUIntBE(0, 3)));
  words.push(BigInt(data.readUIntBE(3, 4)));
  for (let i = 16; i < 30; i += 1) {
    let value = SHA256_SCHEDULE[i - 16];
    if (i - 2 >= 14) {
      const part = sigma1(words[i - 2]);
      value += i === 16 ? part ^ SHA256_SIGMA1_ADJUSTMENT : part;
    }
    if (i - 7 >= 14) value += words[i - 7];
    if (i - 15 >= 14) {
      const part = sigma0(words[i - 15]);
      value += i === 29 ? part ^ SHA256_SIGMA0_ADJUSTMENT : part;
    }
    words.push(value & M32);
  }
  words.push(
    (sigma1(words[28]) + words[23] + sigma0(words[15]) + words[14] + SHA256_ADJUSTMENT - SHA256_ROUND_CONSTANTS[14]) & M32,
  );
  expandSchedule(words, 31);
  const working = sha256Rounds(SHA256_STATE, words, 14);
  return working.map((value, index) => (value + SHA256_INITIAL[index]) & M32);
}

function sha256Digest(data) {
  if (data.length < 7) throw new Error('Для токена нужно не меньше семи байт');
  const length = 57 + data.length;
  const zeros = (((55 - length) % 64) + 64) % 64;
  const tail = Buffer.alloc(8);
  tail.writeBigUInt64BE(BigInt(length * 8));
  const padded = Buffer.concat([data.subarray(7), Buffer.from([0x80]), Buffer.alloc(zeros), tail]);
  let state = sha256Init(data.subarray(0, 7));
  for (let offset = 0; offset < padded.length; offset += 64) {
    const words = [];
    for (let k = 0; k < 16; k += 1) words.push(BigInt(padded.readUInt32BE(offset + k * 4)));
    expandSchedule(words);
    const working = sha256Rounds(state, words);
    state = working.map((value, index) => (value + state[index]) & M32);
  }
  const out = Buffer.alloc(32);
  state.forEach((value, index) => out.writeUInt32BE(Number(value), index * 4));
  return out;
}

function cs64Digest(data, digest) {
  const keyA = BigInt(digest.readUInt32LE(0) | 1);
  const keyB = BigInt(digest.readUInt32LE(4) | 1);
  const factors = [(keyA * CS64_FACTOR) & M32, (keyB * CS64_FACTOR) & M32];
  const terms = CS64_COEFFICIENTS.map(([coefficient], index) => (coefficient * factors[index % 2]) & M32);
  const offsets = CS64_COEFFICIENTS.map(([, offset]) => offset);
  const words = wordsLe4Even(Buffer.concat([Buffer.from([0]), data]));
  words.forEach((word, index) => {
    let term = word * (index % 2 === 0 ? keyA : keyB);
    let offset = rol16(word) * (index % 2 === 0 ? 0xef0569fbn : 0xc31713dbn);
    if (index === 0) {
      term += CS64_ADJUSTMENT0 * factors[0];
      offset += CS64_ADJUSTMENT1;
    }
    terms.push(term & M32);
    offsets.push(offset & M32);
  });
  let swapAcc = 0n;
  let swapLast = 0n;
  let state = 0n;
  let acc = 0n;
  for (let i = 0; i < terms.length; i += 2) {
    const x = terms[i];
    const y = terms[i + 1];
    let t = rol16((offsets[i] + x) & M32);
    let q = (t * 0x76f50f34n) & M32;
    swapAcc += (rol16(q) * 0xc3efea97n + q) & M32;
    t = rol16((offsets[i + 1] + y) & M32);
    q = (t * 0x1881ce3cn) & M32;
    swapLast = (rol16(q) * 0x35bd1ec9n + q) & M32;
    swapAcc = (swapAcc + swapLast) & M32;

    state = (state * keyA + x) & M32;
    state = (rol16(state) * 0xcf98b111n) & M32;
    state = (rol16(state) * 0x87085b9fn) & M32;
    state = (rol16(state) * 0x12ceb96dn) & M32;
    state = (rol16(state) * 0x257e1d83n) & M32;
    acc += state;
    t = (state * keyB + y) & M32;
    t = (rol16(t) * 0xa27416f5n) & M32;
    t = (rol16(t) * 0xd38396ffn) & M32;
    state = (rol16((rol16(t) * 0x7c932b89n) & M32) * 0xbfa49f69n) & M32;
    acc = (acc + state) & M32;
  }
  return [swapLast ^ state, swapAcc ^ acc];
}

let clockSkewSeconds = 0;

/**
 * Подписанный токен `Sec-MS-GEC` на отметку времени (секунды Unix).
 * Окно — пять минут, поэтому токен можно кешировать до его конца.
 */
export function secMsGec(unixSeconds = Date.now() / 1000) {
  let ticks = Number(unixSeconds) + clockSkewSeconds + WIN_EPOCH;
  ticks -= ticks % 300;
  ticks *= 1e7;
  const data = Buffer.from(`${Math.trunc(ticks)}${TRUSTED_CLIENT_TOKEN}`, 'ascii');
  const digest = sha256Digest(data);
  const [wordA, wordB] = cs64Digest(data, digest);
  const cs64 = Buffer.alloc(8);
  cs64.writeUInt32LE(Number(wordA), 0);
  cs64.writeUInt32LE(Number(wordB), 4);
  return `${cs64.toString('hex').toUpperCase()}-${digest.toString('hex').toUpperCase()}`;
}

/** Время в том виде, в каком его ждёт сервис (формат JavaScript Date). */
function jsDateString(date = new Date()) {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const pad = (value) => String(value).padStart(2, '0');
  return (
    `${days[date.getUTCDay()]} ${months[date.getUTCMonth()]} ${pad(date.getUTCDate())} ${date.getUTCFullYear()} ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} GMT+0000 (Coordinated Universal Time)`
  );
}

function escapeXml(text) {
  return String(text)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function connectId() {
  return randomUUID().replace(/-/g, '');
}

function muid() {
  return (randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '')).toUpperCase().slice(0, 32);
}

function commandMessage() {
  const config = {
    context: {
      synthesis: {
        audio: {
          metadataoptions: { sentenceBoundaryEnabled: 'false', wordBoundaryEnabled: 'false' },
          outputFormat: AUDIO_FORMAT,
        },
      },
    },
  };
  return (
    `X-Timestamp:${jsDateString()}\r\n` +
    'Content-Type:application/json; charset=utf-8\r\n' +
    'Path:speech.config\r\n\r\n' +
    `${JSON.stringify(config)}\r\n`
  );
}

function ssmlMessage({ text, voice, rate, pitch, volume }) {
  const ssml =
    "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>" +
    `<voice name='${voice}'>` +
    `<prosody pitch='${pitch}' rate='${rate}' volume='${volume}'>` +
    escapeXml(text) +
    '</prosody></voice></speak>';
  return (
    `X-RequestId:${connectId()}\r\n` +
    'Content-Type:application/ssml+xml\r\n' +
    `X-Timestamp:${jsDateString()}Z\r\n` +
    'Path:ssml\r\n\r\n' +
    ssml
  );
}

/** Разбор кадра сервиса: заголовки текстом, дальше либо аудио, либо служебное. */
function readFrame(frame) {
  const split = frame.indexOf('\r\n\r\n');
  const head = split < 0 ? frame : frame.subarray(0, split);
  const body = split < 0 ? Buffer.alloc(0) : frame.subarray(split + 4);
  const headers = {};
  for (const line of head.toString('utf8').split('\r\n')) {
    const index = line.indexOf(':');
    if (index > 0) headers[line.slice(0, index).trim()] = line.slice(index + 1).trim();
  }
  return { headers, body };
}

/** Список голосов сервиса. Кешируется вызывающим кодом: он меняется раз в месяцы. */
export async function listVoices({ timeoutMs = 20000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(VOICE_LIST_URL, { headers: VOICE_HEADERS, signal: controller.signal });
    if (!response.ok) throw new Error(`Голоса: HTTP ${response.status}`);
    const list = await response.json();
    if (!Array.isArray(list)) throw new Error('Голоса: неожиданный ответ');
    return list.map((item) => ({
      name: String(item.ShortName || ''),
      locale: String(item.Locale || ''),
      gender: String(item.Gender || ''),
      friendly: String(item.FriendlyName || item.ShortName || ''),
      local: String(item.Locale || '').split('-')[0],
    }));
  } finally {
    clearTimeout(timer);
  }
}

/** Один кусок текста → MP3. Бросает ошибку с кодом `skew`, если часы разъехались. */
function synthesizeOnce({ text, voice, rate, pitch, volume, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(
      `${WSS_URL}&ConnectionId=${connectId()}&Sec-MS-GEC=${secMsGec()}&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}`,
      { headers: { ...WSS_HEADERS, Cookie: `muid=${muid()};` }, perMessageDeflate: { clientMaxWindowBits: 15 } },
    );
    const parts = [];
    let done = false;

    const finish = (error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        socket.terminate();
      } catch {
        /* сокет мог уже закрыться */
      }
      if (error) reject(error);
      else resolve(Buffer.concat(parts));
    };

    const timer = setTimeout(() => finish(Object.assign(new Error('Синтез: истекло время ожидания'), { code: 'timeout' })), timeoutMs);

    socket.on('unexpected-response', (request, response) => {
      let body = '';
      response.on('data', (chunk) => {
        body += chunk;
      });
      response.on('end', () => {
        const date = Date.parse(response.headers.date || '');
        const skewError = Object.assign(
          new Error(`Синтез: HTTP ${response.statusCode}${body ? ` — ${body.slice(0, 120)}` : ''}`),
          { code: response.statusCode === 403 ? 'skew' : 'http', status: response.statusCode, serverDate: date },
        );
        finish(skewError);
      });
    });

    socket.on('open', () => {
      socket.send(commandMessage());
      socket.send(ssmlMessage({ text, voice, rate, pitch, volume }));
    });

    socket.on('message', (data, isBinary) => {
      const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
      if (isBinary) {
        if (buffer.length < 2) return;
        const headerLength = buffer.readUInt16BE(0);
        const frame = buffer.subarray(2);
        const { headers, body } = readFrame(frame.subarray(0, headerLength));
        if (headers.Path === 'audio') parts.push(buffer.subarray(2 + headerLength).length ? buffer.subarray(2 + headerLength) : body);
        return;
      }
      const { headers } = readFrame(buffer);
      if (headers.Path === 'turn.end') {
        if (!parts.length) finish(Object.assign(new Error('Синтез: сервис вернул пустой звук'), { code: 'empty' }));
        else finish(null);
      }
    });

    socket.on('error', (error) => finish(Object.assign(new Error(`Синтез: ${error.message}`), { code: 'socket' })));
    socket.on('close', (code) => {
      if (!done) finish(Object.assign(new Error(`Синтез: соединение закрыто (${code})`), { code: 'closed' }));
    });
  });
}

/**
 * Один кусок текста → MP3.
 *
 * Расхождение часов даёт ровно 403: сервис ждёт токен, посчитанный по своему
 * времени. Один раз подтягиваем часы по заголовку `Date` из ответа и повторяем —
 * это дешевле, чем объяснять пользователю «попробуйте позже».
 */
export async function synthesizeChunk({ text, voice, rate = '+0%', pitch = '+0Hz', volume = '+0%', timeoutMs = 120000 }) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await synthesizeOnce({ text, voice, rate, pitch, volume, timeoutMs });
    } catch (error) {
      const canRetry = error.code === 'skew' && attempt < 2 && Number.isFinite(error.serverDate) && error.serverDate > 0;
      if (!canRetry) throw error;
      clockSkewSeconds = (error.serverDate - Date.now()) / 1000;
    }
  }
}

/** Для тестов: текущая поправка часов и чистая копия внутренностей токена. */
export const __testing = {
  get skewSeconds() {
    return clockSkewSeconds;
  },
  sha256Digest,
  cs64Digest,
  jsDateString,
};
