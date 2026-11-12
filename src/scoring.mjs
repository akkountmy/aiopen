/**
 * Скоринговая модель: построение карты баллов по истории заявок и оценка
 * компании по отчётности. Без внешних зависимостей и без обращений к модели.
 *
 * Почему это модуль, а не текст навыка: скоринг — это расчёт, в котором важны
 * детали (монотонность корзин, WOE, отсечка по экономике, PSI). Текст в навыке
 * не может проверить сам себя, а здесь каждое число считается и проверяется
 * тестом test/scoring.mjs.
 *
 * Что считается (розница / МСБ):
 *  - целевое событие задаёт человек: 1 = дефолт (просрочка 30+/60+/90+),
 *    0 = кредит обслуживается;
 *  - обучающая и отложенная выборки делятся по времени или детерминированно;
 *  - по каждому признаку строятся корзины (равночастотные для чисел, группы для
 *    категорий), затем нарушение монотонности убирается склейкой соседних
 *    корзин (pool adjacent violators). Это и есть ручная работа риск-аналитика,
 *    только без Excel;
 *  - WOE = ln(доля хороших / доля плохих), IV = сумма (доля хороших − доля
 *    плохих) × WOE, признаки с IV ниже порога отбрасываются;
 *  - логистическая регрессия на WOE с L2-регуляризацией, обучение IRLS;
 *  - шкала баллов: base + PDO, по умолчанию 600 баллов при 50:1 и 20 баллов на
 *    удвоение шансов (стандарт индустрии);
 *  - отсечка выбирается по деньгам: одобрение хорошего клиента приносит margin,
 *    одобрение плохого теряет lgd; максимум ожидаемой прибыли — и есть порог;
 *  - проверки: AUC, Gini, KS, калибровка по десяткам, PSI между обучением и
 *    отложенной выборкой.
 *
 * Чего здесь нет и быть не может: проверки на реальных данных компании, решений
 * о допустимости признаков (это политика и юристы), валидации по стандарту
 * модели (документ пишет человек). Скрипт даёт числа, а не разрешение.
 */

/* ------------------------------- мелочи --------------------------------- */

const EPS = 1e-9;
const round = (value, digits = 4) => {
  if (!Number.isFinite(value)) return null;
  const k = 10 ** digits;
  return Math.round(value * k) / k;
};
const clamp = (value, lo, hi) => Math.min(hi, Math.max(lo, value));

/** Число из ячейки: понимает пробелы, запятую как разделитель, %, знак ₽. */
export function toNumber(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  let text = String(value).trim();
  if (!text) return null;
  text = text.replace(/[\s\u00a0\u202f]/g, '').replace(/[₽$€]/g, '');
  const percent = /%$/.test(text);
  text = text.replace(/%$/, '');
  if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(text)) text = text.replace(/,/g, '');
  text = text.replace(',', '.');
  const number = Number(text);
  if (!Number.isFinite(number)) return null;
  return percent ? number / 100 : number;
}

/** Детерминированный генератор: одинаковый вход — одинаковый сплит. */
function makeRandom(seed = 42) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ------------------------------- корзины -------------------------------- */

/** Границы равночастотных корзин по числовому признаку. */
function quantileEdges(values, bins) {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (sorted.length < bins * 2) return [];
  const edges = [];
  for (let i = 1; i < bins; i += 1) {
    const position = (i / bins) * (sorted.length - 1);
    const lo = Math.floor(position);
    const hi = Math.ceil(position);
    const value = sorted[lo] + (sorted[hi] - sorted[lo]) * (position - lo);
    if (!edges.length || value > edges[edges.length - 1]) edges.push(value);
  }
  return edges;
}

/** Подпись корзины по её границам: она же печатается в карте баллов.
 *  Десятичный разделитель — запятая: подпись читают люди, а не парсер. */
function describeBounds(lo, hi) {
  const fmt = (value) => String(round(value, 2)).replace('.', ',');
  if (lo === null || hi === null) return 'пусто';
  if (lo === Number.NEGATIVE_INFINITY) return `до ${fmt(hi)}`;
  if (hi === Number.POSITIVE_INFINITY) return `${fmt(lo)} и больше`;
  return `${fmt(lo)}–${fmt(hi)}`;
}

/**
 * Раскладка числового признака по корзинам с двумя исправлениями,
 * без которых карта баллов не принимается валидацией:
 *  1) малочисленная корзина склеивается с соседней;
 *  2) нарушение монотонности доли плохих убирается склейкой (pool adjacent).
 *
 * Корзина хранит свои границы, а не только подпись: по подписи значение не
 * найти (после склейки она вида «3,5–7 + 7–9»), а по границам — всегда.
 */
