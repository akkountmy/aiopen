/* Сервис-воркер нужен ради двух вещей: ярлык на домашнем экране ставится как
   приложение (без воркера Chrome делает обычную закладку с адресной строкой) и
   push-уведомления показываются, даже когда приложение закрыто.
   Кэша нет намеренно: любая страница и статика всегда идут в сеть, поэтому
   обновления подхватываются сразу и устаревших файлов не бывает. */
self.addEventListener('install', () => {
  self.skipWaiting();
});
self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});
/* Пустой обработчик = запросы проходят напрямую в сеть, как без воркера. */
self.addEventListener('fetch', () => {});

/* ------------------------- уведомления ------------------------- */

const APP_ICON = '/icons/icon-192.png';

/* Бейдж с цифрой на иконке приложения. Поддерживается Chrome/Edge и Safari
   (iOS 16.4+); где API нет — просто молча пропускаем. */
function setBadge(count) {
  const api = self.navigator || {};
  const method = count > 0 ? api.setAppBadge : api.clearAppBadge;
  if (typeof method !== 'function') return Promise.resolve();
  return Promise.resolve(method.call(self.navigator, count > 0 ? count : undefined)).catch(() => {});
}

async function appWindows() {
  try {
    return await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  } catch {
    return [];
  }
}

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : '' };
  }
  const title = String(data.title || 'DSH Open');
  const url = typeof data.url === 'string' && data.url.startsWith('/') ? data.url : '/';
  const tag = String(data.tag || 'dsh');
  /* Старые сборки не присылают флаг: для них сохраняем прежнее правило —
     не показывать уведомление при открытом окне. Явный onlyWhenAway: false
     ставят проверка и объявления: их человек должен увидеть, даже когда
     приложение открыто. */
  const onlyWhenAway = data.onlyWhenAway !== false;
  event.waitUntil(
    (async () => {
      /* Приложение прямо сейчас на экране: ответ человек видит в диалоге,
         системное уведомление только отвлекло бы. Вкладка получает событие и
         может сама обновить счётчик. */
      const windows = await appWindows();
      const visible = windows.find((client) => client.focused || client.visibilityState === 'visible');
      if (visible) {
        try {
          visible.postMessage({ type: 'dsh-push', payload: { ...data, url, tag } });
        } catch {
          /* вкладка могла закрыться между проверкой и отправкой */
        }
        if (onlyWhenAway) return;
      }
      if (!visible) await setBadge(1);
      await self.registration.showNotification(title, {
        body: String(data.body || 'Есть новое сообщение в DSH Open'),
        icon: APP_ICON,
        badge: APP_ICON,
        tag,
        renotify: true,
        data: { url, tag, chatId: data.chatId || null, kind: data.kind || '' },
      });
    })(),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const url = typeof data.url === 'string' && data.url.startsWith('/') ? data.url : '/';
  event.waitUntil(
    (async () => {
      await setBadge(0);
      const windows = await appWindows();
      for (const client of windows) {
        try {
          if (new URL(client.url).origin !== self.location.origin) continue;
          await client.focus();
          client.postMessage({ type: 'dsh-open', url, chatId: data.chatId || null });
          return;
        } catch {
          /* неподходящее окно — пробуем следующее */
        }
      }
      await self.clients.openWindow(url);
    })(),
  );
});

/* Страница просит снять бейдж, когда человек вернулся в приложение. */
self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'dsh-clear-badge') setBadge(0);
});
