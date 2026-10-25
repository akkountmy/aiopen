import { assertPublicUrl, assertResolvesPublic } from './search.mjs';

/* Проверка ссылок перед тем, как они попадут в отчёт, договор или ответ.
   Задача не «скачать страницу», а ответить на три вопроса: адрес живой, ведёт
   туда же, куда написано, и не отдаёт ли заглушку вместо документа. Тело ответа
   не читаем — после заголовков поток закрывается. */

export const LINK_LIMITS = {
  maxUrls: 12,
  timeoutMs: 10000,
  concurrency: 4,
};

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const DEAD_STATUS = new Set([404, 410, 451]);
const GATED_STATUS = new Set([401, 402, 403, 405, 406, 418, 429]);
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;

/** Проверяет до LINK_LIMITS.maxUrls адресов параллельно, по 4 за раз. */
export async function checkLinks(rawUrls, { timeoutMs = LINK_LIMITS.timeoutMs, maxUrls = LINK_LIMITS.maxUrls } = {}) {
  const urls = [];
  const seen = new Set();
  for (const item of Array.isArray(rawUrls) ? rawUrls : [rawUrls]) {
    const value = String(item || '').trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    urls.push(value);
    if (urls.length >= maxUrls) break;
  }
  if (!urls.length) return [];

  const results = new Array(urls.length);
  let cursor = 0;
  const workers = new Array(Math.min(LINK_LIMITS.concurrency, urls.length)).fill(null).map(async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= urls.length) return;
      results[index] = await probeLink(urls[index], timeoutMs);
    }
  });
  await Promise.all(workers);
  return results.filter(Boolean);
}

async function probeLink(raw, timeoutMs) {
  let url;
  try {
    url = assertPublicUrl(raw);
  } catch (error) {
    return { url: raw, finalUrl: '', status: 0, state: 'unknown', note: error?.message || 'адрес не принят' };
  }

  const seconds = Math.max(2, Math.round(timeoutMs / 1000));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(2000, timeoutMs));
  try {
    /* Редиректы разбираем вручную: каждый следующий адрес проходит ту же
       проверку. Автоматический `redirect: 'follow'` доверяет заголовку Location,
       и публичный сайт мог бы увести сервис на 127.0.0.1 или в метаданные. */
    let current = url;
    let res = null;
    for (let hop = 0; ; hop += 1) {
      await assertResolvesPublic(current.hostname);
      res = await fetch(current, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'User-Agent': UA,
          Accept: 'text/html,application/xhtml+xml,application/pdf;q=0.9,*/*;q=0.8',
          'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8',
        },
      });
      if (!REDIRECT_STATUS.has(res.status)) break;
      const location = res.headers.get('location');
      try {
        await res.body?.cancel();
      } catch {
        /* поток уже закрыт — не мешает */
      }
      if (!location) break;
      let next;
      try {
        next = new URL(location, current);
        assertPublicUrl(next.href);
      } catch {
        return {
          url: raw,
          finalUrl: String(location),
          status: res.status,
          state: 'unknown',
          note: 'ведёт на служебный адрес — такую переадресацию не проверяю',
        };
      }
      if (hop >= MAX_REDIRECTS) {
        return { url: raw, finalUrl: next.href, status: res.status, state: 'error', note: `больше ${MAX_REDIRECTS} перенаправлений` };
      }
      current = next;
    }

    const finalUrl = current.href;
    const status = res.status;
    const type = String(res.headers.get('content-type') || '').split(';')[0].trim();
    try {
      await res.body?.cancel();
    } catch {
      /* поток уже закрыт — не мешает */
    }

    const state = status >= 200 && status < 300 ? 'alive' : DEAD_STATUS.has(status) ? 'dead' : GATED_STATUS.has(status) ? 'gated' : 'error';
    const notes = [];
    if (state === 'dead') notes.push('страница удалена');
    if (state === 'gated') notes.push('сервер закрыл автоматическую проверку');
    if (state === 'error') notes.push(status >= 500 ? 'ошибка на стороне сайта' : 'нестандартный ответ');
    const sameHost = safeHost(finalUrl) === url.hostname.replace(/^www\./, '');
    if (finalUrl !== url.href) {
      notes.push(sameHost ? `переадресация внутри сайта на ${safePath(finalUrl)}` : `редирект на ${safeHost(finalUrl) || 'другой адрес'}`);
    }
    if (state === 'alive' && type && !/(text\/html|application\/pdf|text\/plain|application\/(json|xml)|application\/vnd\.|text\/csv)/.test(type)) {
      notes.push(`тип ${type}`);
    }
    return { url: raw, finalUrl, status, state, type, note: notes.join(', ') };
  } catch (error) {
    const aborted = error?.name === 'AbortError';
    return {
      url: raw,
      finalUrl: '',
      status: 0,
      state: 'unknown',
      note: aborted ? `не ответил за ${seconds} секунд` : String(error?.message || 'нет соединения'),
    };
  } finally {
    clearTimeout(timer);
  }
}

function safeHost(value) {
  try {
    return new URL(value).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function safePath(value) {
  try {
    const url = new URL(value);
    const tail = `${url.pathname}${url.search}`;
    return tail.length > 60 ? `${tail.slice(0, 59)}…` : tail || '/';
  } catch {
    return 'другой адрес';
  }
}

/** Короткая русская сводка: сколько живых, мёртвых и непроверяемых. */
export function summarizeLinks(results) {
  const total = results.length;
  const alive = results.filter((item) => item.state === 'alive').length;
  const dead = results.filter((item) => item.state === 'dead').length;
  const unknown = total - alive - dead;
  const parts = [`Проверено ${total} ${plural(total, 'ссылка', 'ссылки', 'ссылок')}: живых ${alive}, мёртвых ${dead}`];
  if (unknown) parts.push(`не проверить ${unknown}`);
  return `${parts.join(', ')}.`;
}

export function formatLinks(results) {
  if (!results.length) return 'Проверять нечего: ссылок нет.';
  const lines = results.map((item, index) => {
    const bits = [item.status ? `код ${item.status}` : 'без ответа'];
    if (item.note) bits.push(item.note);
    return `${index + 1}. ${item.url} — ${bits.join(', ')}`;
  });
  return `${summarizeLinks(results)}\n${lines.join('\n')}`;
}

/** Ссылки из текста: пригодится, когда проверяют готовый ответ или отчёт. */
export function linksFromText(text = '', limit = LINK_LIMITS.maxUrls) {
  const found = [];
  const seen = new Set();
  const matches = String(text).match(/https?:\/\/[^\s<>"'`)\]]+/gi) || [];
  for (const raw of matches) {
    const url = raw.replace(/[.,;:]+$/, '');
    if (seen.has(url)) continue;
    seen.add(url);
    found.push(url);
    if (found.length >= limit) break;
  }
  return found;
}

function plural(count, one, few, many) {
  const n = Math.abs(Number(count) || 0) % 100;
  const last = n % 10;
  if (n > 10 && n < 20) return many;
  if (last === 1) return one;
  if (last >= 2 && last <= 4) return few;
  return many;
}