function binNumeric(rows, feature, config) {
  const { bins, minCount } = config;
  const present = rows.map((row) => row[feature]).filter((v) => Number.isFinite(v));
  if (present.length < minCount * 2) return null;
  const edges = quantileEdges(present, bins);
  const bucketOf = (value) => {
    if (!Number.isFinite(value)) return -1;
    const index = edges.findIndex((edge) => value <= edge);
    return index === -1 ? edges.length : index;
  };
  const buckets = new Map();
  for (const row of rows) {
    const index = bucketOf(row[feature]);
    if (!buckets.has(index)) {
      buckets.set(index, {
        key: index,
        count: 0,
        bad: 0,
        lo: index === -1 ? null : index === 0 ? Number.NEGATIVE_INFINITY : edges[index - 1],
        hi: index === -1 ? null : index === edges.length ? Number.POSITIVE_INFINITY : edges[index],
      });
    }
    const bucket = buckets.get(index);
    bucket.count += 1;
    bucket.bad += row.__target;
  }

  /* Корзина «пусто» идёт последней: она не участвует в склейках монотонности,
     иначе пропуски растворились бы в соседнем диапазоне и потерялись в отчёте. */
  let blocks = [...buckets.values()]
    .sort((a, b) => (a.key === -1) - (b.key === -1) || a.key - b.key)
    .map((block) => ({ ...block, label: describeBounds(block.lo, block.hi), missing: block.key === -1 }));

  for (let guard = 0; guard < blocks.length * 2; guard += 1) {
    const small = blocks.findIndex((block) => !block.missing && block.count < minCount);
    if (small === -1) break;
    const neighbour = [small + 1, small - 1].find((index) => index >= 0 && index < blocks.length && !blocks[index].missing);
    if (neighbour === undefined) break;
    if (!mergeBlocks(blocks, small, neighbour)) break;
  }

  /* Направление берём по знаку связи: если плохие чаще в младших корзинах —
     доля должна убывать. Иначе навязывали бы признаку чужую логику. */
  const direction = badDirection(rows, feature);
  for (let guard = 0; guard < blocks.length * 2; guard += 1) {
    let violated = -1;
    for (let i = 0; i + 1 < blocks.length; i += 1) {
      if (blocks[i].missing || blocks[i + 1].missing) continue;
      const left = blocks[i].bad / Math.max(1, blocks[i].count);
      const right = blocks[i + 1].bad / Math.max(1, blocks[i + 1].count);
      if (direction >= 0 ? left > right + 1e-12 : left < right - 1e-12) {
        violated = i;
        break;
      }
    }
    if (violated === -1) break;
    if (!mergeBlocks(blocks, violated, violated + 1)) break;
  }

  return { type: 'numeric', blocks };
}

function mergeBlocks(blocks, a, b) {
  const leftIndex = Math.min(a, b);
  const rightIndex = Math.max(a, b);
  const first = blocks[leftIndex];
  const second = blocks[rightIndex];
  if (!first || !second || first.missing || second.missing) return false;
  const merged = {
    key: first.key,
    count: first.count + second.count,
    bad: first.bad + second.bad,
    lo: Math.min(first.lo, second.lo),
    hi: Math.max(first.hi, second.hi),
    missing: false,
  };
  merged.label = describeBounds(merged.lo, merged.hi);
  blocks.splice(rightIndex, 1);
  blocks[leftIndex] = merged;
  return true;
}

/** Направление связи: +1 — плохие в верхних корзинах, −1 — в нижних. */
function badDirection(rows, feature) {
  const usable = rows.filter((row) => Number.isFinite(row[feature]));
  if (usable.length < 30) return 1;
  const mean = usable.reduce((sum, row) => sum + row[feature], 0) / usable.length;
  let cov = 0;
  let varX = 0;
  for (const row of usable) {
    cov += (row[feature] - mean) * (row.__target - 0.5);
    varX += (row[feature] - mean) ** 2;
  }
  if (varX < EPS) return -1;
  return cov >= 0 ? 1 : -1;
}

/** Категориальный признак: редкие уровни — в «другие». */
function binCategorical(rows, feature, config) {
  const { minCount, maxLevels } = config;
  const counts = new Map();
  for (const row of rows) {
    const value = row[feature] === null || row[feature] === undefined || row[feature] === '' ? 'пусто' : String(row[feature]);
    if (!counts.has(value)) counts.set(value, { label: value, count: 0, bad: 0 });
    const bucket = counts.get(value);
    bucket.count += 1;
    bucket.bad += row.__target;
  }
  if (counts.size < 2) return null;
  let blocks = [...counts.values()];
  if (blocks.length > maxLevels) {
    blocks.sort((a, b) => b.count - a.count);
    const keep = blocks.slice(0, maxLevels - 1);
    const rest = blocks.slice(maxLevels - 1);
    keep.push({
      label: 'другие',
      count: rest.reduce((sum, item) => sum + item.count, 0),
      bad: rest.reduce((sum, item) => sum + item.bad, 0),
    });
    blocks = keep;
  }
  const rare = blocks.filter((block) => block.count < minCount && block.label !== 'другие');
  if (rare.length) {
    const others = blocks.filter((block) => !rare.includes(block));
    others.push({
      label: rare.length === 1 ? rare[0].label : 'редкие',
      count: rare.reduce((sum, item) => sum + item.count, 0),
      bad: rare.reduce((sum, item) => sum + item.bad, 0),
    });
    blocks = others;
  }
  return { type: 'categorical', blocks: blocks.map((block) => ({ ...block, key: block.label, missing: block.label === 'пусто' })) };
}

/* --------------------------------- WOE ---------------------------------- */

/** WOE и IV по корзинам. Сглаживание 0,5 — чтобы ln не уходил в бесконечность. */
function woeTable(blocks) {
  const goods = blocks.reduce((sum, block) => sum + block.count - block.bad, 0);
  const bads = blocks.reduce((sum, block) => sum + block.bad, 0);
  if (!goods || !bads) return null;
  const total = goods + bads;
  const smoothing = 0.5;
  const rows = blocks.map((block) => {
    const good = block.count - block.bad;
    const goodShare = (good + smoothing) / (goods + smoothing * blocks.length);
    const badShare = (block.bad + smoothing) / (bads + smoothing * blocks.length);
    const woe = Math.log(goodShare / badShare);
    const iv = (goodShare - badShare) * woe;
    return {
      label: block.label,
      count: block.count,
      share: round(block.count / total, 4),
      bad: block.bad,
      badRate: round(block.bad / Math.max(1, block.count), 4),
      woe: round(woe, 4),
      iv: round(iv, 4),
    };
  });
  const iv = rows.reduce((sum, row) => sum + row.iv, 0);
  return { rows, iv: round(iv, 4), woes: rows.map((row) => row.woe) };
}

/* ------------------------- логистическая регрессия ----------------------- */

