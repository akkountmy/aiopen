import { ASR } from './config.mjs';
import { getOpenRouterKey } from './keys.mjs';
import { truncate } from './util.mjs';

const TRANSCRIBE_PROMPT = [
  'Ты — модуль распознавания речи внутри рабочего сервиса.',
  'Запиши дословно всё, что произнесено в аудио, на языке речи (обычно русский).',
  'Верни только текст расшифровки, без пояснений, вступлений, оценок и переводов.',
  'Расставляй знаки препинания и заглавные буквы по смыслу.',
  'Числа записывай цифрами, если они произнесены как числа.',
  'Имена, названия и термины сохраняй так, как они звучат.',
  'Если речи нет или слышен только шум — верни ровно одно слово: silence.',
].join('\n');

const PLACEHOLDER = /^(?:\(?\s*(?:no output|no speech|empty|silence|пустая строка|нет речи|тишина|неразборчиво)\s*\)?[.!]?|[-—\s]*)$/i;

function cleanTranscript(text) {
  const cleaned = String(text || '')
    .replace(/^```[a-z]*\n?/i, '')
    .replace(/```$/g, '')
    .replace(/^(?:расшифровка|транскрипт|transcript)\s*:\s*/i, '')
    .trim();
  if (!cleaned || PLACEHOLDER.test(cleaned)) return '';
  return cleaned;
}

async function callOpenRouter({ model, base64, format, apiKey, timeoutMs, maxTokens }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${ASR.baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'http://127.0.0.1',
        'X-Title': 'Workspace',
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: TRANSCRIBE_PROMPT },
              { type: 'input_audio', input_audio: { data: base64, format } },
            ],
          },
        ],
        temperature: 0,
        max_tokens: maxTokens,
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      const error = new Error(`asr ${response.status}: ${body.slice(0, 200)}`);
      error.status = response.status;
      throw error;
    }
    const json = await response.json();
    const content = json?.choices?.[0]?.message?.content;
    const text = Array.isArray(content) ? content.map((c) => c.text || '').join('\n') : String(content || '');
    return text.trim();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Разбор WAV с PCM 16 бит: позиции данных и формат.
 *
 * Клиент всегда присылает WAV, собранный из WebAudio (16 кГц, моно, 16 бит),
 * поэтому полноценный декодер не нужен — но заголовок всё равно проверяем и
 * при любом сомнении возвращаем null: обрезать чужой формат нельзя.
 */
function parseWavPcm16(buffer) {
  if (buffer.length < 44) return null;
  if (buffer.toString('latin1', 0, 4) !== 'RIFF' || buffer.toString('latin1', 8, 12) !== 'WAVE') return null;
  let offset = 12;
  let format = null;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('latin1', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ') {
      if (body + 16 > buffer.length) return null;
      format = {
        audioFormat: buffer.readUInt16LE(body),
        channels: buffer.readUInt16LE(body + 2),
        sampleRate: buffer.readUInt32LE(body + 4),
        bitsPerSample: buffer.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      const length = Math.min(size, Math.max(0, buffer.length - body));
      if (format === null) return null;
      if (format.audioFormat !== 1 || format.bitsPerSample !== 16) return null;
      if (format.channels < 1 || format.channels > 2) return null;
      return { ...format, dataOffset: body, dataLength: length };
    }
    offset = body + size + (size % 2);
  }
  return null;
}

/** Собрать WAV из куска сырых PCM-данных, сохранив формат исходника. */
function encodeWavPcm16(format, data) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8, 'latin1');
  header.write('fmt ', 12, 'latin1');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(format.channels, 22);
  header.writeUInt32LE(format.sampleRate, 24);
  header.writeUInt32LE(format.sampleRate * format.channels * 2, 28);
  header.writeUInt16LE(format.channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'latin1');
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/**
 * Срезать тишину по краям записи.
 *
 * Человек нажимает «стоп» через полсекунды-секунду после последнего слова, и
 * этот хвост тишины уходит в модель как звук: лишние аудиотокены на входе —
 * лишние сотни миллисекунд на ответ. Режем по кадрам 20 мс, оставляя 200 мс
 * запаса, чтобы не срезать начало и конец слова.
 */
