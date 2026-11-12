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

/* ------------------------- память о здоровье моделей -------------------------
   Бесплатная цепочка — это внешние сервисы: одна модель отвечает за секунду,
   другая в это время лежит. Раньше порядок был жёстко записан в конфиге, и
   человек ждал, пока сервис переберёт всех по очереди (в худшем случае до
   сотни секунд). Теперь исход каждой попытки запоминается: модель, которая
   только что ответила, идёт первой, а та, что только что упала, остывает и
   пробуется последней. Это чистая экономия времени: тот же ответ, но без
   перебора мёртвых моделей. */
const HEALTH_FILE = path.join(DATA_DIR, 'vision-health.json');
/* Сколько модель «остывает» после падения, прежде чем снова стать кандидатом. */
const COOLDOWN_MS = Math.max(30 * 1000, Number(process.env.DSHOW_VISION_COOLDOWN_MS || 10 * 60 * 1000));
/* Сколько моделей спрашиваем одновременно: три — достаточно, чтобы обойти
   зависшую пару, и мало, чтобы не устраивать лавину запросов на каждый скриншот. */
const RACE_WIDTH = Math.max(1, Math.min(4, Number(process.env.DSHOW_VISION_RACE || 3)));
/* Отступ между запусками моделей: вторая пробуется, если первая молчит. */
const HEDGE_MS = Math.max(200, Math.min(10000, Number(process.env.DSHOW_VISION_HEDGE_MS || 1500)));
/* Потолок одного запроса к модели: 45 с на попытку — это ожидание, а не работа. */
const ATTEMPT_MS = Math.max(5000, Number(process.env.DSHOW_VISION_ATTEMPT_MS || 20000));
/* Потолок всей бесплатной цепочки: дальше — сразу основная модель. */
const CHAIN_BUDGET_MS = Math.max(10000, Number(process.env.DSHOW_VISION_BUDGET_MS || 45000));

let health = null;

function loadHealth() {
  if (health) return health;
  health = readJson(HEALTH_FILE, {}) || {};
  return health;
}

function saveHealth() {
  if (!health) return;
  const entries = Object.entries(health);
  /* Держим только свежее: файл читается при каждом старте. */
  const now = Date.now();
  const alive = entries
    .filter(([, item]) => item && now - Math.max(Number(item.at || 0)) < 24 * 3600 * 1000)
    .sort((a, b) => Number(b[1].at || 0) - Number(a[1].at || 0))
    .slice(0, 20);
  health = Object.fromEntries(alive);
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(HEALTH_FILE, JSON.stringify(health));
  } catch {
    /* без памяти о здоровье цепочка просто работает по порядку из конфига */
  }
}

function healthOf(model) {
  const item = loadHealth()[model] || {};
  return {
    okAt: Number(item.okAt || 0),
    failAt: Number(item.failAt || 0),
    fails: Number(item.fails || 0),
    ms: Number(item.ms || 0),
  };
}

function markHealth(model, ok, ms) {
  const store = loadHealth();
  const prev = healthOf(model);
  const now = Date.now();
  store[model] = ok
    ? { okAt: now, failAt: prev.failAt, fails: 0, at: now, ms: Math.round(ms || prev.ms || 0) }
    : { okAt: prev.okAt, failAt: now, fails: prev.fails + 1, at: now, ms: prev.ms };
  saveHealth();
}

/**
 * Порядок моделей для этого запроса: сначала проверенные, потом незнакомые,
 * последними — остывающие. `cooling` помечает модели, которые падали настолько
 * недавно, что тратить на них время бессмысленно.
 */