/** Обучение IRLS (Ньютон–Рафсон) с L2: матрица маленькая, этого достаточно. */
function fitLogistic(X, y, { ridge = 0.001, iterations = 40 } = {}) {
  const n = X.length;
  const p = X[0].length + 1;
  const beta = new Array(p).fill(0);
  const design = X.map((row) => [1, ...row]);
  const lam = ridge * n;
  for (let step = 0; step < iterations; step += 1) {
    const gradient = new Array(p).fill(0);
    const hessian = Array.from({ length: p }, () => new Array(p).fill(0));
    for (let i = 0; i < n; i += 1) {
      const row = design[i];
      let z = 0;
      for (let j = 0; j < p; j += 1) z += beta[j] * row[j];
      const mu = 1 / (1 + Math.exp(-clamp(z, -30, 30)));
      const w = Math.max(mu * (1 - mu), 1e-6);
      const residual = y[i] - mu;
      for (let a = 0; a < p; a += 1) {
        gradient[a] += row[a] * residual;
        for (let b = 0; b < p; b += 1) hessian[a][b] += row[a] * row[b] * w;
      }
    }
    for (let a = 0; a < p; a += 1) {
      if (a > 0) gradient[a] -= lam * beta[a];
      if (a > 0) hessian[a][a] += lam;
    }
    const delta = solve(hessian, gradient);
    let size = 0;
    for (let a = 0; a < p; a += 1) {
      beta[a] += delta[a];
      size += Math.abs(delta[a]);
    }
    if (size < 1e-9) break;
  }
  return beta;
}

/** Решение линейной системы методом Гаусса с частичным выбором. */
function solve(A, b) {
  const n = b.length;
  const M = A.map((row, index) => [...row, b[index]]);
  for (let col = 0; col < n; col += 1) {
    let pivot = col;
    for (let row = col + 1; row < n; row += 1) {
      if (Math.abs(M[row][col]) > Math.abs(M[pivot][col])) pivot = row;
    }
    if (Math.abs(M[pivot][col]) < 1e-12) {
      M[col][col] -= 1e-6;
      continue;
    }
    [M[col], M[pivot]] = [M[pivot], M[col]];
    for (let row = 0; row < n; row += 1) {
      if (row === col) continue;
      const factor = M[row][col] / M[col][col];
      if (!factor) continue;
      for (let k = col; k <= n; k += 1) M[row][k] -= factor * M[col][k];
    }
  }
  return M.map((row, index) => (Math.abs(row[index]) < 1e-12 ? 0 : row[n] / row[index]));
}

/* -------------------------------- метрики ------------------------------- */

/** AUC по Манну–Уитни с половинными рангами для совпадающих баллов. */
export function auc(pairs) {
  const sorted = [...pairs].sort((a, b) => a.score - b.score);
  const n = sorted.length;
  const positives = sorted.filter((item) => item.target === 1).length;
  const negatives = n - positives;
  if (!positives || !negatives) return null;
  const ranks = new Array(n);
  for (let i = 0; i < n;) {
    let j = i;
    while (j + 1 < n && sorted[j + 1].score === sorted[i].score) j += 1;
    const rank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k += 1) ranks[k] = rank;
    i = j + 1;
  }
  let sumPositive = 0;
  for (let index = 0; index < n; index += 1) if (sorted[index].target === 1) sumPositive += ranks[index];
  return (sumPositive - (positives * (positives + 1)) / 2) / (positives * negatives);
}

/** KS — максимальный разрыв между накопленными долями хороших и плохих. */
function ks(pairs) {
  const sorted = [...pairs].sort((a, b) => a.pd - b.pd);
  const totalBad = sorted.filter((item) => item.target === 1).length;
  const totalGood = sorted.length - totalBad;
  if (!totalBad || !totalGood) return null;
  let bad = 0;
  let good = 0;
  let best = 0;
  let at = 0;
  for (const item of sorted) {
    if (item.target === 1) bad += 1;
    else good += 1;
    const gap = Math.abs(bad / totalBad - good / totalGood);
    if (gap > best) {
      best = gap;
      at = item.pd;
    }
  }
  return { value: best, pd: at };
}

/** PSI: насколько отложенная выборка уехала по распределению баллов. */
function psi(trainScores, otherScores, edges) {
  const bucketize = (scores) => {
    const counts = new Array(edges.length + 1).fill(0);
    for (const score of scores) {
      let index = edges.findIndex((edge) => score <= edge);
      if (index === -1) index = edges.length;
      counts[index] += 1;
    }
    return counts.map((count) => count / Math.max(1, scores.length));
  };
  const a = bucketize(trainScores);
  const b = bucketize(otherScores);
  let value = 0;
  for (let i = 0; i < a.length; i += 1) {
    const left = Math.max(a[i], 1e-4);
    const right = Math.max(b[i], 1e-4);
    value += (left - right) * Math.log(left / right);
  }
  return value;
}

/** Калибровка: средний PD против фактической доли плохих по группам риска. */
function calibration(pairs, buckets = 5) {
  const sorted = [...pairs].sort((a, b) => a.pd - b.pd);
  const size = Math.ceil(sorted.length / buckets);
  const rows = [];
  for (let start = 0; start < sorted.length; start += size) {
    const slice = sorted.slice(start, start + size);
    if (slice.length < 5) continue;
    const avgPd = slice.reduce((sum, item) => sum + item.pd, 0) / slice.length;
    const actual = slice.reduce((sum, item) => sum + item.target, 0) / slice.length;
    rows.push({ bucket: rows.length + 1, count: slice.length, avgPd: round(avgPd, 4), actual: round(actual, 4), gap: round(actual - avgPd, 4) });
  }
  return rows;
}

/* ------------------------------ построение ------------------------------ */

/**
 * @param {object} input
 * @param {Array<object>} input.rows — строки таблицы (ключи = имена колонок)
 * @param {string} input.target — колонка исхода: 1 = дефолт, 0 = без дефолта
 * @param {object} [input.options] — см. defaults ниже
 */