function trimWavSilence(buffer) {
  const format = parseWavPcm16(buffer);
  if (format === null) return buffer;
  const frameBytes = format.channels * 2;
  const frameMs = 20;
  const frameSize = Math.max(1, Math.round((format.sampleRate * frameMs) / 1000));
  const frames = Math.floor(format.dataLength / (frameSize * frameBytes));
  if (frames < 4) return buffer;

  const loudness = new Float64Array(frames);
  let peak = 0;
  for (let frame = 0; frame < frames; frame += 1) {
    let sum = 0;
    let count = 0;
    const start = format.dataOffset + frame * frameSize * frameBytes;
    for (let sample = 0; sample < frameSize; sample += 1) {
      let value = 0;
      for (let channel = 0; channel < format.channels; channel += 1) {
        value += buffer.readInt16LE(start + sample * frameBytes + channel * 2);
      }
      const mono = value / format.channels;
      sum += mono * mono;
      count += 1;
    }
    const rms = Math.sqrt(sum / Math.max(1, count));
    loudness[frame] = rms;
    if (rms > peak) peak = rms;
  }
  if (peak < 120) return buffer; // один шум: обрезать нечего, пусть модель скажет «тишина»

  const threshold = Math.max(peak * 0.05, 200);
  let first = 0;
  while (first < frames && loudness[first] < threshold) first += 1;
  let last = frames - 1;
  while (last > first && loudness[last] < threshold) last -= 1;
  if (first > last) return buffer;

  const margin = Math.round(200 / frameMs);
  const from = Math.max(0, first - margin);
  const to = Math.min(frames - 1, last + margin);
  if (from === 0 && to >= frames - 1) return buffer;

  const startByte = format.dataOffset + from * frameSize * frameBytes;
  const endByte = format.dataOffset + (to + 1) * frameSize * frameBytes;
  const data = buffer.subarray(startByte, Math.min(endByte, format.dataOffset + format.dataLength));
  if (data.length < format.sampleRate * frameBytes * 0.3) return buffer;
  return encodeWavPcm16(format, data);
}

/** Один запрос к модели-распознавателю. */
async function attemptModel({ model, base64, format, apiKey, timeoutMs, maxTokens }) {
  const raw = await callOpenRouter({ model, base64, format, apiKey, timeoutMs, maxTokens });
  const text = cleanTranscript(raw);
  if (!text) throw new Error('пустая расшифровка');
  return { text: truncate(text, 8000), provider: model };
}

/**
 * Распознаёт речь, запуская модели наперегонки.
 *
 * Раньше модели шли по очереди: каждая попытка ждала свой таймаут, и одна
 * медленная или упавшая модель задерживала ответ на десятки секунд — человек
 * всё это время смотрел на «Распознаю речь…». Теперь запросы уходят во все
 * модели сразу, ответ берётся от первой успешной, остальные отбрасываются.
 *
 * Принимает WAV/MP3 буфер, возвращает { text, provider }.
 */
export async function transcribeAudio({ buffer, format = 'wav' }) {
  if (!buffer || !buffer.length) throw Object.assign(new Error('Пустая запись'), { status: 400 });
  if (buffer.length > ASR.maxAudioBytes) {
    throw Object.assign(
      new Error(`Запись слишком длинная. Максимум ${Math.round(ASR.maxAudioBytes / 1024 / 1024)} МБ.`),
      { status: 413 },
    );
  }
  const apiKey = getOpenRouterKey();
  if (!apiKey) {
    throw Object.assign(new Error('Распознавание речи недоступно: не настроен ключ сервиса.'), { status: 503 });
  }
  // Тишина по краям — лишние аудиотокены на входе, а значит и лишние сотни
  // миллисекунд до первого слова расшифровки.
  const audio = format === 'wav' ? trimWavSilence(buffer) : buffer;
  const base64 = audio.toString('base64');
  const deadline = Date.now() + ASR.timeoutMs + 5000;
  const failures = [];

  return new Promise((resolve, reject) => {
    let pending = ASR.models.length;
    let settled = false;

    const fail = (error) => {
      pending -= 1;
      failures.push(error.message);
      if (pending > 0 || settled) return;
      settled = true;
      const failure = new Error('Не удалось распознать речь. Попробуйте ещё раз или введите текст.');
      failure.status = 502;
      failure.failures = failures;
      reject(failure);
    };

    for (const model of ASR.models) {
      const timeoutMs = Math.min(ASR.timeoutMs, Math.max(8000, deadline - Date.now()));
      attemptModel({ model, base64, format, apiKey, timeoutMs, maxTokens: ASR.maxTokens }).then(
        (result) => {
          if (settled) return;
          settled = true;
          resolve(result);
        },
        (error) => fail(new Error(`${model}: ${String(error.message).slice(0, 140)}`)),
      );
    }
  });
}
