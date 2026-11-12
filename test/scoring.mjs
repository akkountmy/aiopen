/**
 * Скоринг: карта баллов и рейтинг юрлица. Проверяем не «код не упал», а числа,
 * которые пойдут в документ модели:
 *  - на синтетике с известным сигналом AUC и KS обязаны быть высокими, иначе
 *    расчёт бесполезен;
 *  - корзины числового признака после склейки монотонны по доле плохих — это
 *    требование валидации, а не украшение;
 *  - PSI между обучением и отложенной выборкой мал (выборка делится случайно);
 *  - отсечка по деньгам не «одобряем всех»: при lgd 4 к margin 1 оптимум
 *    внутри, иначе экономика не считается;
 *  - пропуски не ломают модель и дают корзину «пусто»;
 *  - рейтинг юрлица различает крепкую и слабую компанию, а не выдаёт всем B.
 *
 * Запуск: node test/scoring.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { buildScorecard, formatScorecard, rateCompany, auc } = await import('../src/scoring.mjs');
const { executeTool } = await import('../src/tools.mjs');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

/* --------------------------- синтетическая история ------------------------ */

function makeRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Заявки с настоящей зависимостью исхода от dti, дохода и просрочек в прошлом. */
function history(count = 2400, seed = 7) {
  const random = makeRandom(seed);
  const channels = ['сайт', 'партнёр', 'офис'];
  const rows = [];
  for (let index = 0; index < count; index += 1) {
    const age = 21 + Math.floor(random() * 45);
    const income = Math.round(25000 + random() * 175000);
    const dti = Math.round(random() * 100) / 100;
    const term = [12, 24, 36, 48, 60][Math.floor(random() * 5)];
    const channel = channels[Math.floor(random() * 3)];
    const prior = Math.floor(random() * 4);
    const z = -3.6 + 3.2 * dti + 0.85 * prior - 0.85 * Math.log(income / 70000) + (age < 26 ? 0.8 : 0) + (channel === 'офис' ? 0.3 : 0);
    const pd = 1 / (1 + Math.exp(-z));
    rows.push({ age, income, dti, term, channel, prior, target: random() < pd ? 1 : 0 });
  }
  return rows;
}

const data = history();
const result = buildScorecard({ rows: data, target: 'target', options: { margin: 1, lgd: 4 } });

/* --------------------------------- тесты --------------------------------- */

test('на синтетике модель различает хороших и плохих', () => {
  assert.ok(result.metrics.aucValid > 0.7, `AUC ${result.metrics.aucValid} — ниже 0,7, сигнал потерян`);
  assert.ok(result.metrics.aucValid < 0.99, `AUC ${result.metrics.aucValid} — подозрительно высокий, проверка на утечку не пройдена`);
  assert.ok(Math.abs(result.metrics.giniValid - (2 * result.metrics.aucValid - 1)) < 0.001, 'Gini не равен 2×AUC−1');
  assert.ok(result.metrics.ksValid > 0.25, `KS ${result.metrics.ksValid} — слабое разделение`);
  assert.equal(result.rows, data.length, 'все строки должны попасть в расчёт');
});

test('признаки с сигналом отобраны, шум и идентификаторы — нет', () => {
  const names = result.features.map((feature) => feature.name);
  assert.ok(names.includes('dti'), 'долговая нагрузка не попала в модель');
  assert.ok(names.includes('income'), 'доход не попал в модель');
  assert.ok(!names.some((name) => /id|дата/i.test(name)), 'идентификаторы не должны попадать в модель');
  for (const feature of result.features) assert.ok(feature.iv > 0.02, `${feature.name}: IV ${feature.iv} ниже порога`);
});

test('корзины числовых признаков монотонны после склейки', () => {
  for (const feature of result.scorecard) {
    const source = result.features.find((item) => item.name === feature.feature);
    if (!source || source.kind !== 'numeric') continue;
    const rates = feature.bins.map((bin) => bin.badRate);
    const rising = rates.every((rate, index) => index === 0 || rate >= rates[index - 1] - 1e-9);
    const falling = rates.every((rate, index) => index === 0 || rate <= rates[index - 1] + 1e-9);
    assert.ok(rising || falling, `${feature.feature}: доля плохих немонотонна (${rates.join(', ')})`);
  }
});

test('баллы корзины идут против риска: высокая доля плохих — меньше баллов', () => {
  for (const feature of result.scorecard) {
    const sorted = [...feature.bins].sort((a, b) => a.badRate - b.badRate);
    const first = sorted[0].points;
    const last = sorted[sorted.length - 1].points;
    assert.ok(first >= last, `${feature.feature}: у самой плохой корзины баллов больше, чем у самой хорошей (${first} < ${last})`);
  }
});