export function buildScorecard({ rows, target, options = {} }) {
  const config = {
    bins: 5,
    minCount: 30,
    minBinShare: 0.03,
    maxLevels: 12,
    minIv: 0.02,
    maxFeatures: 14,
    holdoutShare: 0.3,
    seed: 42,
    ridge: 0.001,
    baseScore: 600,
    baseOdds: 50,
    pdo: 20,
    margin: 1,
    lgd: 4,
    bands: 5,
    ...options,
  };
  if (!rows || !rows.length) throw new Error('Нет строк: передайте историю заявок в файле (.csv или .xlsx).');
  if (!rows.some((row) => Object.prototype.hasOwnProperty.call(row, target))) {
    throw new Error(`Нет колонки исхода «${target}». Проверьте имя в шапке таблицы.`);
  }

  /* Исход приводим к 0/1 и выбрасываем строки без него. */
  const prepared = [];
  let dropped = 0;
  for (const row of rows) {
    const value = toNumber(row[target]);
    if (value !== 0 && value !== 1) {
      dropped += 1;
      continue;
    }
    prepared.push({ ...row, __target: value });
  }
  if (prepared.length < 200) {
    throw new Error(`Для модели мало данных: ${prepared.length} заявок с исходом 0/1. Нужно не меньше 200, лучше 2000 и больше.`);
  }
  const badTotal = prepared.reduce((sum, row) => sum + row.__target, 0);
  if (badTotal < 20 || badTotal > prepared.length - 20) {
    throw new Error(`Плохих заявок ${badTotal} из ${prepared.length}: классов слишком мало для обучения. Проверьте колонку исхода.`);
  }

  /* Признаки: колонка исхода, идентификаторы и даты в модель не идут.
     Числовые колонки берём и с большой мощностью (доход, сумма займа): корзины
     строятся по квантилям, поэтому высокая мощность не мешает. Отсекаем только
     то, что по имени похоже на ключ или дату, и то, что задано в exclude. */
  const skip = new Set([target, ...(config.exclude || [])]);
  const idLike = /(^|[^a-zа-я])(id|ид|uuid|guid|key|код|номер|№)([^a-zа-я]|$)/i;
  const dateLike = /(дат[аеыу]?|date|time|период|period|month|месяц|год|year)/i;
  const columns = Object.keys(prepared[0]).filter((name) => !skip.has(name) && !name.startsWith('__'));
  const candidates = [];
  for (const name of columns) {
    if (idLike.test(name) || dateLike.test(name)) continue;
    const values = prepared.map((row) => row[name]);
    const filled = values.filter((value) => value !== null && value !== undefined && value !== '');
    if (!filled.length) continue;
    const unique = new Set(filled.map((value) => String(value))).size;
    if (unique < 2) continue;
    const numericRatio = filled.filter((value) => toNumber(value) !== null).length / filled.length;
    if (numericRatio >= 0.9 && unique > 6) {
      candidates.push({ name, kind: 'numeric' });
      continue;
    }
    if (unique <= config.maxLevels * 3) candidates.push({ name, kind: 'categorical' });
  }
  if (!candidates.length) throw new Error('Не нашлось признаков для модели: нужны числовые или категориальные колонки, кроме исхода.');

  /* Делим на обучение и отложенную выборку детерминированно. */
  const random = makeRandom(config.seed);
  const train = [];
  const valid = [];
  for (const row of prepared) {
    if (random() < config.holdoutShare) valid.push(row);
    else train.push(row);
  }
  if (train.length < 150 || valid.length < 40) {
    throw new Error(`Выборки слишком малы: обучение ${train.length}, отложенная ${valid.length}. Нужно больше заявок.`);
  }

  const minCount = Math.max(config.minCount, Math.round(train.length * config.minBinShare));
  const features = [];
  const warnings = [];
  for (const candidate of candidates) {
    const source = candidate.kind === 'numeric'
      ? train.map((row) => ({ [candidate.name]: toNumber(row[candidate.name]), __target: row.__target }))
      : train;
    const binned = candidate.kind === 'numeric'
      ? binNumeric(source, candidate.name, { ...config, minCount })
      : binCategorical(train, candidate.name, { ...config, minCount });
    if (!binned) continue;
    const table = woeTable(binned.blocks);
    if (!table) continue;
    const blocks = binned.blocks.map((block, index) => ({ ...block, woe: table.woes[index] }));
    features.push({ name: candidate.name, kind: candidate.kind, iv: table.iv, rows: table.rows, blocks });
  }
  if (!features.length) throw new Error('Ни один признак не дал пригодных корзин: слишком мало данных или все значения уникальны.');

  features.sort((a, b) => b.iv - a.iv);
  features.forEach((feature) => {
    if (feature.iv >= 0.5) warnings.push(`${feature.name}: IV ${num(feature.iv, 2)} — очень сильный признак, проверьте, нет ли в нём информации из будущего.`);
    if (feature.iv < 0.02) warnings.push(`${feature.name}: IV ${num(feature.iv, 3)} — ниже порога, в модель не пойдёт.`);
  });
  const used = features.filter((feature) => feature.iv >= config.minIv).slice(0, config.maxFeatures);
  if (!used.length) {
    throw new Error(`Все признаки слабые (лучший IV ${features[0].iv} < ${config.minIv}). Модель не построить: нужны признаки с IV от 0,02.`);
  }

  /* WOE по значению: ищем корзину по её границам, а не по подписи — подпись
     после склейки описывает диапазон словами и для поиска не годится. */
  const woeFor = (feature, value) => {
    if (feature.kind === 'categorical') {
      const key = value === null || value === undefined || value === '' ? 'пусто' : String(value);
      const exact = feature.blocks.find((block) => block.label === key);
      if (exact) return exact.woe;
      const rare = feature.blocks.find((block) => block.label === 'другие') ?? feature.blocks.find((block) => block.label === 'редкие');
      return rare ? rare.woe : 0;
    }
    const number = toNumber(value);
    if (number === null) {
      const empty = feature.blocks.find((block) => block.missing);
      return empty ? empty.woe : 0;
    }
    const block = feature.blocks.find((item) => !item.missing && number > item.lo && number <= item.hi);
    return block ? block.woe : 0;
  };

  const matrix = (list) => list.map((row) => used.map((feature) => clamp(woeFor(feature, row[feature.name]), -4, 4)));
  const trainY = train.map((row) => row.__target);
  const beta = fitLogistic(matrix(train), trainY, { ridge: config.ridge });
  if (beta.some((value) => !Number.isFinite(value))) throw new Error('Обучение не сошлось: проверьте данные на выбросы и повторите.');

  const predict = (row) => {
    const values = used.map((feature) => clamp(woeFor(feature, row[feature.name]), -4, 4));
    let z = beta[0];
    for (let i = 0; i < values.length; i += 1) z += beta[i + 1] * values[i];
    return 1 / (1 + Math.exp(-clamp(z, -30, 30)));
  };

  const factor = config.pdo / Math.log(2);
  const offset = config.baseScore - factor * Math.log(config.baseOdds);
  const toScore = (pd) => Math.round(clamp(offset - factor * Math.log(clamp(pd, 0.0005, 0.9995) / (1 - clamp(pd, 0.0005, 0.9995))), 0, 1000));

  const trainPairs = train.map((row) => ({ pd: predict(row), target: row.__target }));
  const validPairs = valid.map((row) => ({ pd: predict(row), target: row.__target }));
  const trainAuc = auc(trainPairs.map((pair) => ({ score: pair.pd, target: pair.target })));
  const validAuc = auc(validPairs.map((pair) => ({ score: pair.pd, target: pair.target })));
  const ksValue = ks(validPairs);
  const trainScores = train.map((row) => toScore(predict(row)));
  const validScores = valid.map((row) => toScore(predict(row)));
  const scoreEdges = quantileEdges(trainScores, 10);
  const psiValue = psi(trainScores, validScores, scoreEdges);

  /* Отсечка по деньгам: сколько заработаем/потеряем при каждом пороге. */
  const economics = [];
  const ascending = [...validPairs].sort((a, b) => a.pd - b.pd);
  let goodSum = 0;
  let badSum = 0;
  for (let approved = 0; approved < ascending.length; approved += 1) {
    const pair = ascending[approved];
    if (pair.target === 1) badSum += 1;
    else goodSum += 1;
    const step = Math.max(1, Math.floor(ascending.length / 100));
    if (approved % step) continue;
    const profit = goodSum * config.margin - badSum * config.lgd;
    economics.push({
      approve: approved + 1,
      share: round((approved + 1) / ascending.length, 4),
      cutoffPd: round(pair.pd, 4),
      cutoffScore: toScore(pair.pd),
      badRate: round(badSum / (approved + 1), 4),
      profit: round(profit, 2),
      profitPerApplication: round(profit / (approved + 1), 4),
    });
  }
  const best = economics.reduce((winner, row) => (row.profit > winner.profit ? row : winner), economics[0]);

  /* Полосы рейтинга: A — лучшая, E — худшая. Режем обучение на равные доли по
     убыванию балла, поэтому полосы упорядочены по риску по построению, а не
     «на глаз» по границам, которые могут совпасть. */
  const ordered = train
    .map((row, index) => ({ score: trainScores[index], pd: predict(row), target: row.__target }))
    .sort((a, b) => b.score - a.score);
  const gradeNames = config.bands === 5 ? ['A', 'B', 'C', 'D', 'E'] : Array.from({ length: config.bands }, (_, i) => `G${i + 1}`);
  const perBand = Math.ceil(ordered.length / config.bands);
  const bands = [];
  for (let i = 0; i < config.bands; i += 1) {
    const slice = ordered.slice(i * perBand, (i + 1) * perBand);
    if (!slice.length) {
      bands.push({ grade: gradeNames[i], scoreFrom: null, scoreTo: null, share: 0, avgPd: null, observedBadRate: null });
      continue;
    }
    let min = Infinity;
    let max = -Infinity;
    let pdSum = 0;
    let bad = 0;
    for (const item of slice) {
      if (item.score < min) min = item.score;
      if (item.score > max) max = item.score;
      pdSum += item.pd;
      bad += item.target;
    }
    bands.push({
      grade: gradeNames[i],
      scoreFrom: min,
      scoreTo: max,
      share: round(slice.length / ordered.length, 4),
      avgPd: round(pdSum / slice.length, 4),
      observedBadRate: round(bad / slice.length, 4),
    });
  }

  /* Карта баллов: сколько баллов даёт каждая корзина каждого признака.
     Корзины упорядочены по смыслу, а не по порядку появления в данных:
     числовые — от меньшего значения к большему, категориальные — от лучшей к
     худшей, «пусто» всегда последней. В отчёте это читается как карта, а не
     как случайный список. */
  const scorecard = used.map((feature, featureIndex) => {
    const coefficient = beta[featureIndex + 1];
    const total = feature.blocks.reduce((sum, block) => sum + block.count, 0) || 1;
    const ordered = [...feature.blocks].sort((a, b) => {
      if (a.missing !== b.missing) return a.missing ? 1 : -1;
      return feature.kind === 'numeric' ? a.lo - b.lo : b.woe - a.woe;
    });
    return {
      feature: feature.name,
      kind: feature.kind,
      iv: feature.iv,
      coefficient: round(coefficient, 4),
      bins: ordered.map((block) => ({
        label: block.label,
        count: block.count,
        share: round(block.count / total, 4),
        badRate: round(block.bad / Math.max(1, block.count), 4),
        woe: round(block.woe, 4),
        /* Балл корзины — её вклад в итоговый скор: чем выше WOE (лучше корзина),
           тем больше баллов, поэтому знак коэффициента снимается. */
        points: Math.round(-coefficient * block.woe * factor),
      })),
    };
  });

  return {
    rows: prepared.length,
    trainRows: train.length,
    validRows: valid.length,
    excluded: dropped,
    badRate: round(badTotal / prepared.length, 4),
    target,
    features: used.map((feature) => ({ name: feature.name, kind: feature.kind, iv: feature.iv, bins: feature.rows.length })),
    rejected: features.filter((feature) => !used.includes(feature)).map((feature) => ({ name: feature.name, iv: feature.iv })),
    scorecard,
    intercept: round(beta[0], 4),
    scale: { baseScore: config.baseScore, baseOdds: config.baseOdds, pdo: config.pdo, factor: round(factor, 2), offset: round(offset, 2) },
    metrics: {
      aucTrain: round(trainAuc, 4),
      aucValid: round(validAuc, 4),
      giniValid: validAuc === null ? null : round(2 * validAuc - 1, 4),
      ksValid: ksValue ? round(ksValue.value, 4) : null,
      ksPd: ksValue ? round(ksValue.pd, 4) : null,
      psi: round(psiValue, 4),
      psiVerdict: psiValue < 0.1 ? 'стабильно' : psiValue < 0.25 ? 'сдвиг, нужен разбор' : 'модель устарела',
    },
    calibration: calibration(validPairs),
    cutoffs: economics.filter((row) => row.share >= 0.05 || row.share === 1),
    bestCutoff: best,
    bands,
    warnings,
  };
}