export function orderVisionModels(models = VISION.models, now = Date.now()) {
  const scored = models.map((model, index) => {
    const item = healthOf(model);
    const freshOk = item.okAt > item.failAt;
    const cooling = !freshOk && item.failAt > 0 && now - item.failAt < COOLDOWN_MS;
    /* Меньше — раньше: 0 проверенные, 1 незнакомые, 2 остывающие. */
    const tier = freshOk ? 0 : cooling ? 2 : 1;
    /* Внутри группы: проверенные — по свежести успеха, остальные — по свежести падения. */
    const order = freshOk ? -item.okAt : tier === 2 ? now - item.failAt : 0;
    return { model, tier, order, index, cooling, ms: item.ms };
  });
  scored.sort((a, b) => a.tier - b.tier || a.order - b.order || a.index - b.index);
  return scored;
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

async function callOpenRouter({ model, dataUrl, instruction, apiKey, timeoutMs, maxTokens, signal }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  /* Внешняя отмена нужна гонке: когда одна модель уже ответила, остальные
     запросы не должны досчитываться впустую. */
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', () => controller.abort(), { once: true });
  }
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
 * Гонка по бесплатной цепочке: запросы идут с небольшим отступом, побеждает
 * первый удачный, остальные отменяются.
 *
 * Почему не «два сразу». Если оба первых запроса попадут на зависшие модели,
 * человек ждёт полный таймаут, хотя третья модель в это время жива и отвечает
 * за секунду. Поэтому вторая модель стартует через `HEDGE_MS` после первой,
 * третья — ещё через столько же: живая модель успевает ответить раньше, чем
 * мёртвые съедят весь бюджет. Пределы: `RACE_WIDTH` одновременно, `ATTEMPT_MS`
 * на запрос, `CHAIN_BUDGET_MS` на всю цепочку.
 */
async function raceFreeModels({ dataUrl, instruction, apiKey, deadline }) {
  const ranked = orderVisionModels();
  /* Сначала живые и незнакомые, в самом конце — остывающие. */
  const queue = ranked.filter((item) => !item.cooling).map((item) => item.model);
  const failed = [];
  const startedAt = Date.now();
  const group = new AbortController();
  let networkFails = 0;

  return await new Promise((resolve, reject) => {
    let next = 0;
    let active = 0;
    let settled = false;
    let hedge = null;

    const stopHedge = () => {
      if (hedge) clearTimeout(hedge);
      hedge = null;
    };

    const finish = () => {
      if (settled) return;
      settled = true;
      stopHedge();
      group.abort();
      const error = new Error(`vision: все модели отказали (${failed.length})`);
      error.failures = failed;
      reject(error);
    };

    const planNext = () => {
      if (settled || hedge) return;
      if (next >= queue.length || Date.now() > deadline) {
        if (active === 0) finish();
        return;
      }
      hedge = setTimeout(() => {
        hedge = null;
        launch();
        planNext();
      }, HEDGE_MS);
      hedge.unref?.();
    };

    const launch = () => {
      if (settled) return;
      if (next >= queue.length) {
        if (active === 0) finish();
        return;
      }
      if (Date.now() > deadline) {
        if (active === 0) finish();
        return;
      }
      if (active >= RACE_WIDTH) return;
      const model = queue[next++];
      active += 1;
      const timeoutMs = Math.max(5000, Math.min(ATTEMPT_MS, deadline - Date.now()));
      const at = Date.now();
      callOpenRouter({ model, dataUrl, instruction, apiKey, timeoutMs, maxTokens: VISION.maxTokens, signal: group.signal })
        .then((text) => {
          active -= 1;
          markHealth(model, true, Date.now() - at);
          if (!settled) {
            settled = true;
            stopHedge();
            /* Остальные модели уже не нужны: их ответы — только потраченное время. */
            group.abort();
            resolve({ text, model, ms: Date.now() - startedAt });
          }
        })
        .catch((error) => {
          active -= 1;
          markHealth(model, false);
          const message = String(error.message || '').slice(0, 120);
          failed.push(`${model} (${Date.now() - at} мс): ${message}`);
          if (/fetch failed|aborted|socket|timeout/i.test(message)) networkFails += 1;
          if (!settled) {
            /* Сеть недоступна у нескольких моделей подряд — это не «модель
               сломалась», а «нет связи»: перебирать оставшиеся бессмысленно,
               быстрее уйти в резерв и ответить человеку. Остальные модели тоже
               помечаем остывшими: причина у них та же, и следующий снимок не
               должен снова платить за проверку связи. */
            if (networkFails >= 2) {
              for (const rest of queue.slice(next)) markHealth(rest, false);
              finish();
              return;
            }
            launch();
            planNext();
          }
        });
    };

    if (!queue.length) {
      finish();
      return;
    }
    launch();
    planNext();
  });
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
  const deadline = Date.now() + Math.min(VISION.totalBudgetMs, CHAIN_BUDGET_MS);
  const failures = [];

  /* Если все бесплатные модели только что падали — не тратим на них ни секунды
     и сразу идём к основной модели: так фото распознаётся хоть как-то, но быстро. */
  const ready = openRouterKey ? orderVisionModels().some((item) => !item.cooling) : false;
  if (openRouterKey && !ready) failures.push('free-chain: все модели недавно падали, сразу резерв');

  if (openRouterKey && ready) {
    try {
      const { text, model, ms } = await raceFreeModels({ dataUrl, instruction, apiKey: openRouterKey, deadline });
      const result = { text: truncate(text, 12000), provider: 'free', cached: false, model, ms };
      cacheStore[hash] = { text: result.text, at: Date.now() };
      saveCache();
      return result;
    } catch (error) {
      for (const item of error.failures || []) failures.push(item);
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
