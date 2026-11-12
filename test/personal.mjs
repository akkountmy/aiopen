/* Проверка «Личного слоя» — границы полей, журнал отката, подписи действий.
   Тест чистый: ни сервера, ни файлов, ни сети — модуль предметный, поэтому
   проверяется напрямую импортом. Всё, что видит человек в окне создания своего
   блока или темы, проверяется здесь ровно теми же строками, которые он увидит.

   Что проверяем:
   — границы названия и текста задания (60 и 2000 знаков, крайние значения);
   — мусор в частоте, дне и часе чинится, а не роняет создание;
   — чужая иконка становится chart, чужой тон — gold;
   — подпись и описание укладываются в свои лимиты;
   — темы: обязательный запрос, дополнительные запросы без пустых и повторов;
   — журнал: свежее впереди, вытеснение по лимиту, откат по id;
   — подписи всех семи видов действий;
   — функция нормализации не бросает исключений на null, числе, строке, массиве.

   Запуск: node test/personal.mjs */
import assert from 'node:assert/strict';
import {
  PERSONAL_LIMITS,
  BLOCK_ICONS,
  TOPIC_TONES,
  customBlockId,
  normalizeBlockInput,
  normalizeTopicInput,
  pushUndo,
  undoById,
  lastUndo,
  undoLabel,
  publicTopic,
  normalizeUndoList,
} from '../src/personal.mjs';

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

/** Строка точной длины — для проверки границ без ручного счёта символов. */
const chars = (n, ch = 'а') => ch.repeat(n);

/* ── Границы и наборы ─────────────────────────────────────────────────────── */

test('границы личного слоя совпадают с договором', () => {
  assert.deepEqual(PERSONAL_LIMITS, {
    blocks: 6,
    topics: 3,
    undoKeep: 30,
    titleChars: 60,
    shortChars: 120,
    descriptionChars: 240,
    promptChars: 2000,
    topicTitleChars: 40,
    kickerChars: 60,
    queryChars: 120,
    extraQueryChars: 120,
    maxExtraQueries: 3,
  });
});

test('значки блока — только реальные иконки клиента, chart среди них', () => {
  assert.ok(BLOCK_ICONS.length >= 5 && BLOCK_ICONS.length <= 8, `значков: ${BLOCK_ICONS.length}`);
  assert.equal(new Set(BLOCK_ICONS).size, BLOCK_ICONS.length, 'значки не повторяются');
  assert.ok(BLOCK_ICONS.includes('chart'), 'запасной значок входит в набор');
  for (const icon of BLOCK_ICONS) assert.match(icon, /^[a-z]+$/, `похоже на ключ ICONS: ${icon}`);
});

test('тона тем совпадают с палитрой выпуска, gold среди них', () => {
  assert.deepEqual(TOPIC_TONES, ['gold', 'blue', 'green', 'violet', 'sky', 'rose']);
  assert.ok(TOPIC_TONES.includes('gold'), 'запасной тон входит в набор');
});

test('идентификатор своего блока — own_ и восемь hex', () => {
  for (let i = 0; i < 50; i += 1) assert.match(customBlockId(), /^own_[0-9a-f]{8}$/);
});

test('идентификаторы своих блоков не повторяются', () => {
  const seen = new Set();
  for (let i = 0; i < 200; i += 1) seen.add(customBlockId());
  assert.equal(seen.size, 200);
});

/* ── Свой блок: тексты ────────────────────────────────────────────────────── */

test('название и подпись обрезаются, внутренние пробелы схлопываются', () => {
  const result = normalizeBlockInput({ title: '  Отчёт   по\nскладу ', short: ' Склад ', prompt: 'Посчитай остатки.' });
  assert.equal(result.ok, true, result.errors.join('; '));
  assert.deepEqual(result.errors, []);
  assert.equal(result.value.title, 'Отчёт по складу');
  assert.equal(result.value.short, 'Склад');
});

test('переводы строк в тексте задания схлопываются, абзац остаётся', () => {
  const result = normalizeBlockInput({
    title: 'Склад',
    prompt: 'Первая строка.  \r\n\r\n\r\n\r\nВторая строка.\rТретья.',
  });
  assert.equal(result.ok, true, result.errors.join('; '));
  assert.equal(result.value.prompt, 'Первая строка.\n\nВторая строка.\nТретья.');
});