/* ---------------------------- рейтинг компаний --------------------------- */

const RATIO_RULES = [
  {
    key: 'currentRatio', label: 'Текущая ликвидность (оборотные / краткосрочные)', weight: 12,
    good: 1.8, bad: 0.9, higherBetter: true,
  },
  {
    key: 'quickRatio', label: 'Быстрая ликвидность ((оборотные − запасы) / краткосрочные)', weight: 8,
    good: 1.2, bad: 0.5, higherBetter: true,
  },
  {
    key: 'equityRatio', label: 'Автономия (капитал / активы)', weight: 12,
    good: 0.5, bad: 0.15, higherBetter: true,
  },
  {
    key: 'debtToEbitda', label: 'Долг / EBITDA', weight: 15,
    good: 1.5, bad: 5, higherBetter: false,
  },
  {
    key: 'interestCoverage', label: 'Проценты к покрытию (EBITDA / проценты)', weight: 13,
    good: 5, bad: 1.2, higherBetter: true,
  },
  {
    key: 'ebitdaMargin', label: 'Рентабельность по EBITDA', weight: 10,
    good: 0.2, bad: 0.02, higherBetter: true,
  },
  {
    key: 'roa', label: 'Рентабельность активов (чистая прибыль / активы)', weight: 8,
    good: 0.12, bad: 0, higherBetter: true,
  },
  {
    key: 'cfoToDebt', label: 'Операционный поток / долг', weight: 10,
    good: 0.35, bad: 0.03, higherBetter: true,
  },
  {
    key: 'revenueGrowth', label: 'Рост выручки год к году', weight: 7,
    good: 0.2, bad: -0.1, higherBetter: true,
  },
  {
    key: 'receivableDays', label: 'Оборачиваемость дебиторки, дней', weight: 5,
    good: 30, bad: 120, higherBetter: false,
  },
];

