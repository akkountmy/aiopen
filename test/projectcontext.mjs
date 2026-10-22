/**
 * Тесты контекста проекта: новый диалог в том же проекте должен знать, о чём
 * говорили в прошлых. Запуск: node test/projectcontext.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-projectcontext-'));
process.env.DSH_DATA_DIR = tmpRoot;

const { buildProjectContext } = await import('../src/projectcontext.mjs');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

function chat(overrides = {}) {
  return {
    id: 'c1',
    title: 'Диалог',
    updatedAt: '2026-10-20T10:00:00.000Z',
    messages: [
      { role: 'user', content: 'Сделай лендинг для кофейни' },
      { role: 'assistant', content: 'Готов лендинг: файл landing.html, стиль тёплый, шрифт Inter.' },
    ],
    ...overrides,
  };
}

test('прошлые диалоги попадают в контекст, текущий — нет', () => {
  const data = {
    c1: chat(),
    c2: chat({
      id: 'c2',
      title: 'Кофейня: тексты',
      updatedAt: '2026-10-21T10:00:00.000Z',
      messages: [
        { role: 'user', content: 'Напиши тексты на главную' },
        { role: 'assistant', content: 'Написал тексты: заголовок «Кофе с характером», 4 блока преимуществ.' },
      ],
    }),
    current: chat({ id: 'current', title: 'Новый диалог', messages: [{ role: 'user', content: 'Добавь блок отзывов' }] }),
  };
  const text = buildProjectContext({
    chats: Object.values(data).map(({ messages, ...meta }) => meta),
    currentChatId: 'current',
    load: (id) => data[id] || null,
    question: 'Добавь блок отзывов',
  });
  assert.match(text, /Прошлые диалоги этого проекта/);
  assert.match(text, /Кофе с характером/);
  assert.match(text, /landing\.html/);
  assert.ok(!text.includes('Новый диалог'), 'текущий диалог попал в свой же контекст');
});

test('пустые и остановленные диалоги не засоряют контекст', () => {
  const data = {
    empty: { id: 'empty', title: 'Пустой', messages: [] },
    stopped: { id: 'stopped', title: 'Стоп-диалог', messages: [{ role: 'user', content: 'Стоп' }, { role: 'assistant', content: '' }] },
    real: chat({ id: 'real' }),
  };
  const text = buildProjectContext({
    chats: [
      { id: 'empty', title: 'Пустой', updatedAt: '2026-10-22T10:00:00.000Z' },
      { id: 'stopped', title: 'Стоп-диалог', updatedAt: '2026-10-22T11:00:00.000Z' },
      { id: 'real', title: 'Лендинг', updatedAt: '2026-10-21T10:00:00.000Z' },
    ],
    currentChatId: 'current',
    load: (id) => data[id] || null,
  });
  assert.match(text, /landing\.html/);
  assert.ok(!text.includes('Стоп-диалог'), 'остановленный диалог попал в контекст');
});

test('диалоги по теме вопроса идут первыми', () => {
  const data = {
    web: { id: 'web', title: 'Лендинг кофейни', messages: [{ role: 'assistant', content: 'Сверстал страницу лендинга кофейни.' }] },
    tax: { id: 'tax', title: 'Налоги за квартал', messages: [{ role: 'assistant', content: 'Подготовил расчёт налогов за квартал.' }] },
  };
  const chats = [
    { id: 'tax', title: 'Налоги за квартал', updatedAt: '2026-10-22T10:00:00.000Z' },
    { id: 'web', title: 'Лендинг кофейни', updatedAt: '2026-10-21T10:00:00.000Z' },
  ];
  const text = buildProjectContext({ chats, currentChatId: 'c', load: (id) => data[id], question: 'Доработай лендинг' });
  assert.ok(text.indexOf('Лендинг кофейни') < text.indexOf('Налоги за квартал'), 'близкий по теме диалог не поднялся наверх');
});

test('бюджет контекста соблюдается', () => {
  const data = {};
  const chats = [];
  for (let index = 0; index < 12; index++) {
    const id = `c${index}`;
    data[id] = { id, title: `Диалог ${index}`, messages: [{ role: 'assistant', content: `Длинный итог ${'подробности '.repeat(200)}` }] };
    chats.push({ id, title: `Диалог ${index}`, updatedAt: `2026-10-${String(index + 1).padStart(2, '0')}T10:00:00.000Z` });
  }
  const text = buildProjectContext({ chats, currentChatId: 'current', load: (id) => data[id], maxChars: 800, maxChats: 10 });
  assert.ok(text.length <= 800 + 300, `контекст проекта слишком длинный: ${text.length}`);
  assert.ok(!text.includes('<!--'));
});

test('битый диалог не ломает сборку контекста', () => {
  const text = buildProjectContext({
    chats: [{ id: 'broken', title: 'Битый' }],
    currentChatId: 'current',
    load: () => {
      throw new Error('файл пропал');
    },
  });
  assert.equal(text, '');
});

let failed = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL ${name}\n     ${error.message}`);
  }
}
console.log(`\n${tests.length - failed}/${tests.length} тестов прошло`);
if (failed) process.exit(1);