test('PSI на отложенной выборке мал: распределение баллов не уехало', () => {
  assert.ok(result.metrics.psi < 0.1, `PSI ${result.metrics.psi} — сдвиг на случайном сплите, значит расчёт стабильности врёт`);
  assert.equal(result.metrics.psiVerdict, 'стабильно');
});

test('отсечка по деньгам не «одобряем всех» и приносит прибыль', () => {
  assert.ok(result.bestCutoff, 'отсечка не посчитана');
  assert.ok(result.bestCutoff.profit > 0, `прибыль ${result.bestCutoff.profit} при лучшем пороге — модель не зарабатывает`);
  assert.ok(result.bestCutoff.share < 0.99, 'оптимум совпал с «одобряем всех»: экономика не участвует в выборе порога');
  assert.ok(result.bestCutoff.approve < data.length * 0.7, 'хвост плохих не отрезается');
  const wrongWay = result.cutoffs.every((row) => row.share > 0.9);
  assert.equal(wrongWay, false, 'таблица отсечек не показывает диапазон решений');
});

test('полосы рейтинга покрывают шкалу и ухудшаются сверху вниз', () => {
  assert.equal(result.bands.length, 5);
  const worst = result.bands[result.bands.length - 1];
  const best = result.bands[0];
  assert.ok(worst.avgPd > best.avgPd, 'средний PD в худшей полосе не выше, чем в лучшей');
  const shares = result.bands.reduce((sum, band) => sum + band.share, 0);
  assert.ok(Math.abs(shares - 1) < 0.01, `полосы покрывают ${shares} выборки вместо 1`);
});

test('пропуски не ломают модель', () => {
  const withGaps = history(1200, 11).map((row, index) => {
    if (index % 20 === 0) return { ...row, income: null };
    if (index % 37 === 0) return { ...row, age: null };
    return row;
  });
  const model = buildScorecard({ rows: withGaps, target: 'target' });
  assert.ok(model.metrics.aucValid > 0.6, `AUC ${model.metrics.aucValid} при пропусках`);
  const empty = model.scorecard.flatMap((feature) => feature.bins).filter((bin) => bin.label === 'пусто');
  assert.ok(empty.length > 0, 'корзина «пусто» не появилась в карте баллов');
});

test('расчёт детерминирован: два прогона дают одинаковые метрики', () => {
  const again = buildScorecard({ rows: data, target: 'target', options: { margin: 1, lgd: 4 } });
  assert.equal(again.metrics.aucValid, result.metrics.aucValid);
  assert.equal(again.bestCutoff.cutoffScore, result.bestCutoff.cutoffScore);
});

test('плохие данные объясняются словами, а не падением', () => {
  assert.throws(() => buildScorecard({ rows: data.slice(0, 50), target: 'target' }), /мало данных/);
  assert.throws(() => buildScorecard({ rows: data, target: 'нет-такой-колонки' }), /Нет колонки исхода/);
  assert.throws(() => buildScorecard({ rows: [], target: 'target' }), /Нет строк/);
  assert.throws(
    () => buildScorecard({ rows: data.map((row) => ({ ...row, target: 0 })), target: 'target' }),
    /классов слишком мало/,
  );
});

test('текст отчёта содержит числа, которые требует документ модели', () => {
  const text = formatScorecard(result);
  assert.match(text, /AUC/);
  assert.match(text, /Gini/);
  assert.match(text, /KS/);
  assert.match(text, /PSI/);
  assert.match(text, /Лучший порог/);
  assert.match(text, /риск-комитет/);
});

test('AUC считается и на совпадающих баллах', () => {
  assert.equal(auc([]), null);
  assert.equal(auc([{ score: 1, target: 1 }]), null);
  const perfect = auc([
    { score: 1, target: 0 }, { score: 2, target: 0 }, { score: 3, target: 1 }, { score: 4, target: 1 },
  ]);
  assert.equal(perfect, 1);
  const ties = auc([
    { score: 1, target: 0 }, { score: 1, target: 1 },
  ]);
  assert.equal(ties, 0.5);
});

/* -------------------------- рейтинг юрлица ------------------------------- */

const strong = {
  revenue: 1200000000, priorRevenue: 1000000000, ebitda: 240000000, assets: 900000000,
  equity: 520000000, currentAssets: 480000000, inventory: 90000000, receivables: 120000000,
  cash: 140000000, currentLiabilities: 190000000, totalDebt: 250000000, interestExpense: 30000000,
  netIncome: 120000000, cfo: 210000000,
};
const weak = {
  revenue: 300000000, priorRevenue: 420000000, ebitda: -20000000, assets: 500000000,
  equity: -60000000, currentAssets: 120000000, inventory: 80000000, receivables: 90000000,
  cash: 5000000, currentLiabilities: 260000000, totalDebt: 340000000, interestExpense: 45000000,
  netIncome: -90000000, cfo: -30000000,
};

