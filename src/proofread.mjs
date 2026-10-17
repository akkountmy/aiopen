import { simpleCompletion } from './agent.mjs';

const SYSTEM = [
  'Ты — корректор текста внутри рабочего сервиса.',
  'Исправь в тексте пользователя только орфографию, пунктуацию, опечатки и явные грамматические ошибки.',
  'Не меняй смысл, стиль, порядок мыслей, факты, числа, имена, ссылки, команды, код и разметку.',
  'Не сокращай и не дополняй текст. Сохрани переносы строк и списки.',
  'Верни только исправленный текст, без пояснений, без кавычек вокруг него и без вступлений.',
  'Если ошибок нет — верни текст без изменений.',
].join('\n');

/**
 * Возвращает исправленный текст. Бросает исключение, если модель недоступна.
 */
export async function proofreadText(text, { signal } = {}) {
  const source = String(text || '');
  if (!source.trim()) return { text: source, changed: false };
  const maxTokens = Math.min(8000, Math.max(600, Math.round(source.length / 1.6) + 200));
  const answer = await simpleCompletion(
    [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: source },
    ],
    { maxTokens, signal },
  );
  const cleaned = answer.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/, '').trim();
  if (!cleaned) return { text: source, changed: false };
  return { text: cleaned, changed: cleaned !== source.trim() };
}