const RATING_CLASSES = [
  { grade: 'AAA', min: 85, pd: 0.0005 },
  { grade: 'AA', min: 75, pd: 0.001 },
  { grade: 'A', min: 65, pd: 0.003 },
  { grade: 'BBB', min: 55, pd: 0.01 },
  { grade: 'BB', min: 45, pd: 0.03 },
  { grade: 'B', min: 33, pd: 0.08 },
  { grade: 'CCC', min: 20, pd: 0.25 },
  { grade: 'D', min: 0, pd: 1 },
];

/**
 * Внутренний рейтинг заёмщика-юрлица по отчётности.
 *
 * Это не рейтинг агентства и не решение: шкала и пороги — внутренние, их
 * утверждает риск-комитет. Считаем коэффициенты, переводим каждый в баллы 0–100
 * по «якорям» (плохо/хорошо), взвешиваем, получаем класс и ориентир лимита.
 */
export function rateCompany(input, options = {}) {
  const numeric = (name) => toNumber(input[name]);
  const revenue = numeric('revenue');
  if (revenue === null || revenue <= 0) {
    throw new Error('Нужна выручка (revenue) больше нуля: без неё коэффициенты не считаются.');
  }
  const assets = numeric('assets') ?? 0;
  const equity = numeric('equity') ?? 0;
  const currentAssets = numeric('currentAssets') ?? 0;
  const inventory = numeric('inventory') ?? 0;
  const receivables = numeric('receivables') ?? 0;
  const currentLiabilities = numeric('currentLiabilities') ?? 0;
  const totalDebt = numeric('totalDebt') ?? 0;
  const ebitda = numeric('ebitda') ?? 0;
  const interestExpense = numeric('interestExpense') ?? 0;
  const netIncome = numeric('netIncome') ?? 0;
  const cfo = numeric('cfo') ?? 0;
  const priorRevenue = numeric('priorRevenue');

  const safeDiv = (a, b) => (b > 0 ? a / b : null);
  const ratios = {
    currentRatio: safeDiv(currentAssets, currentLiabilities),
    quickRatio: safeDiv(currentAssets - inventory, currentLiabilities),
    equityRatio: safeDiv(equity, assets),
    debtToEbitda: ebitda > 0 ? safeDiv(totalDebt, ebitda) : (totalDebt > 0 ? null : 0),
    interestCoverage: interestExpense > 0 ? safeDiv(ebitda, interestExpense) : null,
    ebitdaMargin: safeDiv(ebitda, revenue),
    roa: safeDiv(netIncome, assets),
    cfoToDebt: totalDebt > 0 ? safeDiv(cfo, totalDebt) : (cfo > 0 ? 1 : 0),
    revenueGrowth: priorRevenue && priorRevenue > 0 ? revenue / priorRevenue - 1 : null,
    receivableDays: safeDiv(receivables, revenue) === null ? null : (receivables / revenue) * 365,
  };

  const rows = [];
  let weighted = 0;
  let weightSum = 0;
  for (const rule of RATIO_RULES) {
    const value = ratios[rule.key];
    let points = null;
    if (value !== null && Number.isFinite(value)) {
      const span = rule.higherBetter ? rule.good - rule.bad : rule.bad - rule.good;
      const raw = rule.higherBetter ? (value - rule.bad) / span : (rule.bad - value) / span;
      points = clamp(raw, 0, 1) * 100;
      weighted += points * rule.weight;
      weightSum += rule.weight;
    }
    rows.push({
      key: rule.key,
      label: rule.label,
      value: value === null ? null : round(value, 3),
      points: points === null ? null : Math.round(points),
      weight: rule.weight,
      good: rule.good,
      bad: rule.bad,
      higherBetter: rule.higherBetter,
    });
  }
  const score = weightSum ? Math.round(weighted / weightSum) : 0;
  const rating = RATING_CLASSES.find((item) => score >= item.min) || RATING_CLASSES[RATING_CLASSES.length - 1];

  /* Ориентир лимита: 2× EBITDA минус долг, но не больше 30% выручки и не
     больше капитала. Числа — политика, а не физика: фиксируем как принятое
     внутри сервиса правило и показываем в отчёте. */
  const limitByDebt = ebitda > 0 ? Math.max(0, 2 * ebitda - totalDebt) : 0;
  const limitByRevenue = revenue * 0.3 * (rating.min / 100);
  const limitByEquity = Math.max(0, equity) * 0.5;
  const recommendedLimit = Math.round(Math.min(limitByDebt, limitByRevenue, limitByEquity));

  const flags = [];
  if (ebitda < 0) flags.push('Отрицательная EBITDA: обслуживание долга из прибыли невозможно.');
  if (equity < 0) flags.push('Отрицательный капитал: компания технически неплатёжеспособна.');
  if (ratios.currentRatio !== null && ratios.currentRatio < 1) flags.push('Краткосрочные обязательства больше оборотных активов.');
  if (ratios.interestCoverage !== null && ratios.interestCoverage < 1.5) flags.push('EBITDA не покрывает проценты с запасом: риск просрочки по платежам.');
  if (ratios.debtToEbitda === null && totalDebt > 0) flags.push('Долг есть, EBITDA ≤ 0: долговая нагрузка не измеряется.');
  else if (ratios.debtToEbitda !== null && ratios.debtToEbitda > 5) flags.push(`Долг/EBITDA ${round(ratios.debtToEbitda, 1)} — выше 5, это высокая нагрузка.`);
  if (cfo < 0) flags.push('Отрицательный операционный поток: прибыль может быть бумажной.');
  if (ratios.revenueGrowth !== null && ratios.revenueGrowth < -0.15) flags.push(`Выручка падает (${Math.round(ratios.revenueGrowth * 100)}% г/г).`);
  if (ratios.receivableDays !== null && ratios.receivableDays > 90) flags.push(`Дебиторка ${Math.round(ratios.receivableDays)} дней: деньги заморожены в расчетах.`);

  return {
    score,
    grade: rating.grade,
    pd: rating.pd,
    weightsUsed: round(weightSum, 0),
    ratios: rows,
    flags,
    recommendedLimit,
    limitBasis: { byDebt: Math.round(limitByDebt), byRevenue: Math.round(limitByRevenue), byEquity: Math.round(limitByEquity) },
    scale: 'Внутренняя шкала сервиса (AAA…D), не рейтинг агентства и не решение о выдаче.',
  };
}

