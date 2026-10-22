/**
 * Контекст проекта: короткая выжимка прошлых диалогов, чтобы новый разговор в
 * том же проекте не начинался с чистого листа.
 *
 * Память чата (`chat.memory`) относится только к своему диалогу, поэтому второй
 * диалог по той же теме раньше не знал ничего о первом: пользователь видел это
 * как «контекст потерялся». Здесь собираем по каждому прошлому диалогу одну
 * строку — когда он был и чем закончился, — и отдаём модели небольшим блоком.
 *
 * Правила:
 *  1. Только диалоги того же проекта: чужие чаты сюда не попадают.
 *  2. Бюджет жёсткий: контекст проекта не должен вытеснять текущий разговор.
 *  3. Без домыслов: берём последний ответ ассистента (или реплику пользователя),
 *     обрезаем и убираем markdown — модель видит факты, а не наши пересказы.
 */

const DEFAULT_MAX_CHATS = 5;
const DEFAULT_MAX_CHARS = 1600;
const DIGEST_CHARS = 240;

/** Текст сообщения без разметки: одна строка, пригодная для подсказки. */
function plainText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => (typeof part === 'string' ? part : part?.type === 'text' ? part.text : ''))
    .join(' ');
}

function tidy(text) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[#*_>`|]/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function clip(text, limit) {
  const clean = tidy(text);
  if (clean.length <= limit) return clean;
  return `${clean.slice(0, limit - 1).trimEnd()}…`;
}

function when(iso) {
  const date = new Date(iso || 0);
  if (Number.isNaN(date.getTime())) return '';
  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  return `${day}.${month}`;
}

/** Слова вопроса длиннее трёх букв — по ним ищем тематически близкие диалоги. */
function keywords(text) {
  const words = String(text || '')
    .toLowerCase()
    .replace(/[^a-zа-яё0-9\s-]/gi, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 3);
  return new Set(words.slice(0, 40));
}

/**
 * Чем закончился диалог: последний содержательный ответ ассистента, иначе —
 * последняя реплика пользователя. Пустые ответы (например, остановленный ход)
 * пропускаем, иначе в контекст попадёт пустая строка.
 */
function digestOf(messages) {
  const list = Array.isArray(messages) ? messages : [];
  for (let index = list.length - 1; index >= 0; index--) {
    const message = list[index];
    const text = tidy(plainText(message?.content));
    if (text.length >= 12) return clip(text, DIGEST_CHARS);
  }
  return '';
}

/**
 * @param {object} params
 * @param {Array<{id: string, title?: string, updatedAt?: string, createdAt?: string}>} params.chats
 *        диалоги проекта (метаданные из индекса), текущий среди них
 * @param {string} params.currentChatId диалог, для которого собираем контекст
 * @param {(id: string) => (object|null)} params.load читает файл диалога
 * @param {string} [params.question] текущий вопрос: по нему выбираем близкие темы
 * @param {number} [params.maxChats]
 * @param {number} [params.maxChars]
 * @returns {string} блок для системной подсказки или пустая строка
 */
export function buildProjectContext({
  chats = [],
  currentChatId = '',
  load = null,
  question = '',
  maxChats = DEFAULT_MAX_CHATS,
  maxChars = DEFAULT_MAX_CHARS,
} = {}) {
  if (typeof load !== 'function' || !Array.isArray(chats) || !chats.length) return '';
  const words = keywords(question);
  const candidates = [];
  for (const meta of chats) {
    if (!meta?.id || meta.id === currentChatId) continue;
    let data = null;
    try {
      data = load(meta.id);
    } catch {
      data = null;
    }
    const messages = Array.isArray(data?.messages) ? data.messages : [];
    if (!messages.length) continue;
    const digest = digestOf(messages);
    if (!digest) continue;
    const title = tidy(meta.title) || tidy(messages.find((message) => message.role === 'user')?.content) || 'Диалог';
    const haystack = `${title} ${digest}`.toLowerCase();
    let score = 0;
    for (const word of words) if (haystack.includes(word)) score += 1;
    candidates.push({
      title: clip(title, 60),
      digest,
      date: when(meta.updatedAt || messages[messages.length - 1]?.at || meta.createdAt),
      score,
      updatedAt: Date.parse(meta.updatedAt || meta.createdAt || '') || 0,
    });
  }
  if (!candidates.length) return '';
  candidates.sort((a, b) => b.score - a.score || b.updatedAt - a.updatedAt);

  const lines = [];
  let used = 0;
  for (const item of candidates) {
    if (lines.length >= maxChats) break;
    const line = `— «${item.title}»${item.date ? ` (${item.date})` : ''}: ${item.digest}`;
    if (used + line.length > maxChars) continue;
    lines.push(line);
    used += line.length + 1;
  }
  if (!lines.length) return '';
  return [
    'Прошлые диалоги этого проекта (контекст, чтобы не начинать с нуля и не переспрашивать уже решённое):',
    ...lines,
    'Опирайся на этот контекст, если он относится к вопросу. Деталей не хватает — прочитай файлы проекта инструментами, а не спрашивай заново.',
  ].join('\n');
}