test('название ровно 60 знаков проходит, 61 — ошибка', () => {
  assert.equal(normalizeBlockInput({ title: chars(60), prompt: 'x' }).ok, true);
  const long = normalizeBlockInput({ title: chars(61), prompt: 'x' });
  assert.equal(long.ok, false);
  assert.match(long.errors[0], /60 знаков/);
  assert.equal(long.value, null);
});

test('пустое название — готовая фраза для человека', () => {
  const result = normalizeBlockInput({ title: '   ', prompt: 'x' });
  assert.equal(result.ok, false);
  assert.equal(result.errors[0], 'У блока должно быть название — до 60 знаков');
});

test('текст задания ровно 2000 знаков проходит, 2001 — ошибка', () => {
  assert.equal(normalizeBlockInput({ title: 'Склад', prompt: chars(2000) }).ok, true);
  const long = normalizeBlockInput({ title: 'Склад', prompt: chars(2001) });
  assert.equal(long.ok, false);
  assert.match(long.errors[0], /2000 знаков/);
});

test('пустой текст задания — готовая фраза для человека', () => {
  const result = normalizeBlockInput({ title: 'Склад', prompt: '\n\n  \n' });
  assert.equal(result.ok, false);
  assert.equal(result.errors[0], 'Расскажите, что должен сделать агент: до 2000 знаков');
});

test('обе ошибки приходят сразу, а не по одной', () => {
  const result = normalizeBlockInput({ title: '', prompt: '' });
  assert.equal(result.errors.length, 2);
});

test('подпись и описание блока укладываются в свои лимиты', () => {
  assert.equal(normalizeBlockInput({ title: 'С', prompt: 'x', short: chars(120), description: chars(240) }).ok, true);
  const bad = normalizeBlockInput({ title: 'С', prompt: 'x', short: chars(121), description: chars(241) });
  assert.equal(bad.ok, false);
  assert.equal(bad.errors.length, 2);
  assert.match(bad.errors[0], /120 знаков/);
  assert.match(bad.errors[1], /240 знаков/);
});

/* ── Свой блок: расписание и значки ──────────────────────────────────────── */

test('незнакомая частота становится monthly, без ошибки', () => {
  const result = normalizeBlockInput({ title: 'Склад', prompt: 'x', cadence: 'daily' });
  assert.equal(result.ok, true, result.errors.join('; '));
  assert.equal(result.value.cadence, 'monthly');
});

test('известная частота сохраняется', () => {
  for (const cadence of ['weekly', 'monthly', 'quarterly']) {
    assert.equal(normalizeBlockInput({ title: 'С', prompt: 'x', cadence }).value.cadence, cadence);
  }
});

test('день месяца и час поджимаются к границам, а не ломают создание', () => {
  const result = normalizeBlockInput({ title: 'С', prompt: 'x', dayOfMonth: 31, hour: 25, dayOfWeek: 8 });
  assert.equal(result.ok, true, result.errors.join('; '));
  assert.equal(result.value.dayOfMonth, 28);
  assert.equal(result.value.hour, 23);
  assert.equal(result.value.dayOfWeek, 7);
  const low = normalizeBlockInput({ title: 'С', prompt: 'x', dayOfMonth: 0, hour: -5, dayOfWeek: 0 });
  assert.equal(low.value.dayOfMonth, 1);
  assert.equal(low.value.hour, 0);
  assert.equal(low.value.dayOfWeek, 1);
});

test('пустой или нечисловой день и час дают значения по умолчанию', () => {
  const empty = normalizeBlockInput({ title: 'С', prompt: 'x', dayOfMonth: '', dayOfWeek: null, hour: '  ' });
  assert.equal(empty.value.dayOfMonth, 1);
  assert.equal(empty.value.dayOfWeek, 1);
  assert.equal(empty.value.hour, 9);
  const garbage = normalizeBlockInput({ title: 'С', prompt: 'x', dayOfMonth: 'вторник', hour: 'девять' });
  assert.equal(garbage.value.dayOfMonth, 1);
  assert.equal(garbage.value.hour, 9);
});

test('час из строки с числом принимается, дробь округляется', () => {
  assert.equal(normalizeBlockInput({ title: 'С', prompt: 'x', hour: '7' }).value.hour, 7);
  assert.equal(normalizeBlockInput({ title: 'С', prompt: 'x', hour: 7.6 }).value.hour, 8);
});