test('крепкая компания получает высокий класс, слабая — низкий', () => {
  const good = rateCompany(strong);
  const bad = rateCompany(weak);
  assert.ok(['AAA', 'AA', 'A'].includes(good.grade), `крепкая компания получила ${good.grade}`);
  assert.ok(['CCC', 'D'].includes(bad.grade), `слабая компания получила ${bad.grade}`);
  assert.ok(good.score > bad.score + 40, `баллы слишком близки: ${good.score} против ${bad.score}`);
  assert.ok(good.pd < bad.pd, 'PD крепкой компании не ниже слабой');
  assert.equal(good.flags.length, 0, `у крепкой компании флаги: ${good.flags.join('; ')}`);
});

test('слабая компания объясняет отказ флагами и лимитом', () => {
  const bad = rateCompany(weak);
  assert.ok(bad.flags.length >= 4, `флагов ${bad.flags.length}: отказ не обоснован`);
  assert.ok(bad.flags.some((flag) => /Отрицательный капитал/.test(flag)), 'нет флага об отрицательном капитале');
  assert.ok(bad.flags.some((flag) => /EBITDA/.test(flag)), 'нет флага по EBITDA');
  assert.equal(bad.recommendedLimit, 0, 'слабой компании предложен лимит больше нуля');
});

test('рейтинг требует выручку и не выдумывает её', () => {
  assert.throws(() => rateCompany({}), /выручка/);
  assert.throws(() => rateCompany({ revenue: 0 }), /выручка/);
});

test('инструмент score_credit строит карту баллов из файла и сохраняет CSV', async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-score-'));
  const project = path.join(work, 'project');
  fs.mkdirSync(project, { recursive: true });
  const rows = history(1400, 3).map((row, index) => (index % 25 === 0 ? { ...row, income: '' } : row));
  const header = ['age', 'income', 'dti', 'term', 'channel', 'prior', 'target'];
  const csv = [header.join(';'), ...rows.map((row) => header.map((name) => row[name]).join(';'))].join('\r\n');
  fs.writeFileSync(path.join(project, 'заявки.csv'), `\uFEFF${csv}\r\n`, 'utf8');

  const answer = await executeTool('score_credit', { mode: 'scorecard', path: 'заявки.csv' }, { workspace: project });
  assert.match(answer.text, /AUC/);
  assert.match(answer.text, /Карта баллов/);
  assert.match(answer.text, /Сохранено рядом с выгрузкой/);
  assert.ok(answer.meta.auc > 0.7, `AUC из инструмента ${answer.meta.auc}`);
  assert.ok(fs.existsSync(path.join(project, 'заявки-карта-баллов.csv')), 'карта баллов не сохранена');
  assert.ok(fs.existsSync(path.join(project, 'заявки-отсечки.csv')), 'отсечки не сохранены');
  const card = fs.readFileSync(path.join(project, 'заявки-карта-баллов.csv'), 'utf8');
  assert.match(card, /^\uFEFF?Признак;Корзина;Заявок;Доля;Доля плохих;WOE;Баллы\r\n/);
  assert.match(card, /;пусто;/, 'корзина «пусто» не попала в файл');
  fs.rmSync(work, { recursive: true, force: true });
});

test('инструмент score_credit оценивает юрлицо по отчётности', async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-score-company-'));
  const project = path.join(work, 'project');
  fs.mkdirSync(project, { recursive: true });
  const answer = await executeTool('score_credit', { mode: 'company', ...strong, industry: 'оптовая торговля' }, { workspace: project });
  assert.match(answer.text, /Внутренний рейтинг/);
  assert.match(answer.text, /Ориентир лимита/);
  assert.equal(answer.meta.mode, 'company');
  assert.ok(answer.meta.limit > 0, 'крепкой компании не предложен лимит');
  assert.equal(answer.meta.grade === 'D', false, 'крепкая компания получила D');
  fs.rmSync(work, { recursive: true, force: true });
});

test('инструмент без пути объясняет, что нужно, и не падает', async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-score-empty-'));
  const project = path.join(work, 'project');
  fs.mkdirSync(project, { recursive: true });
  await assert.rejects(() => executeTool('score_credit', {}, { workspace: project }), /Укажите path/);
  await assert.rejects(() => executeTool('score_credit', { mode: 'scorecard', path: 'нет.csv' }, { workspace: project }), /ENOENT|не найден/i);
  fs.rmSync(work, { recursive: true, force: true });
});

/* --------------------------------- итог ---------------------------------- */

let failed = 0;
for (const item of tests) {
  try {
    await item.fn();
    console.log(`ok   ${item.name}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL ${item.name}: ${error?.message || error}`);
  }
}
console.log(failed ? `\n${failed} из ${tests.length} не прошли` : `\nвсе ${tests.length} прошли`);
process.exit(failed ? 1 : 0);
