/**
 * DeepSeek Search / Fetch — живой интернет без браузера.
 *
 * Зачем: собственный парсер ищет «как получится» и не знает ни даты страницы,
 * ни её авторитетности. DeepSeek отдаёт готовую ранжированную выдачу с
 * rerank-скором, тиром авторитетности и summary, а Fetch — ту же страницу
 * в Markdown, без Chromium.
 *
 * Ключ: DSHOW_DEEPSEEK_KEY (в облаке) или DEEPSEEK_API_KEY. Если ключа нет —
 * вызывающий код молча уходит на прежний поиск, сервис продолжает работать.
 * Отключить принудительно: DSHOW_DEEPSEEK_SEARCH=0.
 */

const BASE = String(process.env.DSHOW_DEEPSEEK_BASE || 'https://api.deepseek.com').replace(/\/+$/, '');
const KEY = String(process.env.DSHOW_DEEPSEEK_KEY || process.env.DEEPSEEK_API_KEY || '').trim();
const TIMEOUT_MS = Math.max(5000, Number(process.env.DSHOW_DEEPSEEK_TIMEOUT_MS) || 25000);

export function deepseekEnabled() {
  return Boolean(KEY) && process.env.DSHOW_DEEPSEEK_SEARCH !== '0';
}

function errorText(raw) {
  try {
    const data = JSON.parse(raw);
    return String(data?.error?.message || data?.message || '').trim();
  } catch {
    return String(raw || '').trim().slice(0, 300);
  }
}

async function call(path, payload, { timeoutMs = TIMEOUT_MS, signal } = {}) {
  if (!deepseekEnabled()) throw new Error('DeepSeek Search выключен');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  try {
    const response = await fetch(BASE + path, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${KEY}`,
        'content-type': 'application/json',
        accept: 'application/json',
        'user-agent': 'dshow-deepsearch/1.0',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const raw = await response.text();
    if (!response.ok) {
      const message = errorText(raw) || `HTTP ${response.status}`;
      throw new Error(`DeepSeek ${path}: ${message}`);
    }
    return raw ? JSON.parse(raw) : {};
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

function cleanUrl(raw) {
  const value = String(raw || '').trim();
  if (!/^https?:/i.test(value)) return '';
  try {
    const url = new URL(value);
    // Выдача DeepSeek иногда добавляет служебный якорь #1 к адресу.
    if (/^#\d+$/.test(url.hash)) url.hash = '';
    return url.toString();
  } catch {
    return '';
  }
}

/**
 * Поиск. Возвращает те же поля, что и прежний webSearch, плюс summary, date,
 * authority, score — вызывающий код может их показывать или игнорировать.
 */
export async function deepseekSearch(query, { count = 6, needContent = false, oriQuestion = '', signal } = {}) {
  const text = String(query || '').trim();
  if (!text) throw new Error('Нужен поисковый запрос');
  const payload = {
    query: text.slice(0, 128),
    count: Math.max(1, Math.min(50, Number(count) || 6)),
    need_content: Boolean(needContent),
  };
  if (oriQuestion) payload.ori_question = String(oriQuestion).slice(0, 128);
  const data = await call('/v1/tools/search', payload, { signal });
  const results = [];
  const seen = new Set();
  for (const item of Array.isArray(data.results) ? data.results : []) {
    const url = cleanUrl(item.url);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    results.push({
      title: String(item.title || '').trim(),
      url,
      snippet: String(item.snippet || item.summary || '').trim(),
      summary: String(item.summary || '').trim(),
      content: String(item.content || '').trim(),
      site: String(item.site_name || '').trim(),
      date: String(item.date || '').trim(),
      authority: Number.isFinite(Number(item.authority)) ? Number(item.authority) : null,
      score: Number.isFinite(Number(item.rerank_score)) ? Number(item.rerank_score) : null,
    });
  }
  return results;
}

/** Загрузка страницы как Markdown. */
export async function deepseekFetch(url, { signal } = {}) {
  const data = await call('/v1/tools/fetch', { url: String(url || '').trim() }, { signal });
  // Fetch отдаёт Markdown с экранированной пунктуацией (\#, \-, \/). Модели
  // читать такое тяжело, поэтому снимаем служебные обратные слэши.
  const content = String(data.content || '').replace(/\\([^\w\s])/g, '$1');
  if (!content.trim()) throw new Error('DeepSeek Fetch не отдал текст страницы');
  return {
    url: String(data.url || url || ''),
    title: String(data.title || '').trim(),
    content,
  };
}

/** Короткий статус для health/диагностики: без ключа и без сетевых запросов. */
export function deepseekStatus() {
  return {
    enabled: deepseekEnabled(),
    key: Boolean(KEY),
    base: BASE,
    timeoutMs: TIMEOUT_MS,
  };
}