/* ------------------------------- вывод ---------------------------------- */

/** Число для человека: запятая, разряды через пробел, без хвостовых нулей. */
function num(value, digits = 2) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—';
  const fixed = Math.abs(Number(value)).toFixed(digits);
  const [whole, fraction] = fixed.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, '\u00A0');
  const sign = Number(value) < 0 ? '-' : '';
  return `${sign}${grouped}${fraction && Number(fraction) !== 0 ? `,${fraction}` : ''}`;
}

/** Разрядность по величине: 0,2 на два знака, 36,5 на один, 230 на ноль. */
function smartNum(value) {
  if (value === null || !Number.isFinite(Number(value))) return '—';
  const size = Math.abs(Number(value));
  return num(value, size >= 100 ? 0 : size >= 10 ? 1 : 2);
}

/** Деньги в масштабе: «230 млн», «1,2 млрд», «850 тыс.». */
function money(value) {
  if (value === null || !Number.isFinite(Number(value))) return '—';
  const size = Math.abs(Number(value));
  if (size >= 1e9) return `${num(Number(value) / 1e9, 1)} млрд`;
  if (size >= 1e6) return `${num(Number(value) / 1e6, 0)} млн`;
  if (size >= 1e3) return `${num(Number(value) / 1e3, 0)} тыс.`;
  return num(value, 0);
}

const pct = (value, digits = 1) => (value === null ? '—' : `${num(Number(value) * 100, digits)}%`);

/** «1 балл», «3 балла», «12 баллов» — карту читают люди, а не робот. */
function points(count) {
  const size = Math.abs(Number(count));
  const tail = size % 100 >= 11 && size % 100 <= 14 ? 'баллов' : size % 10 === 1 ? 'балл' : size % 10 >= 2 && size % 10 <= 4 ? 'балла' : 'баллов';
  return `${Number(count) > 0 ? '+' : ''}${num(count, 0)} ${tail}`;
}
const RISK_GROUPS = ['низкий риск', 'ниже среднего', 'средний', 'выше среднего', 'высокий риск'];

