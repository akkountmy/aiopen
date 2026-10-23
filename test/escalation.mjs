/**
 * Тесты эскалации модели, финального ревью, состояния длинной задачи и
 * памяти из 100 фактов — без настоящей модели: локальный сервер отвечает
 * как OpenAI-совместимый API и записывает, что именно у него попросили.
 *
 * Проверяется:
 * — выбор профиля по сложности (аудит/финмодель → pro, короткий вопрос → flash);
 * — откат на рабочую модель, если сильной нет в доступе;
 * — детерминированные проверки ответа (выдуманные цифры, обещанные файлы);
 * — одна правка ответа по замечаниям и отказ от правки при новых выдумках;
 * — карточка задачи в сообщении о продолжении и в системной подсказке;
 * — отбор фактов памяти по теме, а не «первые N».
 * Запуск: node test/escalation.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-escalation-'));
const workspace = path.join(tmpRoot, 'project');
fs.mkdirSync(workspace, { recursive: true });

const SUBAGENT_MARK = 'Ты субагент внутри большой задачи';
const REVIEW_MARK = 'придирчивый проверяющий';
const FIX_MARK = 'правишь готовый ответ';

const requests = [];
let behavior = () => ({ kind: 'text', text: 'ок' });
let proMissing = false;

function sendEvent(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function streamText(res, text, usage) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  sendEvent(res, { choices: [{ index: 0, delta: { content: text }, finish_reason: null }] });
  sendEvent(res, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage });
  res.write('data: [DONE]\n\n');
  res.end();
}

function streamTool(res, name, args, usage) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  sendEvent(res, {
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [
            { index: 0, id: `call_${requests.length}`, type: 'function', function: { name, arguments: JSON.stringify(args) } },
          ],
        },
        finish_reason: null,
      },
    ],
  });
  sendEvent(res, { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage });
  res.write('data: [DONE]\n\n');
  res.end();
}

const server = http.createServer((req, res) => {
  if (!req.url.startsWith('/chat/completions')) {
    res.writeHead(404).end('nope');
    return;
  }
  let raw = '';
  req.on('data', (chunk) => {
    raw += chunk;
  });
  req.on('end', async () => {
    const body = JSON.parse(raw || '{}');
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const system = String(messages[0]?.content || '');
    const isSubagent = messages.some(
      (message) => typeof message.content === 'string' && message.content.includes(SUBAGENT_MARK),
    );
    const isReview = system.includes(REVIEW_MARK);
    const isFix = system.includes(FIX_MARK);
    const tools = (body.tools || []).map((tool) => tool.function.name);
    requests.push({
      model: body.model,
      effort: body.reasoning_effort,
      stream: body.stream !== false,
      isSubagent,
      isReview,
      isFix,
      tools,
      system,
      messages,
    });

    /* Сильной модели нет в доступе — как будто провайдер её не знает. */
    if (proMissing && body.model === 'pro-test') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'model not found: pro-test' } }));
      return;
    }

    const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
    if (body.stream === false) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      /* Проверяющий и правка идут без стрима — отвечаем по роли. */
      let content = 'Сводка: работали с документами и цифрами.';
      if (isReview) {
        content = JSON.stringify({
          verdict: 'fix',
          issues: [{ kind: 'figure', severity: 'high', quote: '7 654 321', hint: 'числа нет в результатах инструментов' }],
        });
      } else if (isFix) {
        content =
          'Готово: итоговая сумма 250 000 руб. совпадает с расчётом по данным проекта, других цифр в ответе нет.';
      }
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }], usage }));
      return;
    }

    const plan = behavior({ isSubagent, tools, messages, system });
    if (plan.delay) await new Promise((resolve) => setTimeout(resolve, plan.delay));
    if (plan.kind === 'tool') streamTool(res, plan.name, plan.args || {}, usage);
    else streamText(res, plan.text || '', usage);
  });
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
process.env.DSH_DATA_DIR = tmpRoot;
process.env.DSHOW_DEEPSEEK_KEY = 'test-key';
process.env.DSHOW_MODEL_BASE = `http://127.0.0.1:${port}`;
process.env.DSHOW_MODEL = 'flash-test';
process.env.DSHOW_MODEL_PRO = 'pro-test';
/* Мелкие отрезки — чтобы проверить карточку задачи без 40 шагов. */
process.env.DSHOW_MAX_STEPS = '2';
process.env.DSHOW_MAX_SEGMENTS = '2';

