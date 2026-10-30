/**
 * Тесты распределения шагов между двумя моделями (см. src/model.mjs,
 * chooseStepRoute). Модель не вызывается: проверяется только решение, кому
 * отдать следующий шаг, — это чистая функция от профиля хода и результата
 * предыдущего шага.
 *
 * Проверяется:
 * — первый шаг всегда идёт на профиле хода;
 * — ошибка инструмента поднимает следующий шаг на сильную модель;
 * — пришедшие данные (файл, страница, выгрузка) отдают разбор сильной модели;
 * — продолжение механики остаётся на профиле хода;
 * — откат сильной модели на быструю — только по явному DSHOW_SPLIT_GRIND=1;
 * — id сильной модели в настройках существует (deepseek-v4-pro, а не мифический
 *   deepseek-pro, из-за которого эскалация раньше тихо не работала);
 * — выключение распределения возвращает профиль хода.
 * Запуск: node test/model-split.mjs
 */
import assert from 'node:assert/strict';

import { ESCALATION, SPLIT } from '../src/config.mjs';
import { chooseStepRoute, describeStepRoute, isMechanicalTool } from '../src/model.mjs';
import { reviewModelName } from '../src/review.mjs';

const config = {
  enabled: true,
  threshold: 3,
  flashModel: 'flash-test',
  proModel: 'pro-test',
  flashEffort: 'high',
  proEffort: 'max',
};
const split = { enabled: true, dataChars: 2500, grind: false, grindAfter: 2 };

const flashBase = { profile: 'flash', model: 'flash-test', effort: 'high', score: 1, threshold: 3, reasons: ['короткий вопрос'] };
const proBase = { profile: 'pro', model: 'pro-test', effort: 'max', score: 7, threshold: 3, reasons: ['аудит'] };

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('первый шаг идёт на профиле хода', () => {
  const route = chooseStepRoute({ route: flashBase, step: 1, previous: null, config, split });
  assert.equal(route.model, 'flash-test');
  assert.equal(route.switched, false);
});

test('выключенное распределение оставляет профиль хода', () => {
  const route = chooseStepRoute({
    route: flashBase,
    step: 4,
    previous: { tools: ['read_file'], chars: 40000, failed: false, mechanicalRun: 1 },
    config,
    split: { ...split, enabled: false },
  });
  assert.equal(route.model, 'flash-test');
  assert.equal(route.switched, false);
  assert.match(route.why, /выключено/);
});

test('без сильной модели работаем на быстрой', () => {
  const route = chooseStepRoute({
    route: proBase,
    step: 3,
    previous: { tools: ['read_file'], chars: 9000, failed: false, mechanicalRun: 1 },
    config: { ...config, proModel: '' },
    split,
  });
  assert.equal(route.model, 'flash-test');
  assert.equal(route.profile, 'flash');
});

test('ошибка инструмента поднимает следующий шаг на сильную модель', () => {
  const route = chooseStepRoute({
    route: flashBase,
    step: 2,
    previous: { tools: ['read_file'], chars: 100, failed: true, mechanicalRun: 1 },
    config,
    split,
  });
  assert.equal(route.model, 'pro-test');
  assert.equal(route.effort, 'max');
  assert.equal(route.switched, true);
  assert.match(route.why, /сорвался/);
});

test('много пришедших данных — разбирает сильная модель', () => {
  const route = chooseStepRoute({
    route: flashBase,
    step: 3,
    previous: { tools: ['read_file', 'find_in_files'], chars: 6400, failed: false, mechanicalRun: 2 },
    config,
    split,
  });
  assert.equal(route.model, 'pro-test');
  assert.match(route.why, /6\.4 тыс\. знаков/);
});

test('порог данных уважается: чуть меньше — остаёмся на профиле хода', () => {
  const route = chooseStepRoute({
    route: flashBase,
    step: 3,
    previous: { tools: ['read_file'], chars: 2400, failed: false, mechanicalRun: 1 },
    config,
    split,
  });
  assert.equal(route.model, 'flash-test');
  assert.equal(route.switched, false);
});

test('порог задаётся настройкой', () => {
  const route = chooseStepRoute({
    route: flashBase,
    step: 3,
    previous: { tools: ['read_file'], chars: 900, failed: false, mechanicalRun: 1 },
    config,
    split: { ...split, dataChars: 500 },
  });
  assert.equal(route.model, 'pro-test');
});

test('шаг с «умным» инструментом — следующий проверяет сильная модель', () => {
  const route = chooseStepRoute({
    route: flashBase,
    step: 4,
    previous: { tools: ['calculate'], chars: 40, failed: false, mechanicalRun: 0 },
    config,
    split,
  });
  assert.equal(route.model, 'pro-test');
  assert.match(route.why, /calculate/);
});

test('создание документа — тоже повод для сильной модели', () => {
  const route = chooseStepRoute({
    route: flashBase,
    step: 5,
    previous: { tools: ['create_excel'], chars: 200, failed: false, mechanicalRun: 0 },
    config,
    split,
  });
  assert.equal(route.model, 'pro-test');
});

test('сильный ход не отдаёт работу быстрой модели без явного разрешения', () => {
  const route = chooseStepRoute({
    route: proBase,
    step: 3,
    previous: { tools: ['read_file'], chars: 800, failed: false, mechanicalRun: 3 },
    config,
    split,
  });
  assert.equal(route.model, 'pro-test');
  assert.equal(route.switched, false);
  assert.match(route.why, /механика/);
});

