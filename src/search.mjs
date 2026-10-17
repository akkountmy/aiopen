import { extractDocumentText } from './docparse.mjs';
import { truncate } from './util.mjs';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function decodeEntities(text) {
  return String(text)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

export function htmlToText(html) {
  return decodeEntities(
    String(html)
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<\/(p|div|li|tr|h[1-6]|section|article|blockquote)>/gi, '\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t\u00a0]{2,}/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Поиск в интернете без ключей. Возвращает [{ title, url, snippet }]. */
export async function webSearch(query, limit = 6) {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}&kl=ru-ru`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8' },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Поиск недоступен (${response.status})`);
    const html = await response.text();
    const results = [];
    const blockRe = /<a[^>]+class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>([\s\S]{0,900}?)(?=<a[^>]+class="result__a"|<\/body>)/g;
    let match;
    while ((match = blockRe.exec(html)) && results.length < limit) {
      let link = decodeEntities(match[1]);
      const uddg = link.match(/[?&]uddg=([^&]+)/);
      if (uddg) link = decodeURIComponent(uddg[1]);
      if (link.startsWith('//')) link = `https:${link}`;
      if (!/^https?:/.test(link)) continue;
      const title = htmlToText(match[2]).slice(0, 200);
      const snippetMatch = match[3].match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/);
      const snippet = snippetMatch ? htmlToText(snippetMatch[1]).slice(0, 400) : '';
      results.push({ title, url: link, snippet });
    }
    return results;
  } finally {
    clearTimeout(timer);
  }
}

/** Загружает страницу и приводит её к тексту. */
export async function fetchUrl(url, { maxChars = 24000 } = {}) {
  if (!/^https?:\/\//i.test(url)) throw new Error('Нужна ссылка вида http:// или https://');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': UA,
        'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8',
        Accept: 'text/html,application/xhtml+xml,application/pdf,text/plain;q=0.9,*/*;q=0.5',
      },
      redirect: 'follow',
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Страница вернула ${response.status}`);
    const contentType = response.headers.get('content-type') || '';
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > 12 * 1024 * 1024) throw new Error('Страница слишком большая');
    let text;
    let kind = 'text';
    if (contentType.includes('pdf') || url.toLowerCase().endsWith('.pdf')) {
      const parsed = extractDocumentText(buffer, 'download.pdf', 'application/pdf');
      text = parsed.text;
      kind = 'pdf';
    } else if (contentType.includes('json') || contentType.startsWith('text/')) {
      text = buffer.toString('utf8');
      kind = contentType.includes('json') ? 'json' : 'text';
    } else {
      text = htmlToText(buffer.toString('utf8'));
      kind = 'html';
    }
    return {
      url: response.url || url,
      kind,
      title: (text.match(/^.{0,120}/) || [''])[0],
      text: truncate(text, maxChars),
      bytes: buffer.length,
    };
  } finally {
    clearTimeout(timer);
  }
}
