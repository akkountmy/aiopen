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
  maxFacts: 40,
  maxFactChars: 400,
  /* Бюджет вставки в системное сообщение. Не даём памяти раздуть промпт. */
  promptChars: 3200,
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

/**
 * Текст памяти для системного сообщения.
 * Возвращает пустую строку, если запоминать пока нечего.
 */
export function memoryPromptText(facts) {
  const list = Array.isArray(facts) ? facts.filter((f) => f && normalizeFact(f.text)) : [];
  if (!list.length) return '';

  const lines = [];
  let used = 0;
  for (const fact of list) {
    const line = `— ${normalizeFact(fact.text)}`;
    if (used + line.length + 1 > MEMORY_LIMITS.promptChars) break;
    lines.push(line);
    used += line.length + 1;
  }
  if (!lines.length) return '';

  const tail =
    list.length > lines.length
      ? `\n(показаны не все: в памяти ${list.length} фактов, показано ${lines.length})`
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