test('чужая иконка становится chart, своя из набора сохраняется', () => {
  assert.equal(normalizeBlockInput({ title: 'С', prompt: 'x', icon: 'gavel' }).value.icon, 'chart');
  assert.equal(normalizeBlockInput({ title: 'С', prompt: 'x', icon: 'склад' }).value.icon, 'chart');
  assert.equal(normalizeBlockInput({ title: 'С', prompt: 'x', icon: 'scale' }).value.icon, 'scale');
});

test('включённость: по умолчанию включено, явное false сохраняется', () => {
  assert.equal(normalizeBlockInput({ title: 'С', prompt: 'x' }).value.enabled, true);
  assert.equal(normalizeBlockInput({ title: 'С', prompt: 'x', enabled: false }).value.enabled, false);
});

/* ── Своя тема ───────────────────────────────────────────────────────────── */

test('тема: название 40 знаков проходит, 41 — ошибка', () => {
  assert.equal(normalizeTopicInput({ title: chars(40), query: 'логистика' }).ok, true);
  const long = normalizeTopicInput({ title: chars(41), query: 'логистика' });
  assert.equal(long.ok, false);
  assert.match(long.errors[0], /40 знаков/);
});

test('тема: пустой запрос — ошибка, границы 120 и 121', () => {
  assert.equal(normalizeTopicInput({ title: 'Логистика', query: '  ' }).ok, false);
  assert.equal(normalizeTopicInput({ title: 'Логистика', query: chars(120) }).ok, true);
  const long = normalizeTopicInput({ title: 'Логистика', query: chars(121) });
  assert.equal(long.ok, false);
  assert.match(long.errors[0], /120 знаков/);
});

test('тема: подзаголовок по умолчанию равен названию', () => {
  const result = normalizeTopicInput({ title: 'Логистика', query: 'логистика Беларусь' });
  assert.equal(result.ok, true, result.errors.join('; '));
  assert.equal(result.value.kicker, 'Логистика');
});

test('тема: длинный подзаголовок — ошибка, свой подзаголовок сохраняется', () => {
  assert.equal(normalizeTopicInput({ title: 'Логистика', query: 'x', kicker: chars(61) }).ok, false);
  const own = normalizeTopicInput({ title: 'Логистика', query: 'x', kicker: 'Перевозки' });
  assert.equal(own.value.kicker, 'Перевозки');
});

test('тема: пустые дополнительные запросы выбрасываются, повторы уходят', () => {
  const result = normalizeTopicInput({
    title: 'Логистика',
    query: 'логистика Беларусь',
    extraQueries: ['  ', 'тарифы', '', 'Тарифы', 'логистика беларусь', 'склады'],
  });
  assert.equal(result.ok, true, result.errors.join('; '));
  assert.deepEqual(result.value.extraQueries, ['тарифы', 'склады']);
});

test('тема: три дополнительных запроса проходят, четыре — ошибка', () => {
  assert.equal(normalizeTopicInput({ title: 'Л', query: 'x', extraQueries: ['а', 'б', 'в'] }).ok, true);
  const many = normalizeTopicInput({ title: 'Л', query: 'x', extraQueries: ['а', 'б', 'в', 'г'] });
  assert.equal(many.ok, false);
  assert.match(many.errors[0], /не больше 3/);
});

test('тема: слишком длинный дополнительный запрос — одна ошибка на все', () => {
  const result = normalizeTopicInput({ title: 'Л', query: 'x', extraQueries: [chars(121), chars(130)] });
  assert.equal(result.ok, false);
  assert.equal(result.errors.filter((text) => /Дополнительный запрос/.test(text)).length, 1);
});

test('тема: незнакомый тон становится gold, свой сохраняется', () => {
  assert.equal(normalizeTopicInput({ title: 'Л', query: 'x', tone: 'красный' }).value.tone, 'gold');
  assert.equal(normalizeTopicInput({ title: 'Л', query: 'x', tone: 'violet' }).value.tone, 'violet');
});

test('тема: мусор вместо списка дополнительных запросов не ломает проверку', () => {
  for (const extraQueries of [null, 42, 'тарифы', { a: 1 }]) {
    const result = normalizeTopicInput({ title: 'Л', query: 'x', extraQueries });
    assert.equal(result.ok, true, `${String(extraQueries)}: ${result.errors.join('; ')}`);
    assert.deepEqual(result.value.extraQueries, []);
  }
});

