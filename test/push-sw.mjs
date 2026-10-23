/**
 * Проверка сервис-воркера уведомлений без браузера: public/sw.js исполняется
 * в песочнице с заглушкой self, а мы вызываем его обработчики так же, как это
 * сделал бы браузер, и смотрим, что воркер показал и куда отправил клиента.
 *   node test/push-sw.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = fs.readFileSync(path.join(ROOT, 'public', 'sw.js'), 'utf8');

let failed = 0;
function check(label, ok, detail = '') {
  if (ok) {
    console.log(`  ok  ${label}`);
    return;
  }
  failed += 1;
  console.log(`  FAIL ${label}${detail ? `: ${detail}` : ''}`);
}

function loadWorker({ windows = [] } = {}) {
  const handlers = new Map();
  const shown = [];
  const posted = [];
  const opened = [];
  const badges = [];
  const focused = [];
  const windowClients = windows.map((item) => ({
    url: item.url || 'https://example.test/',
    focused: Boolean(item.focused),
    visibilityState: item.visible ? 'visible' : 'hidden',
    focus: async function focus() {
      focused.push(this.url);
      this.focused = true;
    },
    postMessage: (message) => posted.push(message),
  }));
  const self = {
    addEventListener: (type, handler) => {
      if (!handlers.has(type)) handlers.set(type, []);
      handlers.get(type).push(handler);
    },
    skipWaiting: () => {},
    clients: {
      matchAll: async () => windowClients,
      openWindow: async (url) => {
        opened.push(url);
      },
      claim: async () => {},
    },
    registration: {
      showNotification: async (title, options) => {
        shown.push({ title, options });
      },
    },
    navigator: {
      setAppBadge: async (count) => {
        badges.push(['set', count]);
      },
      clearAppBadge: async () => {
        badges.push(['clear']);
      },
    },
    location: { origin: 'https://example.test' },
  };
  const context = vm.createContext({ self, console, URL, setTimeout, Promise });
  vm.runInContext(SOURCE, context);
  return { handlers, shown, posted, opened, badges, focused, windowClients };
}

async function dispatch(worker, type, event) {
  let pending = null;
  event.waitUntil = (promise) => {
    pending = promise;
  };
  for (const handler of worker.handlers.get(type) || []) handler(event);
  await pending;
}

function pushEvent(payload) {
  return {
    data: {
      json: () => {
        if (payload === null) throw new Error('не json');
        return payload;
      },
      text: () => 'просто текст',
    },
  };
}

function clickEvent(data) {
  return {
    notification: {
      close: () => {},
      data,
    },
  };
}

/* 1. Воркер зарегистрировал все обработчики и не уронил установку. */
const base = loadWorker();
check('install и activate зарегистрированы', base.handlers.has('install') && base.handlers.has('activate'));
check('push зарегистрирован', base.handlers.has('push'));
check('notificationclick зарегистрирован', base.handlers.has('notificationclick'));

/* 2. Никто не смотрит — показываем системное уведомление и бейдж. */
await dispatch(base, 'push', pushEvent({
  title: 'Отчёт по рынку',
  body: 'Задача готова: таблица собрана.',
  url: '/?chat=abc',
  tag: 'chat-abc',
  chatId: 'abc',
  kind: 'done',
}));
const shown = base.shown[0];
check('уведомление показано', base.shown.length === 1);
check('заголовок и текст из сообщения', shown?.title === 'Отчёт по рынку' && shown?.options?.body === 'Задача готова: таблица собрана.');
check('ссылка и метка сохранены в data', shown?.options?.data?.url === '/?chat=abc' && shown?.options?.tag === 'chat-abc');
check('тег сообщения не смешивает уведомления', shown?.options?.tag === 'chat-abc');
check('бейдж выставлен', base.badges.some(([kind, count]) => kind === 'set' && count === 1));

/* 3. Приложение открыто на экране — системное уведомление не нужно. */
const visible = loadWorker({ windows: [{ visible: true, focused: true }] });
await dispatch(visible, 'push', pushEvent({ title: 'Ответ', body: 'Готово', chatId: 'chat-1', url: '/?chat=chat-1' }));
check('открытое приложение не получает системное уведомление', visible.shown.length === 0);
check('вкладке отправлено событие с диалогом', visible.posted[0]?.type === 'dsh-push' && visible.posted[0]?.payload?.chatId === 'chat-1');
check('бейдж не выставляется при открытом приложении', visible.badges.length === 0);

/* 3a. Проверка и объявление помечены onlyWhenAway: false — их показываем,
   даже когда приложение открыто, иначе кнопка «Проверить» выглядит сломанной. */
const announced = loadWorker({ windows: [{ visible: true, focused: true }] });
await dispatch(announced, 'push', pushEvent({
  title: 'DSH Open',
  body: 'Уведомления работают',
  kind: 'test',
  onlyWhenAway: false,
}));
check('проверка видна при открытом приложении', announced.shown.length === 1);
check('проверка не выставляет бейдж поверх открытого окна', announced.badges.length === 0);

/* 3b. Явный onlyWhenAway: true (новая сборка сервера) тоже молчит. */
const awayOnly = loadWorker({ windows: [{ visible: true }] });
await dispatch(awayOnly, 'push', pushEvent({ title: 'Готово', onlyWhenAway: true }));
check('onlyWhenAway: true не показывает уведомление на экране', awayOnly.shown.length === 0);

/* 4. Битое сообщение не должно ломать показ уведомления. */
const broken = loadWorker();
await dispatch(broken, 'push', pushEvent(null));
check('без JSON показывается запасной текст', broken.shown.length === 1 && broken.shown[0].title === 'DSH Open' && Boolean(broken.shown[0].options.body));

/* 5. Клик по уведомлению при открытом приложении: фокус и открытие диалога. */
const click = loadWorker({ windows: [{ focused: false }] });
await dispatch(click, 'notificationclick', clickEvent({ url: '/?chat=xyz', chatId: 'xyz', tag: 'chat-xyz' }));
check('окно получило фокус', click.focused.length === 1);
check('в вкладку передан диалог', click.posted[0]?.type === 'dsh-open' && click.posted[0]?.chatId === 'xyz');
check('второе окно не открывалось', click.opened.length === 0);
check('бейдж снят кликом', click.badges.some(([kind]) => kind === 'clear'));

/* 6. Клик при закрытом приложении: открываем ссылку из уведомления. */
const cold = loadWorker();
await dispatch(cold, 'notificationclick', clickEvent({ url: '/?chat=only', chatId: 'only' }));
check('приложение открыто по ссылке', cold.opened.length === 1 && cold.opened[0] === '/?chat=only');

/* 7. Просьба страницы снять бейдж. */
const badge = loadWorker();
await dispatch(badge, 'message', { data: { type: 'dsh-clear-badge' } });
check('бейдж снимается по просьбе страницы', badge.badges.some(([kind]) => kind === 'clear'));

/* 8. Ссылка не может увести воркер на чужой сайт. */
const hostile = loadWorker();
await dispatch(hostile, 'push', pushEvent({ title: 'x', url: 'https://evil.test/', chatId: null }));
check('внешняя ссылка заменяется на главную', hostile.shown[0]?.options?.data?.url === '/');

console.log(failed ? `\n  провалено проверок: ${failed}` : '\n  сервис-воркер уведомлений в порядке');
process.exitCode = failed ? 1 : 0;
