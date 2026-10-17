import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, MODEL, VISION } from './config.mjs';
import { getDeepSeekKey, getOpenRouterKey } from './keys.mjs';
import { readJson, sha256, truncate } from './util.mjs';

const CACHE_FILE = path.join(DATA_DIR, 'vision-cache.json');
let cache = null;

function loadCache() {
  if (cache) return cache;
  cache = readJson(CACHE_FILE, {}) || {};
  return cache;
}

function saveCache() {
  if (!cache) return;
  const entries = Object.entries(cache);
  if (entries.length > 400) {
    entries.sort((a, b) => (b[1].at || 0) - (a[1].at || 0));
    cache = Object.fromEntries(entries.slice(0, 300));
  }
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache));
  } catch {
    /* ignore */
  }
}

const OCR_PROMPT = [
  'Ты — модуль распознавания изображений внутри рабочего сервиса.',
  'Задача: извлечь из изображения всю текстовую информацию дословно (OCR), сохранив порядок строк, числа, единицы, заголовки, подписи и содержимое таблиц.',
  'Затем коротко опиши, что изображено (скриншот программы, документ, таблица, фото, схема) и какие на нём ключевые элементы.',
  'Если текста нет — опиши содержимое подробно.',
  'Формат ответа строго такой:\nТЕКСТ:\n<дословный текст или «текста нет»>\n\nОПИСАНИЕ:\n<2–6 предложений>\n\nДЕТАЛИ:\n<таблицы, числа, подписи, важные элементы — если есть>',
  'Пиши на языке оригинала содержимого. Никаких служебных пояснений и извинений.',
].join('\n');

function mimeFromName(name) {
  const ext = String(name).toLowerCase().split('.').pop();
  return (
    {
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      webp: 'image/webp',
      gif: 'image/gif',
      bmp: 'image/bmp',
      tif: 'image/tiff',
      tiff: 'image/tiff',
      avif: 'image/avif',
      heic: 'image/heic',
    }[ext] || 'image/png'
  );
}

async function callOpenRouter({ model, dataUrl, instruction, apiKey, timeoutMs, maxTokens }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${VISION.baseURL}/chat/completions`, {
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
              { type: 'text', text: instruction || OCR_PROMPT },
              { type: 'image_url', image_url: { url: dataUrl } },
            ],
          },
        ],
        temperature: 0.1,
        max_tokens: maxTokens,
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      const error = new Error(`vision ${response.status}: ${body.slice(0, 200)}`);
      error.status = response.status;
      throw error;
    }
    const json = await response.json();
    const content = json?.choices?.[0]?.message?.content;
    const text = Array.isArray(content) ? content.map((c) => c.text || '').join('\n') : String(content || '');
    if (!text.trim()) throw new Error('vision: пустой ответ');
    return text.trim();
  } finally {
    clearTimeout(timer);
  }
}

async function callMainModelVision({ dataUrl, instruction, apiKey, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${MODEL.baseURL}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODEL.name,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: instruction || OCR_PROMPT },
              { type: 'image_url', image_url: { url: dataUrl } },
            ],
          },
        ],
        max_tokens: 3000,
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`vision-fallback ${response.status}: ${body.slice(0, 160)}`);
    }
    const json = await response.json();
    const content = json?.choices?.[0]?.message?.content;
    const text = Array.isArray(content) ? content.map((c) => c.text || '').join('\n') : String(content || '');
    if (!text.trim()) throw new Error('vision-fallback: пустой ответ');
    return text.trim();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Распознаёт изображение по цепочке бесплатных моделей, затем (резерв) — основная модель.
 * Возвращает { text, provider: 'free'|'fallback', cached }.
 */
export async function describeImage({ buffer, mime, name, instruction }) {
  const type = mime || mimeFromName(name);
  const hash = sha256(`${type}:${instruction || ''}:${buffer.length}:`) + sha256(buffer.subarray(0, Math.min(buffer.length, 65536)));
  const cacheStore = loadCache();
  if (cacheStore[hash]) {
    return { text: cacheStore[hash].text, provider: 'cache', cached: true };
  }

  if (buffer.length > VISION.maxImageBytes) {
    const error = new Error(`Изображение слишком большое (${(buffer.length / 1024 / 1024).toFixed(1)} МБ). Максимум ${Math.round(VISION.maxImageBytes / 1024 / 1024)} МБ.`);
    error.status = 413;
    throw error;
  }

  const dataUrl = `data:${type};base64,${buffer.toString('base64')}`;
  const openRouterKey = getOpenRouterKey();
  const mainKey = getDeepSeekKey();
  const deadline = Date.now() + VISION.totalBudgetMs;
  const failures = [];

  if (openRouterKey) {
    for (const model of VISION.models) {
      for (let attempt = 1; attempt <= VISION.attemptsPerModel; attempt++) {
        if (Date.now() > deadline) break;
        const timeoutMs = Math.min(VISION.timeoutMs, Math.max(5000, deadline - Date.now()));
        try {
          const text = await callOpenRouter({
            model,
            dataUrl,
            instruction,
            apiKey: openRouterKey,
            timeoutMs,
            maxTokens: VISION.maxTokens,
          });
          const result = { text: truncate(text, 12000), provider: 'free', cached: false };
          cacheStore[hash] = { text: result.text, at: Date.now() };
          saveCache();
          return result;
        } catch (error) {
          failures.push(`${model}#${attempt}: ${error.message.slice(0, 120)}`);
          if (error.status && error.status >= 400 && error.status < 500 && error.status !== 429) break;
        }
      }
      if (Date.now() > deadline) break;
    }
  }

  if (MODEL.visionFallback && mainKey) {
    try {
      const text = await callMainModelVision({
        dataUrl,
        instruction,
        apiKey: mainKey,
        timeoutMs: Math.min(60000, Math.max(8000, deadline - Date.now() + 30000)),
      });
      const result = { text: truncate(text, 12000), provider: 'fallback', cached: false };
      cacheStore[hash] = { text: result.text, at: Date.now() };
      saveCache();
      return result;
    } catch (error) {
      failures.push(`reserve: ${error.message.slice(0, 120)}`);
    }
  }

  const error = new Error('Не удалось распознать изображение. Попробуйте уменьшить файл или повторить позже.');
  error.failures = failures;
  throw error;
}

export function visionPromptFor(kind) {
  if (kind === 'screenshot') return OCR_PROMPT;
  return OCR_PROMPT;
}