/* ── Мусор на входе ──────────────────────────────────────────────────────── */

test('не-объект вместо блока возвращает ok:false без исключения', () => {
  for (const garbage of [null, undefined, 42, 'строка', [], [1, 2], true]) {
    const result = normalizeBlockInput(garbage);
    assert.equal(result.ok, false, `принят мусор: ${JSON.stringify(garbage)}`);
    assert.equal(result.value, null);
    assert.equal(result.errors.length, 1);
  }
});

test('не-объект вместо темы возвращает ok:false без исключения', () => {
  for (const garbage of [null, undefined, 42, 'строка', [], [1, 2], true]) {
    const result = normalizeTopicInput(garbage);
    assert.equal(result.ok, false, `принят мусор: ${JSON.stringify(garbage)}`);
    assert.equal(result.value, null);
    assert.equal(result.errors.length, 1);
  }
});

test('объект с мусором в полях даёт честные ошибки, а не [object Object]', () => {
  const result = normalizeBlockInput({ title: { a: 1 }, prompt: [1, 2, 3], short: 42 });
  assert.equal(result.ok, false);
  assert.equal(result.errors.length, 2);
  assert.match(result.errors[0], /должно быть название/);
});

test('тема вместо публичной записи не отдаёт служебные поля', () => {
  const published = publicTopic({
    id: 't1',
    title: 'Логистика',
    kicker: 'Перевозки',
    query: 'логистика Беларусь',
    extraQueries: ['тарифы', 42],
    tone: 'blue',
    createdAt: '2026-01-01T00:00:00.000Z',
    ownerId: 'user-1',
    status: 'ready',
    items: [{ title: 'чужая новость' }],
  });
  assert.deepEqual(Object.keys(published), ['id', 'title', 'kicker', 'query', 'extraQueries', 'tone', 'createdAt']);
  assert.deepEqual(published.extraQueries, ['тарифы']);
  assert.equal(publicTopic(null), null);
  assert.equal(publicTopic('строка'), null);
});

/* ── Журнал отката ───────────────────────────────────────────────────────── */

test('свежая запись ложится впереди, исходный массив не меняется', () => {
  const original = [{ id: 'a', kind: 'own-create', data: { title: 'Старый' } }];
  const next = pushUndo(original, { id: 'b', kind: 'own-create', data: { title: 'Новый' } });
  assert.notEqual(next, original);
  assert.equal(original.length, 1, 'исходный журнал не тронут');
  assert.equal(next.length, 2);
  assert.equal(next[0].id, 'b');
});

test('журнал вытесняется по лимиту в 30 записей', () => {
  let journal = [];
  for (let i = 0; i < PERSONAL_LIMITS.undoKeep + 5; i += 1) {
    journal = pushUndo(journal, { id: `e${i}`, kind: 'own-create', data: { title: `Блок ${i}` } });
  }
  assert.equal(journal.length, PERSONAL_LIMITS.undoKeep);
  assert.equal(journal[0].id, `e${PERSONAL_LIMITS.undoKeep + 4}`, 'свежая запись наверху');
  assert.equal(journal.some((item) => item.id === 'e0'), false, 'самые старые вытеснены');
});

test('повтор с тем же id не удваивает запись', () => {
  let journal = pushUndo([], { id: 'x', kind: 'own-create', data: {} });
  journal = pushUndo(journal, { id: 'y', kind: 'own-create', data: {} });
  journal = pushUndo(journal, { id: 'x', kind: 'own-delete', data: {} });
  assert.equal(journal.length, 2);
  assert.equal(journal[0].id, 'x');
  assert.equal(journal[0].kind, 'own-delete');
});

test('запись без id и подписи добирает их сама', () => {
  const journal = pushUndo([], { kind: 'own-create', data: { title: 'Отчёт по складу' } });
  assert.match(journal[0].id, /^u_[0-9a-f]{8}$/);
  assert.equal(journal[0].label, 'Свой блок «Отчёт по складу» создан');
  assert.match(journal[0].at, /^\d{4}-\d{2}-\d{2}T/);
});

test('мусор вместо записи не ломает журнал', () => {
  const journal = pushUndo([{ id: 'a', kind: 'own-create', data: {} }], null);
  assert.equal(journal.length, 1);
  assert.equal(pushUndo('не массив', { id: 'b' }).length, 1);
});