const { runTurn } = await import('../src/agent.mjs');
const { chooseProfile, describeProfile, scoreTask } = await import('../src/model.mjs');
const {
  buildDigest,
  checkAnswer,
  describeReview,
  extractFigures,
  extractFileMentions,
  needsReview,
  parseVerdict,
  reviewAnswer,
  reviewModelName,
} = await import('../src/review.mjs');
const { documentExcerpt } = await import('../src/doccheck.mjs');
const { writeZip } = await import('../src/zip.mjs');
const { continuePrompt, renderTaskState, taskSummaryLine, updateTaskState } = await import('../src/taskstate.mjs');
const { MEMORY_LIMITS, memoryPromptText, searchFacts } = await import('../src/memory.mjs');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
console.warn = () => {};
const reset = () => {
  requests.length = 0;
  behavior = () => ({ kind: 'text', text: 'ок' });
  proMissing = false;
};

const baseTurn = (overrides = {}) => ({
  workspace,
  chat: { history: [], memory: null },
  projectName: 'Проект',
  userName: 'Иван',
  userText: 'Проверь цифры по проекту',
  emit: () => {},
  signal: new AbortController().signal,
  ...overrides,
});

const mainRequests = () => requests.filter((item) => !item.isSubagent && !item.isReview && !item.isFix);