test('с DSHOW_SPLIT_GRIND=1 повторная механика уходит на быструю', () => {
  const route = chooseStepRoute({
    route: proBase,
    step: 4,
    previous: { tools: ['read_file'], chars: 800, failed: false, mechanicalRun: 3 },
    config,
    split: { ...split, grind: true, grindAfter: 2 },
  });
  assert.equal(route.model, 'flash-test');
  assert.equal(route.effort, 'high');
  assert.equal(route.switched, true);
  assert.match(route.why, /перекладывание/);
});

test('первый механический шаг сильного хода остаётся сильным', () => {
  const route = chooseStepRoute({
    route: proBase,
    step: 3,
    previous: { tools: ['read_file'], chars: 800, failed: false, mechanicalRun: 1 },
    config,
    split: { ...split, grind: true, grindAfter: 2 },
  });
  assert.equal(route.model, 'pro-test');
});

test('большие данные возвращают сильную модель даже с включённым grind', () => {
  const route = chooseStepRoute({
    route: proBase,
    step: 4,
    previous: { tools: ['read_file'], chars: 12000, failed: false, mechanicalRun: 3 },
    config,
    split: { ...split, grind: true },
  });
  assert.equal(route.model, 'pro-test');
});

test('шаг без инструментов не переключает профиль', () => {
  const route = chooseStepRoute({
    route: flashBase,
    step: 6,
    previous: { tools: [], chars: 0, failed: false, mechanicalRun: 0 },
    config,
    split,
  });
  assert.equal(route.switched, false);
  assert.equal(route.model, 'flash-test');
});

test('множество механических инструментов размечено как ожидается', () => {
  for (const name of ['read_file', 'list_files', 'find_in_files', 'fetch_url', 'extract_archive', 'move_path']) {
    assert.equal(isMechanicalTool(name), true, `${name} должен быть механическим`);
  }
  for (const name of ['write_file', 'create_word', 'calculate', 'run_python', 'spawn_agent', 'web_search']) {
    assert.equal(isMechanicalTool(name), false, `${name} не механический`);
  }
  assert.equal(isMechanicalTool(''), false);
});

test('строка для лога говорит, что произошло', () => {
  const route = chooseStepRoute({
    route: flashBase,
    step: 2,
    previous: { tools: ['read_file'], chars: 100, failed: true, mechanicalRun: 1 },
    config,
    split,
  });
  const line = describeStepRoute(route);
  assert.match(line, /^шаг на pro: переключено/);
  assert.match(line, /сорвался/);
});

test('настройки: id сильной модели существует в шлюзе', () => {
  assert.equal(ESCALATION.proModel.includes('deepseek-pro'), false, 'deepseek-pro шлюз не знает');
  assert.equal(ESCALATION.proModel, process.env.DSHOW_MODEL_PRO || 'deepseek-v4-pro');
  assert.equal(ESCALATION.flashModel, process.env.DSHOW_MODEL || 'deepseek-flash');
});

test('настройки: распределение включено, откат на быструю — по умолчанию нет', () => {
  assert.equal(SPLIT.enabled, process.env.DSHOW_SPLIT !== '0');
  assert.equal(SPLIT.grind, process.env.DSHOW_SPLIT_GRIND === '1');
  assert.ok(SPLIT.dataChars >= 200);
});

test('ревью идёт на сильной модели, а без неё не запускается', () => {
  assert.equal(reviewModelName({ routeModel: 'flash-test', model: '', escalation: { enabled: true, proModel: 'pro-test' } }), 'pro-test');
  assert.equal(reviewModelName({ routeModel: 'flash-test', model: '', escalation: { enabled: true, proModel: '' } }), '');
});

test('веб-текст: своя страница не повод для сильной, корпус — повод', () => {
  const splitWeb = { ...split, webChars: 24000 };
  /* Одна страница на 9 тыс. знаков — материал для пересказа. */
  const page = chooseStepRoute({
    route: flashBase,
    step: 3,
    previous: { tools: ['fetch_url'], chars: 9000, failed: false, mechanicalRun: 1 },
    config,
    split: splitWeb,
  });
  assert.equal(page.model, 'flash-test');
  assert.match(page.why, /материал для пересказа/);

  /* Тот же объём из файла — это данные, их разбирает сильная. */
  const file = chooseStepRoute({
    route: flashBase,
    step: 3,
    previous: { tools: ['read_file'], chars: 9000, failed: false, mechanicalRun: 1 },
    config,
    split: splitWeb,
  });
  assert.equal(file.model, 'pro-test');

  /* Обход сайта принёс десятки тысяч знаков — это корпус, его берёт сильная. */
  const corpus = chooseStepRoute({
    route: flashBase,
    step: 4,
    previous: { tools: ['crawl'], chars: 30000, failed: false, mechanicalRun: 1 },
    config,
    split: splitWeb,
  });
  assert.equal(corpus.model, 'pro-test');
  assert.match(corpus.why, /корпус страниц/);
});

test('порог веб-текста задаётся настройкой', () => {
  const route = chooseStepRoute({
    route: flashBase,
    step: 3,
    previous: { tools: ['fetch_many'], chars: 6000, failed: false, mechanicalRun: 1 },
    config,
    split: { ...split, webChars: 5000 },
  });
  assert.equal(route.model, 'pro-test');
});

test('настройки: порог веб-текста выше общего и не меньше тысячи', () => {
  assert.ok(SPLIT.webChars >= 1000);
  assert.ok(SPLIT.webChars > SPLIT.dataChars);
});

let failed = 0;
for (const item of tests) {
  try {
    await item.fn();
    console.log(`ok   ${item.name}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL ${item.name}: ${error.message}`);
  }
}
console.log(failed ? `\n${failed} из ${tests.length} тестов не прошли` : `\nвсе ${tests.length} тестов прошли`);
process.exit(failed ? 1 : 0);