test('откат по id отдаёт запись и остаток журнала', () => {
  let journal = [];
  for (const id of ['a', 'b', 'c']) journal = pushUndo(journal, { id, kind: 'own-create', data: {} });
  const picked = undoById(journal, 'b');
  assert.ok(picked);
  assert.equal(picked.entry.id, 'b');
  assert.equal(picked.rest.length, 2);
  assert.deepEqual(picked.rest.map((item) => item.id), ['c', 'a']);
  assert.equal(journal.length, 3, 'журнал не изменился');
});

test('откат по несуществующему id — null', () => {
  const journal = pushUndo([], { id: 'a', kind: 'own-create', data: {} });
  assert.equal(undoById(journal, 'нет-такого'), null);
  assert.equal(undoById(journal, ''), null);
  assert.equal(undoById(journal, null), null);
  assert.equal(undoById(null, 'a'), null);
  assert.equal(undoById('мусор', 'a'), null);
});

test('последнее действие — нулевая запись, на пустом журнале null', () => {
  let journal = pushUndo([], { id: 'a', kind: 'own-create', data: {} });
  journal = pushUndo(journal, { id: 'b', kind: 'own-create', data: {} });
  assert.equal(lastUndo(journal).id, 'b');
  assert.equal(lastUndo([]), null);
  assert.equal(lastUndo(null), null);
});

/* ── Подписи действий ────────────────────────────────────────────────────── */

test('подписи всех семи видов действий', () => {
  assert.equal(undoLabel('task-patch', { title: 'Налоги' }), 'Настройки задания «Налоги» изменены');
  assert.equal(undoLabel('task-delete', { title: 'Налоги' }), 'Задание «Налоги» убрано');
  assert.equal(undoLabel('task-restore-all', { taskIds: ['a'] }), 'Возвращены удалённые задания');
  assert.equal(undoLabel('own-create', { title: 'Отчёт по складу' }), 'Свой блок «Отчёт по складу» создан');
  assert.equal(undoLabel('own-delete', { task: { title: 'Отчёт по складу' } }), 'Свой блок «Отчёт по складу» удалён');
  assert.equal(undoLabel('topic-create', { title: 'Логистика' }), 'Своя тема «Логистика» создана');
  assert.equal(undoLabel('topic-delete', { topic: { title: 'Логистика' } }), 'Своя тема «Логистика» удалена');
});

test('подписи без названия и для незнакомого вида', () => {
  assert.equal(undoLabel('task-patch', {}), 'Настройки задания изменены');
  assert.equal(undoLabel('task-delete', null), 'Задание убрано');
  assert.equal(undoLabel('own-create', { taskId: 'own_1' }), 'Свой блок создан');
  assert.equal(undoLabel('topic-delete', undefined), 'Своя тема удалена');
  assert.equal(undoLabel('что-то новое', {}), 'Изменение в личном слое');
});

test('название из записи не раздувает подпись длиннее лимита', () => {
  const label = undoLabel('own-create', { title: chars(200) });
  assert.ok(label.length <= PERSONAL_LIMITS.titleChars + 40, `подпись: ${label.length} знаков`);
});

/* ── Журнал из состояния аккаунта ────────────────────────────────────────── */

test('журнал из состояния: мусор превращается в пустой журнал', () => {
  for (const garbage of [undefined, null, 42, 'записи', {}, true]) {
    assert.deepEqual(normalizeUndoList(garbage), [], `мусор: ${JSON.stringify(garbage)}`);
  }
});

test('журнал из состояния: чужие элементы отбрасываются, лимит держится', () => {
  assert.deepEqual(normalizeUndoList([null, 1, 'x', [], { id: 'a' }]).map((item) => item.id), ['a']);
  const many = Array.from({ length: PERSONAL_LIMITS.undoKeep + 10 }, (_, i) => ({ id: `e${i}` }));
  assert.equal(normalizeUndoList(many).length, PERSONAL_LIMITS.undoKeep);
});

/* ── Прогон ──────────────────────────────────────────────────────────────── */

let failed = 0;
for (const item of tests) {
  try {
    await item.fn();
    console.log(`ok   ${item.name}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL ${item.name}: ${error?.message || String(error)}`);
  }
}

console.log(`\n${tests.length - failed}/${tests.length} проверок личного слоя прошло`);
process.exit(failed ? 1 : 0);