test('сложная задача идёт на сильной модели с максимальным усилием', () => {
  const route = chooseProfile({
    text: 'Проведи аудит финансовой отчётности и собери финмодель проекта на 3 года',
    config: { enabled: true, threshold: 3, flashModel: 'flash-test', proModel: 'pro-test', flashEffort: 'high', proEffort: 'max' },
  });
  assert.equal(route.profile, 'pro');
  assert.equal(route.model, 'pro-test');
  assert.equal(route.effort, 'max');
  assert.ok(route.reasons.includes('аудит') && route.reasons.includes('финмодель'));
  assert.match(describeProfile(route), /^pro \(/);
});

test('короткий вопрос остаётся на быстрой модели', () => {
  const route = chooseProfile({
    text: 'Сколько будет 3 умножить на 7?',
    config: { enabled: true, threshold: 3, flashModel: 'flash-test', proModel: 'pro-test', flashEffort: 'high', proEffort: 'max' },
  });
  assert.equal(route.profile, 'flash');
  assert.equal(route.model, 'flash-test');
  assert.equal(route.effort, 'high');
  assert.ok(route.score < route.threshold);
});

test('вложения, объём и создание документов поднимают сложность', () => {
  const heavy = scoreTask({
    text: 'Сведи данные в отчёт',
    tools: ['write_file', 'create_excel', 'create_word'],
    images: 2,
  });
  assert.ok(heavy.score >= 3, `ожидалась сложность от 3, получено ${heavy.score}`);
  assert.ok(heavy.reasons.includes('создание документов'));
  const volume = scoreTask({ text: `${'Подробности задачи. '.repeat(160)}` });
  assert.ok(volume.score >= 3, 'длинный запрос не считается объёмным');
});

test('явный профиль и выключенная эскалация работают предсказуемо', () => {
  const config = { enabled: true, threshold: 3, flashModel: 'flash-test', proModel: 'pro-test', flashEffort: 'high', proEffort: 'max' };
  assert.equal(chooseProfile({ text: 'аудит', config, force: 'flash' }).profile, 'flash');
  assert.equal(chooseProfile({ text: 'привет', config, force: 'pro' }).profile, 'pro');
  const off = chooseProfile({ text: 'аудит финмодель', config: { ...config, enabled: false } });
  assert.equal(off.profile, 'flash');
  assert.deepEqual(off.reasons, ['эскалация выключена']);
});

test('ход на сложной задаче просит pro, на простой — flash', async () => {
  reset();
  behavior = () => ({ kind: 'text', text: 'Готово: проверил.' });
  await runTurn(baseTurn({ userText: 'Проведи аудит финансовой отчётности и собери финмодель проекта' }));
  const heavy = mainRequests()[0];
  assert.equal(heavy.model, 'pro-test');
  assert.equal(heavy.effort, 'max');

  reset();
  behavior = () => ({ kind: 'text', text: 'Ответ: 21.' });
  await runTurn(baseTurn({ userText: 'Сколько будет 3 умножить на 7?' }));
  const light = mainRequests()[0];
  assert.equal(light.model, 'flash-test');
  assert.equal(light.effort, 'high');
});

test('недоступная сильная модель откатывается на рабочую', async () => {
  reset();
  proMissing = true;
  behavior = () => ({ kind: 'text', text: 'Отчёт готов.' });
  const outcome = await runTurn(baseTurn({ userText: 'Проведи аудит финансовой отчётности и собери финмодель' }));
  assert.match(outcome.text, /Отчёт готов/);
  const models = requests.map((item) => item.model);
  assert.ok(models.includes('pro-test'), 'сильная модель даже не пробовалась');
  assert.ok(models.includes('flash-test'), 'не было отката на рабочую модель');
});

test('выдуманная цифра и обещанный, но не созданный файл находятся', () => {
  const answer = 'Выручка составила 1 234 567 руб. Готов отчёт итоги.pdf.';
  const issues = checkAnswer({ answer, toolDigest: 'Выручка 900000 руб.', createdFiles: [] });
  assert.ok(issues.some((issue) => issue.kind === 'figure' && issue.quote === '1234567'), 'цифра не проверена');
  assert.ok(issues.some((issue) => issue.kind === 'file'), 'обещанный файл не найден');
  const clean = checkAnswer({ answer: 'Выручка 1 234 567 руб, файл готовых данных.xlsx', toolDigest: 'выручка 1234567', createdFiles: ['out/готовых данных.xlsx'] });
  assert.equal(clean.length, 0, `ложные замечания: ${JSON.stringify(clean)}`);
});

test('годы не считаются выдуманными цифрами, тысячи с пробелом узнаются', () => {
  assert.deepEqual(extractFigures('В 2024 году выручка 12 345 678 руб.'), [12345678]);
  assert.deepEqual(extractFileMentions('Файл итоги.docx, план.xlsx'), ['итоги.docx', 'план.xlsx']);
  assert.equal(checkAnswer({ answer: 'Итог 12 345 678', toolDigest: '12345678' }).length, 0);
});

test('разбор вердикта проверяющего: JSON в блоке и мусор', () => {
  const parsed = parseVerdict('```json\n{"verdict":"fix","issues":[{"kind":"unit","severity":"high","quote":"тыс.","hint":"добавь единицы"}]}\n```');
  assert.equal(parsed.verdict, 'fix');
  assert.equal(parsed.issues[0].kind, 'unit');
  assert.equal(parseVerdict('всё хорошо'), null);
  assert.equal(parseVerdict('{"verdict":"ok","issues":[]}').verdict, 'ok');
  assert.equal(parseVerdict('{"verdict":"что-то","issues":"нет"}').verdict, 'ok');
});

test('ревью не запускается для субагентов, реплик и коротких ответов', () => {
  assert.equal(needsReview({ answer: 'x'.repeat(900), depth: 1, tools: [{ status: 'ok' }] }), false);
  assert.equal(needsReview({ answer: 'x'.repeat(900), depth: 0, tools: [] }), false);
  assert.equal(needsReview({ answer: 'коротко', depth: 0, tools: [{ status: 'ok' }] }), false);
  assert.equal(needsReview({ answer: 'x'.repeat(900), depth: 0, tools: [{ status: 'error' }] }), false);
  assert.equal(needsReview({ answer: 'x'.repeat(900), depth: 0, tools: [{ status: 'ok' }] }), true);
});

test('правка ответа по замечаниям и отказ от правки с новыми выдумками', async () => {
  const answer = `${'Проверил данные проекта. '.repeat(30)}Итог: 7 654 321 руб.`;
  const tools = [{ name: 'write_file', status: 'ok', path: 'summary.md' }];
  const history = [{ role: 'tool', content: 'Расчёт: 250 000 руб.' }];
  const complete = async (messages) => {
    const system = String(messages[0]?.content || '');
    if (system.includes(FIX_MARK)) return 'Готово: файл summary.md создан, сумма 250 000 руб. совпадает с расчётом по проекту.';
    return JSON.stringify({ verdict: 'fix', issues: [{ kind: 'figure', severity: 'high', quote: '7 654 321', hint: 'нет в источниках' }] });
  };
  const fixed = await reviewAnswer({ userQuestion: 'посчитай итог', answer, history, createdFiles: ['summary.md'], tools, complete });
  assert.equal(fixed.report.fixed, true, 'правка не применилась');
  assert.equal(fixed.report.verdict, 'fixed');
  assert.match(fixed.text, /250 000/);
  assert.ok(!fixed.text.includes('7 654 321'));
  assert.match(describeReview(fixed.report), /ответ исправлен по \d+ замечани/);
  assert.ok(fixed.report.fixedCount >= 1, 'в отчёте нет числа закрытых замечаний');
  assert.ok(!/по 0 замечаниям/.test(describeReview(fixed.report)), 'лог не должен писать «по 0 замечаниям»');

  /* Правка, добавившая новую выдуманную цифру, отбрасывается. */
  const bad = await reviewAnswer({
    userQuestion: 'посчитай итог',
    answer,
    history,
    createdFiles: ['summary.md'],
    tools,
    complete: async (messages) =>
      String(messages[0]?.content || '').includes(FIX_MARK)
        ? 'Исправленный ответ: итог 8 888 888 руб., всё остальное как было.'
        : JSON.stringify({ verdict: 'fix', issues: [{ kind: 'figure', severity: 'high', quote: '7 654 321', hint: 'нет' }] }),
  });
  assert.equal(bad.report.fixed, false);
  assert.match(bad.text, /7 654 321/, 'сомнительная правка подменила ответ');
});

test('сбой проверяющего не мешает ответу', async () => {
  const answer = `${'Отчёт по проекту. '.repeat(40)}Итог 7 654 321 руб.`;
  const result = await reviewAnswer({
    userQuestion: 'итог',
    answer,
    history: [{ role: 'tool', content: '250 000' }],
    createdFiles: [],
    tools: [{ name: 'write_file', status: 'ok' }],
    complete: async () => {
      throw new Error('сеть недоступна');
    },
  });
  assert.equal(result.report.checked, true);
  assert.match(result.text, /7 654 321/, 'ответ изменился из-за сбоя проверки');
});

test('карточка задачи собирается из запроса и сделанного', () => {
  const state = updateTaskState(null, {
    userText: 'Подготовь отчёт.\n1. Собери рынок\n2. Посчитай юнит-экономику\n3. Свёрстай PDF',
    tools: [
      { name: 'create_word', label: 'Word', summary: 'отчёт.docx', status: 'ok', path: 'отчёт.docx' },
      { name: 'write_file', label: 'Файл', summary: 'notes.md', status: 'error', path: 'notes.md' },
    ],
    steps: 12,
    segments: 1,
  });
  assert.match(state.goal, /Подготовь отчёт/);
  assert.deepEqual(state.files, ['отчёт.docx']);
  assert.equal(state.facts.length, 1);
  assert.ok(state.done.length >= 1);
  assert.ok(state.next.length >= 1, 'пункты запроса не попали в «осталось»');
  assert.equal(state.steps, 12);
  const card = renderTaskState(state);
  assert.match(card, /Цель:/);
  assert.match(card, /Готовые файлы: отчёт\.docx/);
  assert.ok(continuePrompt(state, 'Продолжай.').includes('Состояние текущей задачи'));
  assert.match(taskSummaryLine(state), /Файлы: отчёт\.docx/);
  assert.equal(renderTaskState(null), '');
});

test('карточка задачи попадает в промпт следующего хода', async () => {
  reset();
  behavior = () => ({ kind: 'text', text: 'Продолжил.' });
  const chat = { history: [], memory: null, task: { goal: 'Собрать финмодель проекта', files: ['model.xlsx'], done: ['Собран рынок'] } };
  await runTurn(baseTurn({ chat, userText: 'Continue' }));
  const system = mainRequests()[0].system;
  assert.match(system, /Собрать финмодель проекта/);
  assert.match(system, /model\.xlsx/);
});

test('на отрезке модель получает карточку, а не голое «продолжай»', async () => {
  reset();
  let step = 0;
  behavior = () => {
    step += 1;
    if (step <= 2) return { kind: 'tool', name: 'write_file', args: { path: `part${step}.md`, content: `часть ${step}` } };
    return { kind: 'text', text: 'Итог собран.' };
  };
  const outcome = await runTurn(baseTurn({ userText: 'Собери отчёт по частям' }));
  assert.ok(outcome.steps >= 2, 'шаги не выполнились');
  const sawCard = requests.some((item) =>
    item.messages.some((message) => typeof message.content === 'string' && message.content.includes('Состояние текущей задачи')),
  );
  assert.ok(sawCard, 'в сообщении о продолжении нет карточки задачи');
});

test('ревью правит готовый ответ до выдачи', async () => {
  reset();
  let step = 0;
  behavior = () => {
    step += 1;
    if (step === 1) return { kind: 'tool', name: 'calculate', args: { expression: '1000000/4' } };
    return {
      kind: 'text',
      text: `${'Проверил данные проекта и подготовил сводку. '.repeat(30)}Итог: 7 654 321 руб.`,
    };
  };
  const outcome = await runTurn(baseTurn({ userText: 'Посчитай итог и подготовь сводку' }));
  assert.ok(outcome.review?.checked, 'ревью не запускалось');
  assert.equal(outcome.review.fixed, true, 'правка не применилась');
  assert.match(outcome.text, /250 000/);
  assert.ok(!outcome.text.includes('7 654 321'), 'выдуманная цифра осталась в ответе');
});

test('проверяющий работает на сильной модели, если задача шла на быстрой', async () => {
  reset();
  let step = 0;
  behavior = () => {
    step += 1;
    if (step === 1) return { kind: 'tool', name: 'calculate', args: { expression: '1000000/4' } };
    return { kind: 'text', text: `${'Проверил данные проекта и подготовил сводку. '.repeat(30)}Итог: 250 000 руб.` };
  };
  const outcome = await runTurn(baseTurn({ userText: 'Посчитай итог и подготовь сводку' }));
  assert.equal(outcome.route.model, 'flash-test', 'сценарий должен идти на быстрой модели');
  const reviews = requests.filter((item) => item.isReview);
  assert.ok(reviews.length, 'проверяющий не вызывался');
  assert.ok(
    reviews.every((item) => item.model === 'pro-test'),
    `проверяющий пошёл на модели ${reviews.map((item) => item.model).join(', ')}`,
  );
  assert.equal(outcome.review.model, 'pro-test');
});

test('модель проверяющего: сильная для быстрой задачи, та же для сильной', () => {
  const escalation = { enabled: true, proModel: 'pro-test', flashModel: 'flash-test' };
  assert.equal(reviewModelName({ routeModel: 'flash-test', model: '', escalation }), 'pro-test');
  assert.equal(reviewModelName({ routeModel: 'pro-test', model: '', escalation }), '', 'незачем платить дважды');
  assert.equal(reviewModelName({ routeModel: 'flash-test', model: 'review-test', escalation }), 'review-test');
  assert.equal(reviewModelName({ routeModel: 'flash-test', model: '', escalation: { ...escalation, enabled: false } }), '');
  assert.equal(reviewModelName({ routeModel: 'flash-test', model: '', escalation: { enabled: true, proModel: '' } }), '');
});

test('выдержка из docx: тема и текст файла, лишнее усечено', async () => {
  const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="x"><w:body>${'<w:p><w:r><w:t>Отчёт по рынку кофе: рост 12%, итог 4 500 000 руб.</w:t></w:r></w:p>'.repeat(20)}<w:tbl></w:tbl></w:body></w:document>`;
  const docx = path.join(workspace, 'excerpt.docx');
  fs.writeFileSync(docx, writeZip([{ name: 'word/document.xml', data: xml }]));
  const text = await documentExcerpt(docx, { chars: 200 });
  assert.match(text, /Отчёт по рынку кофе/);
  assert.match(text, /таблиц 1/);
  assert.ok(text.length <= 240, `выдержка не усечена: ${text.length}`);
  const missing = await documentExcerpt(path.join(workspace, 'нет.docx'));
  assert.equal(missing, '');
  assert.equal(await documentExcerpt(path.join(workspace, 'file.pdf')), '', 'PDF не разбираем');
});

test('проверяющий видит содержимое созданных файлов', async () => {
  const prompts = [];
  const answer = `${'Подготовил документ по рынку. '.repeat(40)}Файл готов.`;
  const result = await reviewAnswer({
    userQuestion: 'Сделай отчёт по рынку кофе',
    answer,
    history: [{ role: 'tool', content: 'create_word ok' }],
    createdFiles: ['Отчёт.docx'],
    excerpts: [{ file: 'Отчёт.docx', text: 'Отчёт по рынку кофе: рост 12%, итог 4 500 000 руб.' }],
    tools: [{ name: 'create_word', status: 'ok', path: 'Отчёт.docx' }],
    complete: async (messages) => {
      prompts.push(String(messages[1]?.content || ''));
      return JSON.stringify({ verdict: 'ok', issues: [] });
    },
  });
  assert.equal(result.report.checked, true);
  assert.ok(prompts.length, 'проверяющему нечего было смотреть');
  assert.match(prompts[0], /Что внутри созданных файлов/);
  assert.match(prompts[0], /рост 12%/);
});

test('память помнит 100 фактов и отбирает по теме запроса', () => {
  assert.equal(MEMORY_LIMITS.maxFacts, 100);
  const facts = [];
  for (let index = 0; index < 60; index++) {
    facts.push({ text: `Правило номер ${index}: документы оформлять с колонтитулом и подписью.` });
  }
  facts.push({ text: 'В аудите всегда указывать существенность и уровень выборки.' });
  const found = searchFacts(facts, 'проведи аудит отчётности', { limit: 10 });
  assert.ok(found.some((fact) => /существенность/.test(fact.text)), 'аудит-факт не попал в отбор');
  const text = memoryPromptText(facts, { query: 'проведи аудит отчётности' });
  assert.match(text, /существенность/);
  assert.match(text, /в памяти 61 фактов/);
  assert.ok(text.length <= 3600 + 400, 'память раздула промпт');
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
server.close();
fs.rmSync(tmpRoot, { recursive: true, force: true });
console.log(failed ? `\n${failed} из ${tests.length} тестов не прошли` : `\nвсе ${tests.length} тестов прошли`);
process.exit(failed ? 1 : 0);
