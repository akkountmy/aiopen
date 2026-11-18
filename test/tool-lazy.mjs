/**
 * Инструменты по требованию: каталог, подключение схем и экономия запроса.
 *
 * Проверяем не только «tool_search существует», а весь контракт:
 * — каталог перечисляет ровно скрытые инструменты и не рекламирует сам себя;
 * — начальный набор заметно легче полного, но содержит всё базовое;
 * — новые схемы дописываются в конец и не дублируются;
 * — русский запрос находит нужную группу, а точное имя — свою схему;
 * — executeTool возвращает имена для подключения на следующем шаге.
 *
 * Запуск: node test/tool-lazy.mjs
 */
import assert from 'node:assert/strict';

const { availableToolDefs, executeTool, TOOL_DEFS, TOOL_LABELS, toolSummary } = await import('../src/tools.mjs');
const {
  CORE_TOOL_NAMES,
  MAX_REVEAL,
  TOOL_SEARCH_NAME,
  activateToolDefs,
  buildLazyToolset,
  matchToolDefs,
} = await import('../src/toolrouter.mjs');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const all = await availableToolDefs();
const lazy = buildLazyToolset(all);
const hidden = all.filter((tool) => !lazy.coreNames.includes(tool.function.name));
const searchDef = all.find((tool) => tool.function.name === TOOL_SEARCH_NAME);

test('каталог перечисляет все скрытые инструменты и не рекламирует сам поиск', () => {
  assert.ok(searchDef, 'tool_search отсутствует в доступных схемах');
  const description = String(searchDef.function.description || '');
  for (const tool of hidden) {
    assert.ok(description.includes(tool.function.name), `в каталоге нет ${tool.function.name}`);
  }
  assert.ok(!description.includes(`${TOOL_SEARCH_NAME} —`), 'tool_search попал в собственный каталог');
  const names = all.map((tool) => tool.function.name);
  assert.equal(new Set(names).size, names.length, 'имена инструментов повторяются');
});

test('начальный набор легче полного и содержит базовые схемы', () => {
  const fullBytes = JSON.stringify(all).length;
  const lazyBytes = JSON.stringify(lazy.defs).length;
  assert.ok(lazyBytes < fullBytes * 0.3, `экономия слишком мала: ${lazyBytes} из ${fullBytes}`);
  assert.ok(lazy.defs.length < all.length, 'скрывать нечего — набор не уменьшился');
  for (const name of CORE_TOOL_NAMES) {
    assert.ok(lazy.defs.some((tool) => tool.function.name === name), `базовый ${name} не попал в запрос`);
  }
  for (const name of ['create_word', 'create_excel', 'legal_task', 'tg_feed']) {
    assert.ok(!lazy.defs.some((tool) => tool.function.name === name), `${name} зря едет в каждом запросе`);
    assert.ok(hidden.some((tool) => tool.function.name === name), `${name} потерялся между наборами`);
  }
});

test('подключение дописывает схемы в конец и не дублирует их', () => {
  const before = lazy.defs.map((tool) => tool.function.name);
  const first = activateToolDefs(lazy.defs, lazy.universe, ['create_word', 'create_word', 'нет_такого']);
  assert.deepEqual(first.added, ['create_word']);
  assert.deepEqual(first.defs.slice(0, before.length).map((tool) => tool.function.name), before);
  assert.equal(first.defs.at(-1).function.name, 'create_word');
  const second = activateToolDefs(first.defs, lazy.universe, ['create_word']);
  assert.deepEqual(second.added, []);
  assert.equal(second.defs.length, first.defs.length);
});

test('русский запрос и точное имя находят нужную группу', () => {
  const find = (query, limit = 4) => matchToolDefs(hidden, query, { labels: TOOL_LABELS, limit })
    .map((tool) => tool.function.name);
  assert.equal(find('Excel с диаграммой')[0], 'create_excel');
  assert.equal(find('сделай презентацию')[0], 'create_pptx');
  assert.equal(find('озвучить книгу')[0], 'narrate_document');
  assert.equal(find('разобрать телеграм-канал')[0], 'tg_channels');
  assert.equal(find('скоринг заявок')[0], 'score_credit');
  assert.equal(find('legal_task')[0], 'legal_task');
  assert.ok(find('сделай лендинг').some((name) => name === 'page_template'), 'сборка страницы не нашлась');
  assert.equal(find('спарси лендинг')[0], 'scrape_page');
});

test('tool_search возвращает имена для следующего шага, а не сами схемы', async () => {
  const byName = await executeTool(TOOL_SEARCH_NAME, { names: ['create_word'] }, {});
  assert.deepEqual(byName.meta.reveal, ['create_word']);
  assert.match(byName.text, /create_word/);
  assert.ok(byName.text.length < 400, 'ответ поиска раздулся: схемы должны ехать в tools, а не в текст');

  const byQuery = await executeTool(TOOL_SEARCH_NAME, { query: 'Excel', limit: 2 }, {});
  assert.equal(byQuery.meta.reveal[0], 'create_excel');
  assert.ok(byQuery.meta.reveal.length <= 2);

  const many = await executeTool(TOOL_SEARCH_NAME, {
    names: hidden.slice(0, MAX_REVEAL + 4).map((tool) => tool.function.name),
  }, {});
  assert.ok(many.meta.reveal.length <= MAX_REVEAL, 'names обошли предел подключения');

  const coreOnly = await executeTool(TOOL_SEARCH_NAME, { names: ['read_file'] }, {});
  assert.deepEqual(coreOnly.meta.reveal, []);
  assert.match(coreOnly.text, /уже доступн/i);

  const empty = await executeTool(TOOL_SEARCH_NAME, {}, {});
  assert.equal(empty.meta.found, 0);
  assert.match(empty.text, /каталоге/i);
});

test('у поиска есть метка и человеческая строка вызова', () => {
  assert.ok(TOOL_DEFS.some((tool) => tool.function.name === TOOL_SEARCH_NAME));
  assert.equal(TOOL_LABELS[TOOL_SEARCH_NAME], 'Подбор инструментов');
  assert.equal(toolSummary(TOOL_SEARCH_NAME, { query: 'Excel' }), 'Excel');
  assert.equal(toolSummary(TOOL_SEARCH_NAME, { names: ['create_word'] }), 'create_word');
  assert.ok(MAX_REVEAL >= 4 && MAX_REVEAL <= 10, 'предел подключения вышел из разумного');
});

let failed = 0;
for (const item of tests) {
  try {
    await item.fn();
    console.log(`ok   ${item.name}`);
  } catch (error) {
    failed++;
    console.log(`FAIL ${item.name}: ${error?.message || error}`);
  }
}
console.log(`\n${tests.length - failed}/${tests.length} тестов прошло`);
process.exit(failed ? 1 : 0);
