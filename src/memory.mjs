/**
 * Постоянная память пользователя — то, что переживает отдельный диалог.
 *
 * В отличие от chat.memory (сводка одного разговора), здесь лежат устойчивые
 * вещи: как человек предпочитает оформлять документы, какие у него правила и
 * названия, что мы уже решили и не должны переспрашивать. Память хранится на
 * записи пользователя в index.json и подмешивается в системное сообщение
 * каждого хода — как pinned-предпочтения в локальном харнессе.
 */

/** Сколько фактов держим: больше — уже не память, а свалка. */
export const MEMORY_LIMITS = {
  /* Сотня фактов — это несколько лет правил и договорённостей. Дальше не
     режем по «первые N», а отбираем по теме запроса (см. searchFacts). */
  maxFacts: 100,
  maxFactChars: 400,
  /* Бюджет вставки в системное сообщение. Не даём памяти раздуть промпт:
     в подсказку идёт отобранное по теме, а не весь список. */
  promptChars: 3600,
  /* Сколько фактов максимум в подсказке одного хода. */
  maxPromptFacts: 28,
};

export function emptyFacts() {
  return [];
}

export function normalizeFact(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .replace(/^[-—•*\s]+/, '')
    .trim()
    .slice(0, MEMORY_LIMITS.maxFactChars);
}

/** Ключ для поиска дублей: регистр и пунктуация не должны плодить копии. */
function factKey(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[ё]/g, 'е')
    .replace(/[^a-zа-я0-9]+/gi, ' ')
    .trim();
}

export function sameFact(a, b) {
  return factKey(a) === factKey(b);
}

/** Служебные слова: они есть в любом запросе и не помогают отобрать факты. */
const STOP_WORDS = new Set([
  'что',
  'чтобы',
  'это',
  'как',
  'для',
  'или',
  'так',
  'там',
  'тут',
  'мне',
  'нам',
  'надо',
  'нужно',
  'есть',
  'было',
  'были',
  'быть',
  'все',
  'всё',
  'ещё',
  'еще',
  'уже',
  'если',
  'когда',
  'потом',
  'также',
  'тоже',
  'этот',
  'эта',
  'эти',
  'того',
  'чему',
  'чем',
  'про',
  'при',
  'над',
  'под',
  'без',
  'через',
  'пользователь',
  'файл',
  'файлы',
  'сделай',
  'сделать',
  'нужен',
  'нужна',
  'можно',
  'лишь',
  'только',
  'очень',
]);

/** Основа слова: первые символы без окончания — «документами» ≈ «документ». */
function stem(word) {
  const clean = String(word || '').toLowerCase().replace(/[ё]/g, 'е');
  if (clean.length <= 4) return clean;
  return clean.slice(0, Math.max(4, Math.min(7, clean.length - 2)));
}

export function factTokens(text) {
  const words = String(text || '')
    .toLowerCase()
    .replace(/[ё]/g, 'е')
    .split(/[^a-zа-я0-9]+/i)
    .filter(Boolean);
  const out = new Set();
  for (const word of words) {
    if (word.length < 3) continue;
    if (STOP_WORDS.has(word)) continue;
    out.add(stem(word));
  }
  return out;
}

/**
 * Отбор фактов под запрос: не «первые N», а те, что относятся к делу.
 * Совпадение основ слов даёт баллы, недавние факты получают небольшой плюс —
 * новое правило обычно важнее старого. Если тема не распознана, отдаём свежие.
 */
export function searchFacts(facts, query, { limit = MEMORY_LIMITS.maxPromptFacts } = {}) {
  const list = (Array.isArray(facts) ? facts : []).filter((fact) => fact && normalizeFact(fact.text));
  if (!list.length) return [];
  const asked = factTokens(query);
  if (!asked.size) return list.slice(-limit);

  const scored = list.map((fact, index) => {
    const own = factTokens(fact.text);
    let overlap = 0;
    for (const token of asked) if (own.has(token)) overlap += 1;
    if (!overlap) return { fact, score: 0, index };
    /* Совпадение редкого слова весомее общего: считаем по доле совпавших. */
    const score = overlap * 2 + overlap / Math.max(1, own.size) + (index / list.length) * 0.5;
    return { fact, score, index };
  });

  const relevant = scored.filter((item) => item.score > 0).sort((a, b) => b.score - a.score || b.index - a.index);
  const chosen = relevant.slice(0, limit).map((item) => ({ fact: item.fact, index: item.index }));
  /* Тему знаем, но фактов по ней мало — добираем свежими, чтобы правила
     оформления и названия не терялись при узком запросе. */
  if (chosen.length < Math.min(6, limit)) {
    for (let index = list.length - 1; index >= 0 && chosen.length < Math.min(6, limit); index--) {
      if (!chosen.some((item) => item.index === index)) chosen.push({ fact: list[index], index });
    }
  }
  chosen.sort((a, b) => a.index - b.index);
  return chosen.map((item) => item.fact);
}

/**
 * Текст памяти для системного сообщения.
 * Возвращает пустую строку, если запоминать пока нечего.
 */
export function memoryPromptText(facts, { query = '' } = {}) {
  const all = Array.isArray(facts) ? facts.filter((f) => f && normalizeFact(f.text)) : [];
  if (!all.length) return '';
  const selected = searchFacts(all, query);

  const lines = [];
  let used = 0;
  for (const fact of selected) {
    const line = `— ${normalizeFact(fact.text)}`;
    if (used + line.length + 1 > MEMORY_LIMITS.promptChars) break;
    lines.push(line);
    used += line.length + 1;
  }
  if (!lines.length) return '';

  const tail =
    all.length > lines.length
      ? `\n(в памяти ${all.length} фактов; показаны ${lines.length} — отобраны по теме текущего запроса и свежести. Полный список придёт в другом запросе.)`
      : '';

  return [
    'Что я уже знаю об этом пользователе (постоянная память, помни это и не переспрашивай):',
    ...lines,
    tail,
    'Правила работы с памятью:',
    '— Устойчивое предпочтение, правило, название, договорённость — записывай через remember одной короткой фразой.',
    '— Не запоминай содержимое текущей задачи, черновики и то, что уже есть в файлах проекта.',
    '— Если в памяти есть устаревшее, замени факт новым (remember с тем же смыслом), а не спорь с пользователем.',
  ]
    .filter(Boolean)
    .join('\n');
}

/** Что вернуть модели после remember: подтверждение или причина отказа. */
export function memoryToolReply({ added, replaced, reason, total }) {
  if (added) {
    return `Запомнил: «${added}»${replaced ? ' (прежняя версия заменена)' : ''}. Всего в памяти фактов: ${total}.`;
  }
  return `Не стал записывать${reason ? `: ${reason}` : ''}. Всего в памяти фактов: ${total}.`;
}
