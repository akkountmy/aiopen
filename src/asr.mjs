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
 * Распознаёт речь по цепочке бесплатных моделей.
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
  const base64 = buffer.toString('base64');
  const failures = [];
  const deadline = Date.now() + ASR.timeoutMs * ASR.models.length;
  for (const model of ASR.models) {
    for (let attempt = 1; attempt <= ASR.attemptsPerModel; attempt++) {
      if (Date.now() > deadline) break;
      try {
        const raw = await callOpenRouter({
          model,
          base64,
          format,
          apiKey,
          timeoutMs: Math.min(ASR.timeoutMs, Math.max(8000, deadline - Date.now())),
          maxTokens: ASR.maxTokens,
        });
        const text = cleanTranscript(raw);
        if (!text) throw new Error('пустая расшифровка');
        return { text: truncate(text, 8000), provider: model };
      } catch (error) {
        failures.push(`${model}#${attempt}: ${String(error.message).slice(0, 140)}`);
        if (error.status && error.status >= 400 && error.status < 500 && error.status !== 429) break;
      }
    }
  }
  const error = new Error('Не удалось распознать речь. Попробуйте ещё раз или введите текст.');
  error.status = 502;
  error.failures = failures;
  throw error;
}