/** Текст для модели: коротко, но с числами, которые пойдут в документ. */
export function formatScorecard(result) {
  const lines = [];
  lines.push(`Скоринговая модель по ${num(result.rows, 0)} заявкам (обучение ${num(result.trainRows, 0)}, отложенная ${num(result.validRows, 0)}, дефолтов ${pct(result.badRate)}).`);
  lines.push('');
  lines.push('Качество на отложенной выборке:');
  lines.push(`- AUC ${num(result.metrics.aucValid, 3)} (на обучении ${num(result.metrics.aucTrain, 3)}), Gini ${num(result.metrics.giniValid, 3)}`);
  lines.push(`- KS ${num(result.metrics.ksValid, 3)} на пороге PD ${pct(result.metrics.ksPd)}`);
  lines.push(`- PSI ${num(result.metrics.psi, 3)} — ${result.metrics.psiVerdict}`);
  lines.push('- калибровка (прогноз против факта по группам риска):');
  result.calibration.forEach((row, index) => {
    const name = result.calibration.length === RISK_GROUPS.length ? RISK_GROUPS[index] : `группа ${index + 1}`;
    lines.push(`    ${name}: прогноз ${pct(row.avgPd)}, факт ${pct(row.actual)}`);
  });
  lines.push('');
  lines.push('Признаки в модели (IV — информативность признака):');
  for (const feature of result.features) {
    const kind = feature.kind === 'numeric' ? 'числовой' : 'категориальный';
    lines.push(`- ${feature.name}, ${kind}: IV ${num(feature.iv, 3)}, корзин ${feature.bins}`);
  }
  if (result.rejected.length) lines.push(`- отброшены как слабые: ${result.rejected.map((item) => `${item.name} (IV ${num(item.iv, 3)})`).join(', ')}`);
  lines.push('');
  lines.push('Карта баллов (вклад корзины в итоговый балл):');
  for (const feature of result.scorecard) {
    lines.push(`- ${feature.feature} (коэффициент ${num(feature.coefficient, 3)}):`);
    for (const bin of feature.bins) {
      lines.push(`    ${bin.label}: ${points(bin.points)}, заявок ${pct(bin.share)}, плохих ${pct(bin.badRate)}`);
    }
  }
  lines.push('');
  lines.push(`Шкала: ${num(result.scale.baseScore, 0)} баллов при шансах ${num(result.scale.baseOdds, 0)}:1, PDO ${num(result.scale.pdo, 0)} — ${num(result.scale.factor, 2)} балла на удвоение шансов.`);
  lines.push('');
  lines.push('Отсечка по деньгам (margin — прибыль с хорошей заявки, lgd — потеря с плохой):');
  const shown = [];
  for (const target of [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1]) {
    let closest = null;
    for (const row of result.cutoffs) {
      if (shown.includes(row)) continue;
      if (!closest || Math.abs(row.share - target) < Math.abs(closest.share - target)) closest = row;
    }
    if (closest) shown.push(closest);
  }
  for (const row of shown) {
    lines.push(`- одобряем ${pct(row.share, 0)}: балл от ${num(row.cutoffScore, 0)}, плохих среди одобренных ${pct(row.badRate)}, ${num(row.profitPerApplication, 2)} на заявку`);
  }
  lines.push(`Лучший порог: одобряем ${pct(result.bestCutoff.share, 0)}, балл от ${num(result.bestCutoff.cutoffScore, 0)}, прибыль ${num(result.bestCutoff.profitPerApplication, 2)} на заявку (${num(result.bestCutoff.profit, 0)} на выборке).`);
  if (result.bestCutoff.profit <= 0) {
    lines.push('Внимание: при заданных margin и lgd одобрение не приносит прибыли ни при одном пороге — пересмотрите ставку, срок или цену риска.');
  }
  lines.push('');
  lines.push('Полосы рейтинга (A — лучшая):');
  for (const band of result.bands) {
    const range = band.scoreFrom === null ? '—' : `${num(band.scoreFrom, 0)}–${num(band.scoreTo, 0)}`;
    lines.push(`- ${band.grade}: балл ${range}, доля ${pct(band.share, 0)}, средний PD ${pct(band.avgPd)}, фактически плохих ${pct(band.observedBadRate)}`);
  }
  if (result.warnings.length) {
    lines.push('');
    lines.push('Что проверить человеку:');
    for (const warning of result.warnings) lines.push(`- ${warning}`);
  }
  lines.push('');
  lines.push('Это карта баллов и метрики, а не разрешение выдавать кредит: признаки, отсечки и полосы утверждает риск-комитет, документ модели пишет человек.');
  return lines.join('\n');
}

export function formatCompanyRating(result) {
  const lines = [];
  lines.push(`Внутренний рейтинг: ${result.grade}, балл ${num(result.score, 0)} из 100, ориентир PD ${pct(result.pd, 2)}.`);
  lines.push('');
  lines.push('Коэффициенты (балл 0–100 и вес в итоговом балле):');
  for (const row of result.ratios) {
    const value = row.value === null ? '—' : smartNum(row.value);
    const points = row.points === null ? '—' : num(row.points, 0);
    lines.push(`- ${row.label}: ${value}, балл ${points}, вес ${num(row.weight, 0)}`);
  }
  lines.push('');
  lines.push(`Ориентир лимита: ${money(result.recommendedLimit)} — по долгу ${money(result.limitBasis.byDebt)}, по выручке ${money(result.limitBasis.byRevenue)}, по капиталу ${money(result.limitBasis.byEquity)}.`);
  if (result.flags.length) {
    lines.push('');
    lines.push('Красные флаги:');
    for (const flag of result.flags) lines.push(`- ${flag}`);
  }
  lines.push('');
  lines.push(result.scale);
  return lines.join('\n');
}
