/**
 * Разметка вызовов инструментов в истории разговора.
 *
 * Провайдер модели проверяет историю строго: у каждого сообщения с ролью
 * `tool` должен быть ровно один предшествующий `assistant` с `tool_calls`,
 * где этот `tool_call_id` объявлен, и на каждый объявленный вызов должен быть
 * ровно один ответ. Нарушение — не наша ошибка в логике шага, а отказ запроса
 * с 400: «Messages with role 'tool' must be a response to a preceding message
 * with 'tool_calls'». Повторить сообщение бесполезно — история уже испорчена
 * на диске, и каждый следующий ход падает так же.
 *
 * Испортить её может что угодно, что пишет в файл диалога: старый срез
 * истории, оборванный на середине шага ход, повтор запроса моделью, ручная
 * правка. Поэтому здесь одна дешёвая проверка, которая приводит историю к
 * заведомо допустимому виду и ничего не теряет по смыслу:
 *
 * — ответ инструмента без своего вызова убирается (он ни на что не отвечает);
 * — повторный ответ на тот же вызов убирается (вызов отвечен один раз);
 * — незакрытый вызов закрывается честной пометкой: результат неизвестен;
 * — пустой список `tool_calls` убирается, чтобы не объявлять несуществующие
 *   вызовы.
 *
 * Функция чистая: исходный массив не меняется, неизменённые сообщения
 * возвращаются теми же объектами (важно для закреплённой задачи, которую
 * узнают по ссылке).
 */

/** Что подставляем вместо потерянного результата инструмента. */
export const LOST_TOOL_RESULT =
  'Вызов инструмента не завершился: результат неизвестен. Проверь, что уже сделано ' +
  'в рабочей папке и в истории, и при необходимости повтори вызов.';

/** Роли, которые провайдер модели принимает в переписке. */
const ROLES = new Set(['system', 'user', 'assistant', 'tool']);

/**
 * Приводит историю к допустимому виду.
 * @param {Array} history сообщения диалога
 * @param {{placeholder?: string}} [options]
 * @returns {{messages: Array, removed: number, filled: number, changed: boolean}}
 *   removed — сколько сообщений убрано (осиротевшие и повторные ответы),
 *   filled — сколько ответов дописано вместо потерянных.
 */
export function normalizeHistory(history, { placeholder = LOST_TOOL_RESULT } = {}) {
  const source = Array.isArray(history) ? history : [];
  const messages = [];
  let removed = 0;
  let filled = 0;
  /* Сколько сообщений пришлось переписать: в них были негодные объявления
     вызовов (пустые или с повтором идентификатора). */
  let rewritten = 0;
  /* Открытая группа вызовов: пока не встретилось сообщение другой роли, ответы
     инструментов принадлежат последнему assistant с tool_calls. */
  let open = null;

  const closeGroup = () => {
    if (!open) return;
    for (const id of open.order) {
      if (open.answered.has(id)) continue;
      messages.push({ role: 'tool', tool_call_id: id, content: placeholder });
      filled += 1;
    }
    open = null;
  };

  for (const item of source) {
    if (!item || typeof item !== 'object' || typeof item.role !== 'string') {
      removed += 1;
      continue;
    }
    if (!ROLES.has(item.role)) {
      removed += 1;
      continue;
    }
    if (item.role === 'tool') {
      const id = typeof item.tool_call_id === 'string' ? item.tool_call_id : '';
      if (!open || !id || !open.declared.has(id) || open.answered.has(id)) {
        removed += 1;
        continue;
      }
      open.answered.add(id);
      messages.push(item);
      continue;
    }

    closeGroup();

    if (item.role !== 'assistant') {
      messages.push(item);
      continue;
    }

    /* Объявления вызовов: только те, на которые вообще можно ответить. */
    if (!('tool_calls' in item)) {
      messages.push(item);
      continue;
    }
    const raw = Array.isArray(item.tool_calls) ? item.tool_calls : [];
    const calls = [];
    const seen = new Set();
    for (const call of raw) {
      const id = typeof call?.id === 'string' ? call.id : '';
      if (!id || seen.has(id)) continue;
      seen.add(id);
      calls.push(call);
    }
    if (!calls.length) {
      /* Пустой или негодный список объявлений: сообщение остаётся обычным
         ответом модели, иначе следующий `tool` стал бы осиротевшим. */
      const { tool_calls, ...rest } = item;
      messages.push(rest);
      rewritten += 1;
      continue;
    }
    if (calls.length !== raw.length) {
      const message = { ...item, tool_calls: calls };
      messages.push(message);
      rewritten += 1;
    } else {
      messages.push(item);
    }
    open = { declared: seen, answered: new Set(), order: calls.map((call) => call.id) };
  }

  closeGroup();

  return {
    messages,
    removed,
    filled,
    changed: removed > 0 || filled > 0 || rewritten > 0,
  };
}

/**
 * То же самое, но прямо в истории диалога: чинит файл, который уже испорчен.
 * Возвращает счётчики для журнала.
 * @param {Array} history
 * @param {{placeholder?: string}} [options]
 * @returns {{changed: boolean, removed: number, filled: number}}
 */
export function repairHistoryInPlace(history, options = {}) {
  const result = normalizeHistory(history, options);
  if (!result.changed) return { changed: false, removed: 0, filled: 0 };
  if (!Array.isArray(history)) return { changed: false, removed: 0, filled: 0 };
  history.length = 0;
  for (const message of result.messages) history.push(message);
  return { changed: true, removed: result.removed, filled: result.filled };
}
