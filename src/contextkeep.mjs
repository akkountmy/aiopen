/**
 * Контекст хранится всегда — и сжимается раз в месяц.
 *
 * Раньше в сервисе была одна дата, отменявшая работу человека: пометку о
 * перезапуске старше недели автопродолжение не поднимало. Работа лежала на
 * диске, но из-за срока пропадала. Срок годности убран полностью: переписка,
 * срезы `.history/` и незаконченные задачи остаются, сколько бы времени ни
 * прошло.
 *
 * Взамен работает сжатие по возрасту: раз в сутки фоновый тик находит диалоги,
 * которых не касались месяц и больше, и сворачивает только раздувшуюся историю
 * в конспект — старшие реплики уезжают файлом в `.history/` проекта, в памяти
 * диалога остаются последние реплики и сводка. Полный текст не теряется
 * (read_file читает его из папки проекта), транскрипт интерфейса не сжимается.
 *
 * Сжимаем без модели: экономия токенов не должна оплачиваться токенами.
 * Повторно работа не выполняется — после сжатия история уже не раздута, так что
 * диалог попадает под правило не чаще раза в месяц естественным образом.
 */
import { CONTEXT } from './config.mjs';
import { store } from './store.mjs';
import { compactStaleHistory, historyTokens } from './trim.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;

export const CONTEXT_KEEP = {
  /* Через сколько дней без обращений контекст «старый». */
  compactAfterDays: Math.max(1, Number(CONTEXT.retain?.compactAfterDays) || 30),
  /* До какого объёма сжимаем, токенов. Мельче — не трогаем: конспект короткого
     разговора дороже, чем отдать его как есть. */
  staleTokens: Math.max(500, Number(CONTEXT.retain?.staleTokens) || 8000),
  /* Сколько последних сообщений остаётся в контексте после сжатия. */
  keepRecent: Math.max(2, Number(CONTEXT.retain?.keepRecent) || 12),
  /* Потолок памяти диалога — тот же, что у автосжатия. */
  memoryChars: Math.max(400, Number(CONTEXT.retain?.memoryChars) || 2200),
  /* Как часто смотрим: срок измеряется месяцами, суточного тика достаточно. */
  intervalMs: DAY_MS,
  /* Первый проход — чуть позже старта, чтобы не мешать подниматься службам. */
  initialDelayMs: 90 * 1000,
};

const COMPACT_AGE_MS = CONTEXT_KEEP.compactAfterDays * DAY_MS;

/** Возраст контекста в миллисекундах: по отметке задачи или последней записи. */
export function contextAgeMs(chat, since = 0) {
  const at = Number(since) || Date.parse(chat?.updatedAt || chat?.createdAt || '') || 0;
  return at ? Math.max(0, Date.now() - at) : 0;
}

/**
 * Сжимает давний контекст одного диалога, если он и правда старый и раздутый.
 * Возвращает результат `compactStaleHistory` или null, если сжимать нечего.
 */
export function squeezeStaleContext(chat, project, since, tag = 'resume') {
  const age = contextAgeMs(chat, since);
  if (!age || age < COMPACT_AGE_MS) return null;
  if (historyTokens(chat?.history) <= CONTEXT_KEEP.staleTokens) return null;
  try {
    const result = compactStaleHistory({
      chat,
      workspace: store.workspaceDir(project.id),
      budget: CONTEXT_KEEP.staleTokens,
      keepRecent: CONTEXT_KEEP.keepRecent,
      memoryChars: CONTEXT_KEEP.memoryChars,
      config: CONTEXT.trim,
    });
    if (!result.compacted) return null;
    store.saveChat(chat.id, {
      messages: chat.messages,
      history: chat.history,
      memory: chat.memory,
      task: chat.task || null,
      queue: Array.isArray(chat.queue) ? chat.queue : [],
    });
    console.log(
      `[${tag}] диалог ${chat.id}: старый контекст сжат ${result.before} → ${result.after} токенов, ` +
        `срезано сообщений ${result.removed}${result.spill ? `, полный текст ${result.spill}` : ''}`,
    );
    return result;
  } catch (error) {
    console.error(`[${tag}] сжатие старого контекста не удалось:`, error?.message || error);
    return null;
  }
}

/**
 * Проход по всем диалогам: сжимает те, которых не касались месяц и больше, и
 * только если история раздулась. Задачи, которые идут прямо сейчас, не трогаем.
 */
export function sweepStaleContexts(reason = 'сутки') {
  let compacted = 0;
  let savedTokens = 0;
  for (const meta of [...store.state.chats]) {
    if (!meta || meta.running || meta.deletedAt) continue;
    const user = store.getUser(meta.ownerId);
    if (!user) continue;
    if (contextAgeMs(meta) < COMPACT_AGE_MS) continue;
    try {
      const chat = store.getChat(meta.id, user.id);
      if (!chat) continue;
      const project = store.getProject(chat.projectId, user.id);
      if (!project) continue;
      const result = squeezeStaleContext(chat, project, 0, 'context');
      if (!result) continue;
      compacted += 1;
      savedTokens += Math.max(0, result.before - result.after);
    } catch (error) {
      console.error('[context]', meta.id, error?.message || error);
    }
  }
  if (compacted) {
    console.log(`[context] ${reason}: старый контекст сжат в ${compacted} диалогах, экономия ${savedTokens} токенов`);
  }
  return { compacted, savedTokens };
}

/**
 * Фоновый тик: первый проход чуть позже старта и дальше раз в сутки. Таймеры
 * unref, поэтому остановке сервиса они не мешают. Возвращает функцию отмены.
 */
export function startContextCompactor({
  intervalMs = CONTEXT_KEEP.intervalMs,
  initialDelayMs = CONTEXT_KEEP.initialDelayMs,
} = {}) {
  const first = setTimeout(() => sweepStaleContexts('старт'), initialDelayMs);
  first.unref?.();
  const timer = setInterval(() => sweepStaleContexts('сутки'), intervalMs);
  timer.unref?.();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
