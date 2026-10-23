/**
 * Кто прямо сейчас работает в сервисе.
 *
 * Пуш о готовой задаче нужен только тому, кто сервис свернул или закрыл.
 * Сервис-воркер и сам не показывает уведомление, когда окно на экране, но это
 * работает лишь на том устройстве, где окно открыто. Если человек работает на
 * ноутбуке, уведомление всё равно улетит на телефон — поэтому видимость вкладок
 * собираем на сервере: активность на любом устройстве отменяет пуш на все.
 *
 * Записи живут в памяти процесса. После перезапуска сервиса все считаются
 * ушедшими, и первое же открытие страницы снова отмечает присутствие. Это
 * безопасное состояние: лучше прислать лишнее уведомление, чем потерять пуш,
 * когда человек закрыл приложение.
 */

/** Сколько живёт отметка без нового сигнала от вкладки. */
export const PRESENCE_TTL_MS = 40 * 1000;

/** Потолок вкладок на пользователя: защита от бесконечных clientId. */
const MAX_TABS_PER_USER = 20;

/** key -> { userId, at } */
const entries = new Map();

function keyOf(userId, clientId) {
  return `${String(userId)}\n${String(clientId || '')}`;
}

function prune(now) {
  for (const [key, entry] of entries) {
    if (now - entry.at > PRESENCE_TTL_MS) entries.delete(key);
  }
}

/**
 * Вкладка сообщила, что она на экране (visible=true) или ушла в фон/закрылась
 * (visible=false). Ключ — идентификатор вкладки, а не устройства: две вкладки
 * на одном ноутбуке должны учитываться независимо. Закрытие одной не должно
 * делать «ушедшей» вторую, которая осталась на экране.
 */
export function touchPresence(userId, { clientId = '', visible = true, focused = false, now = Date.now() } = {}) {
  if (!userId) return;
  const key = keyOf(userId, clientId);
  if (!visible) {
    entries.delete(key);
    return;
  }
  prune(now);
  /* Вкладок не может быть бесконечно: старую отметку вытесняем, чтобы
     подделанные clientId не росли в памяти. */
  if (!entries.has(key)) {
    let count = 0;
    let oldestKey = '';
    let oldestAt = Infinity;
    for (const [otherKey, entry] of entries) {
      if (entry.userId !== String(userId)) continue;
      count += 1;
      if (entry.at < oldestAt) {
        oldestAt = entry.at;
        oldestKey = otherKey;
      }
    }
    if (count >= MAX_TABS_PER_USER && oldestKey) entries.delete(oldestKey);
  }
  entries.set(key, {
    userId: String(userId),
    focused: Boolean(focused),
    at: now,
  });
}

/**
 * Есть ли у пользователя хоть одна видимая вкладка с живой отметкой.
 * Фокус окна не обязателен: окно может быть на экране, но человек сейчас
 * смотрит в другое приложение — пуш ему всё равно не нужен.
 */
export function isUserActive(userId, now = Date.now()) {
  if (!userId) return false;
  prune(now);
  for (const entry of entries.values()) {
    if (entry.userId !== String(userId)) continue;
    if (now - entry.at <= PRESENCE_TTL_MS) return true;
  }
  return false;
}

/** Выход из аккаунта: присутствие этого пользователя больше не считается. */
export function clearPresence(userId) {
  if (!userId) return;
  const prefix = `${String(userId)}\n`;
  for (const key of entries.keys()) {
    if (key.startsWith(prefix)) entries.delete(key);
  }
}

/** Для тестов и диагностики: сколько живых отметок сейчас в памяти. */
export function presenceSize(now = Date.now()) {
  prune(now);
  return entries.size;
}
