/**
 * План исполнения вызовов инструментов внутри одного шага модели.
 *
 * Модель часто просит несколько инструментов сразу: прочитать пять файлов,
 * скачать три страницы, сравнить два документа. Раньше эти вызовы шли строго
 * по одному, и шаг ждал сумму их времён, хотя между ними нет никакой связи.
 * Здесь вызовы делятся на батчи:
 *
 * — подряд идущие «чистые» (только читают, ничего не меняют и не пишут на
 *   диск) собираются в один параллельный батч;
 * — всё, что пишет на диск, запускает процесс, браузер, озвучку, субагента
 *   или меняет аккаунт человека, идёт отдельным батчем из одного вызова.
 *
 * Порядок батчей и порядок вызовов внутри батча сохраняются: сообщения
 * `tool` в истории обязаны идти ровно в том же порядке, что `tool_calls`
 * ассистента, иначе провайдер отвергнет запрос.
 */

/** Инструменты, которые только читают: их можно запускать одновременно. */
export const READ_ONLY_TOOLS = new Set([
  'list_files',
  'read_file',
  'find_in_files',
  'read_document',
  'compare_documents',
  'document_excerpt',
  'calculate',
  'use_skill',
  'tts_status',
  'web_search',
  'fetch_url',
  'fetch_many',
  'read_page',
  'crawl',
  'check_links',
  'check_document',
  'analyze_image',
  'tool_search',
]);

/** Запускать ли этот вызов вместе с соседними. */
export function isParallelSafe(name) {
  return READ_ONLY_TOOLS.has(String(name || '').trim());
}

/**
 * Разложить вызовы шага по батчам.
 * @returns {Array<{parallel: boolean, calls: Array}>}
 */
export function groupToolCalls(calls, { limit = 4, parallel = true, safe = isParallelSafe } = {}) {
  const list = Array.isArray(calls) ? calls : [];
  const max = Math.max(1, Number(limit) || 1);
  const batches = [];
  let open = null;
  for (const call of list) {
    const name = String(call?.function?.name || '');
    if (parallel && safe(name)) {
      if (!open || open.calls.length >= max) {
        open = { parallel: true, calls: [] };
        batches.push(open);
      }
      open.calls.push(call);
      continue;
    }
    open = null;
    batches.push({ parallel: false, calls: [call] });
  }
  return batches;
}

/** Сколько времени сэкономила параллельность: сумма времён минус самый долгий. */
export function savedByParallel(batches) {
  let saved = 0;
  for (const batch of Array.isArray(batches) ? batches : []) {
    if (!batch?.parallel || !Array.isArray(batch.calls) || batch.calls.length < 2) continue;
    const own = batch.calls.reduce((sum, call) => sum + (Number(call?.ms) || 0), 0);
    const wall = batch.calls.reduce((max, call) => Math.max(max, Number(call?.ms) || 0), 0);
    saved += Math.max(0, own - wall);
  }
  return saved;
}

/** Строка для журнала: «4 вызова за 1.2 с вместо 4.4 с». */
export function describeToolStep({ calls = 0, wallMs = 0, savedMs = 0 } = {}) {
  if (!calls) return '';
  const seconds = (ms) => `${(Math.round(Number(ms) || 0) / 1000).toFixed(1)} с`;
  if (savedMs > 0) {
    return `${calls} вызовов за ${seconds(wallMs)} вместо ${seconds(wallMs + savedMs)} (параллельно, экономия ${seconds(savedMs)})`;
  }
  return `${calls} вызовов за ${seconds(wallMs)}`;
}
