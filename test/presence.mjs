/**
 * Проверка серверного учёта присутствия: он решает, не беспокоить ли человека
 * пушем, пока он работает в сервисе на любом устройстве.
 *   node test/presence.mjs
 */
import { PRESENCE_TTL_MS, clearPresence, isUserActive, presenceSize, touchPresence } from '../src/presence.mjs';

let failed = 0;
function check(label, ok, detail = '') {
  if (ok) {
    console.log(`  ok  ${label}`);
    return;
  }
  failed += 1;
  console.log(`  FAIL ${label}${detail ? `: ${detail}` : ''}`);
}

const t0 = Date.now();

/* 1. Одна видимая вкладка делает человека активным. */
touchPresence('u1', { clientId: 'tab-a', visible: true, focused: true, now: t0 });
check('видимая вкладка — активен', isUserActive('u1', t0));
check('чужой пользователь не активен', !isUserActive('u2', t0));

/* 2. Свернули вкладку — сразу не активен, не дожидаясь TTL. */
touchPresence('u1', { clientId: 'tab-a', visible: false, now: t0 + 1000 });
check('свёрнутая вкладка снимает присутствие', !isUserActive('u1', t0 + 1000));

/* 3. Две вкладки: закрытие одной не делает ушедшей вторую. */
touchPresence('u1', { clientId: 'tab-a', visible: true, now: t0 + 2000 });
touchPresence('u1', { clientId: 'tab-b', visible: true, now: t0 + 2000 });
touchPresence('u1', { clientId: 'tab-a', visible: false, now: t0 + 3000 });
check('вторая вкладка удерживает присутствие', isUserActive('u1', t0 + 3000));
touchPresence('u1', { clientId: 'tab-b', visible: false, now: t0 + 4000 });
check('после закрытия всех вкладок — не активен', !isUserActive('u1', t0 + 4000));

/* 4. Пропавший сигнал (спящий телефон, убитый браузер) устаревает сам. */
touchPresence('u1', { clientId: 'tab-c', visible: true, now: t0 + 5000 });
check('свежая отметка активна', isUserActive('u1', t0 + 5000 + PRESENCE_TTL_MS - 1));
check('просроченная отметка не активна', !isUserActive('u1', t0 + 5000 + PRESENCE_TTL_MS + 1));

/* 5. Выход из аккаунта убирает все вкладки пользователя и только его. */
touchPresence('u1', { clientId: 'tab-d', visible: true, now: t0 + 60000 });
touchPresence('u2', { clientId: 'tab-e', visible: true, now: t0 + 60000 });
clearPresence('u1');
check('выход снимает присутствие пользователя', !isUserActive('u1', t0 + 60000));
check('выход не трогает чужое присутствие', isUserActive('u2', t0 + 60000));

/* 6. Пустые поля не создают мусорных записей. */
const before = presenceSize(t0 + 60000);
touchPresence('', { clientId: 'tab-f', visible: true, now: t0 + 60000 });
check('без пользователя запись не создаётся', presenceSize(t0 + 60000) === before);

console.log(failed ? `\n  провалено проверок: ${failed}` : '\n  учёт присутствия в порядке');
process.exitCode = failed ? 1 : 0;
