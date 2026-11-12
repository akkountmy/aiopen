/**
 * Проверка ускоренной цепочки распознавания изображений (offline).
 *
 * Что проверяем:
 *  1. Модели спрашиваются параллельно: первая ответившая даёт результат, а
 *     остальные не ждутся.
 *  2. Всё упало — уходим в резерв, и это занимает секунды, а не сотню секунд.
 *  3. После серии падений модели «остывают»: следующий снимок идёт сразу в
 *     резерв, без единого запроса к бесплатным моделям.
 *  4. Успешная модель поднимается в начало очереди.
 *
 * Сеть подменяется: тест не ходит в интернет и не требует ключей.
 *   node test/vision-chain.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshow-vision-chain-'));
process.env.DSHOW_DATA_DIR = dataDir;
/* Ключи фиктивные: важно только то, что они есть. */
process.env.OPENROUTER_API_KEY = 'test-openrouter';
process.env.DSHOW_DEEPSEEK_KEY = 'test-main';

const ok = [];
const bad = [];
function check(name, condition, detail = '') {
  if (condition) ok.push(name);
  else bad.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

const calls = [];
let behaviour = () => ({ kind: 'fail', error: new Error('fetch failed') });

globalThis.fetch = async (url, init = {}) => {
  const body = init.body ? JSON.parse(String(init.body)) : {};
  const model = body.model || '';
  const target = String(url);
  calls.push({ url: target, model, at: Date.now() });
  const plan = behaviour({ url: target, model });
  if (plan.kind === 'hang') {
    /* Висим, пока нас не прервут по AbortSignal — как настоящая мёртвая модель. */
    return await new Promise((resolve, reject) => {
      const signal = init.signal;
      if (signal) {
        if (signal.aborted) return reject(new Error('aborted'));
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      }
      setTimeout(() => resolve(plan), 60000);
    });
  }
  await new Promise((resolve) => setTimeout(resolve, plan.delay || 5));
  if (plan.kind === 'fail') throw plan.error;
  return {
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content: plan.text || 'текст со снимка' } }] }),
    text: async () => '',
  };
};

const { describeImage, orderVisionModels } = await import('../src/vision.mjs');

const image = (tag) => Buffer.concat([Buffer.from(`fake-${tag}:`), Buffer.alloc(64, tag.charCodeAt(0) % 250)]);

/* --- 1. Гонка: медленная модель висит, быстрая отвечает ------------------- */
behaviour = ({ model }) => {
  if (model.includes('dots') || model.includes('qwen')) return { kind: 'hang' };
  return { kind: 'ok', text: 'распознано быстро', delay: 5 };
};
calls.length = 0;
const started = Date.now();
const fast = await describeImage({ buffer: image('race'), mime: 'image/png', name: 'race.png' });
const raceMs = Date.now() - started;
check('гонка вернула результат', fast.provider === 'free' && /распознано/.test(fast.text), fast.provider);
check('результат за секунды, а не за минуту', raceMs < 8000, `${raceMs} мс`);
check('в полёте было не больше трёх моделей', calls.length <= 3, `запросов: ${calls.length}`);

/* --- 2. Успешная модель поднялась в начало очереди ------------------------- */
const ordered = orderVisionModels();
check('успешная модель первая', ordered[0].model === fast.model, `${ordered[0].model} vs ${fast.model}`);
check('успешная модель не остывает', ordered[0].cooling === false);

/* --- 3. Все бесплатные упали — резерв, и быстро --------------------------- */
behaviour = ({ url }) => {
  if (url.includes('deepseek') || url.includes('api.deepseek.com')) {
    return { kind: 'ok', text: 'ответ основной модели', delay: 5 };
  }
  return { kind: 'fail', error: new Error('fetch failed') };
};
calls.length = 0;
const startedFallback = Date.now();
const fallback = await describeImage({ buffer: image('down'), mime: 'image/png', name: 'down.png' });
const fallbackMs = Date.now() - startedFallback;
check('резерв сработал', fallback.provider === 'fallback', fallback.provider);
check('резерв уложился в секунды', fallbackMs < 15000, `${fallbackMs} мс`);

/* --- 4. Остывание: следующий снимок идёт сразу в резерв ------------------- */
calls.length = 0;
const startedCool = Date.now();
const after = await describeImage({ buffer: image('cool'), mime: 'image/png', name: 'cool.png' });
const coolMs = Date.now() - startedCool;
const freeCalls = calls.filter((item) => !item.url.includes('deepseek')).length;
check('после падений бесплатные модели не спрашиваются', freeCalls === 0, `запросов к бесплатным: ${freeCalls}`);
check('остывший путь тоже даёт результат', after.provider === 'fallback' && after.text.length > 0, after.provider);
check('остывший путь быстрый', coolMs < 8000, `${coolMs} мс`);

/* --- 5. Медленная модель не держит ответ дольше попытки ------------------- */
behaviour = () => ({ kind: 'hang' });
calls.length = 0;
const startedHang = Date.now();
const hangError = await describeImage({ buffer: image('hang'), mime: 'image/png', name: 'hang.png' }).then(
  (value) => ({ value }),
  (error) => ({ error }),
);
const hangMs = Date.now() - startedHang;
check(
  'зависшая модель упирается в предел, а не в вечность',
  Boolean(hangError.error) && hangMs < 70000,
  `${hangMs} мс`,
);

fs.rmSync(dataDir, { recursive: true, force: true });

for (const line of ok) console.log(`  ok   ${line}`);
for (const line of bad) console.log(`  FAIL ${line}`);
console.log(bad.length ? `ПРОВЕРКА НЕ ПРОЙДЕНА: ${bad.length}` : `ПРОВЕРКА ПРОЙДЕНА: ${ok.length} проверок`);
process.exit(bad.length ? 1 : 0);
