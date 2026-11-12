/* Проверка своих тем «Top news»: дата по Минску, кеш на сутки, потолок в две
   новости, состояние «собирается» и уборка старых дней.

   Сеть и модель не нужны: поиск и редактор подменяются заглушками через
   `deps` — это тот же путь сборки, только без платных вызовов.

   Запуск: node test/topnews-personal.mjs */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshow-topnews-personal-'));
process.env.DSHOW_DATA_DIR = dataDir;
process.env.DSHOW_TOPNEWS_SCHEDULE = '0';
process.env.DSHOW_DEEPSEEK_KEY = '';
process.env.DEEPSEEK_API_KEY = '';

const personal = await import('../src/topnews-personal.mjs');

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

function same(actual, expected) {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

/* Журнал ловим, чтобы проверить предупреждения, но не засорять вывод. */
const warnings = [];
const originalWarn = console.warn;
function captureWarnings() {
  warnings.length = 0;
  console.warn = (...args) => warnings.push(args.join(' '));
}
function restoreWarnings() {
  console.warn = originalWarn;
}

/* --- Заглушки ------------------------------------------------------ */
const AT = new Date('2026-11-09T09:00:00.000Z'); // 12:00 по Минску
const DAY = '2026-11-09';

function candidate({ title, url, site, hoursAgo = 3 }) {
  return {
    title,
    summary: 'Содержательное описание новости, которого хватает для проверки блока.',
    url,
    site,
    publishedAt: new Date(AT.getTime() - hoursAgo * 3600000).toISOString(),
    authority: 2,
    provider: 'search',
  };
}

const threeStories = [
  candidate({
    title: 'Первая новость своей темы с сайта один',
    url: 'https://one.example/news/2026/11/pervaya-novost',
    site: 'Первый',
  }),
  candidate({
    title: 'Вторая новость своей темы с сайта два',
    url: 'https://two.example/news/2026/11/vtoraya-novost',
    site: 'Второй',
    hoursAgo: 5,
  }),
  candidate({
    title: 'Третья новость своей темы с сайта три',
    url: 'https://three.example/news/2026/11/tretya-novost',
    site: 'Третий',
    hoursAgo: 7,
  }),
];

/** Считающий поиск: возвращает заданный список и запоминает число вызовов. */
function makeSearch(items) {
  let calls = 0;
  const search = async () => {
    calls += 1;
    if (items instanceof Error) throw items;
    return items;
  };
  search.calls = () => calls;
  return search;
}

/** Редактор выбирает первые `count` кандидатов — как настоящий, но без модели. */
function makeEditor(count = 2) {
  let calls = 0;
  const editor = async (dateKey, byCategory) => {
    calls += 1;
    const id = Object.keys(byCategory)[0];
    const list = byCategory[id] || [];
    return {
      [id]: list.slice(0, count).map((item) => ({
        candidate: item.id,
        headline: `Выбранная редактором новость номер ${item.id}`,
        summary: 'Суть выбранной новости, пересказанная редактором для читателя.',
        importance: 90,
      })),
    };
  };
  editor.calls = () => calls;
  return editor;
}

function topic(id, extra = {}) {
  return {
    id,
    title: 'Своя тема',
    kicker: 'своя тема',
    tone: 'blue',
    query: 'что нового по своей теме',
    ...extra,
  };
}

const cacheFile = (userId, day = DAY) => path.join(personal.PERSONAL_DIR, userId, `${day}.json`);

function writeCache(userId, payload, day = DAY) {
  const file = cacheFile(userId, day);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(payload));
  return file;
}

/* --- Дата по Минску ------------------------------------------------- */
check('23:30 в Минске — ещё сегодняшний день', personal.dateKeyNow(new Date('2026-11-09T20:30:00.000Z')) === '2026-11-09');
check(
  '00:30 в Минске — уже следующие сутки',
  personal.dateKeyNow(new Date('2026-11-09T21:30:00.000Z')) === '2026-11-10',
  personal.dateKeyNow(new Date('2026-11-09T21:30:00.000Z')),
);
check(
  'по UTC день был бы другим — кеш живёт по Минску',
  personal.dateKeyNow(new Date('2026-11-09T22:00:00.000Z')) === '2026-11-10' &&
    new Date('2026-11-09T22:00:00.000Z').toISOString().slice(0, 10) === '2026-11-09',
);
check(
  'без даты возвращается сегодняшний ключ',
  /^\d{4}-\d{2}-\d{2}$/.test(personal.dateKeyNow()),
  personal.dateKeyNow(),
);
check(
  'кривая дата не ломает функцию',
  /^\d{4}-\d{2}-\d{2}$/.test(personal.dateKeyNow('не дата')),
  personal.dateKeyNow('не дата'),
);

/* --- Пустой кеш ----------------------------------------------------- */
check('кеша нет — пустой список', same(personal.readPersonalBlocks('fresh-user', DAY), []));
check('кеш несуществующего пользователя тоже пуст', same(personal.readPersonalBlocks('', DAY), []));
check('не дата вместо дня — пустой список', same(personal.readPersonalBlocks('fresh-user', '../etc'), []));

/* --- Сборка блока --------------------------------------------------- */
const first = await personal.buildPersonalBlocks('u-1', [topic('own-1')], {
  now: AT,
  deps: { search: makeSearch(threeStories), editor: makeEditor(2) },
});
check('блок собрался', first.length === 1 && first[0].status === 'ready', JSON.stringify(first.map((b) => b.status)));
check('в блоке ровно две новости', first[0]?.items?.length === 2, String(first[0]?.items?.length));
check(
  'поля блока — ровно те, что обещаны разделу',
  same(Object.keys(first[0] || {}).sort(), ['items', 'kicker', 'status', 'title', 'tone', 'topicId']),
);
check('тема блока совпадает с темой пользователя', first[0]?.topicId === 'own-1');
check(
  'у каждой новости есть ссылка на первоисточник',
  (first[0]?.items || []).every((item) => /^https?:\/\//i.test(item.url)),
);
check('ранги новостей — 1 и 2', same(first[0]?.items?.map((item) => item.rank), [1, 2]));
check('кеш записан на сегодня', fs.existsSync(cacheFile('u-1')));
const cachedFile = JSON.parse(fs.readFileSync(cacheFile('u-1'), 'utf8'));
check('в файле есть дата и время сборки', cachedFile.dateKey === DAY && typeof cachedFile.builtAt === 'string');
check('в файле — одна тема', Array.isArray(cachedFile.blocks) && cachedFile.blocks.length === 1);
check(
  'чтение отдаёт то же, что сборка',
  same(personal.readPersonalBlocks('u-1', DAY), first),
);

/* Кеш на сутки: второй раз ничего не ищет и не спрашивает редактора. */
const countingSearch = makeSearch(threeStories);
const countingEditor = makeEditor(2);
const again = await personal.buildPersonalBlocks('u-1', [topic('own-1')], {
  now: AT,
  deps: { search: countingSearch, editor: countingEditor },
});
check('повторный заход берёт кеш', again.length === 1 && again[0].status === 'ready');
check('повторный заход не ходит в поиск', countingSearch.calls() === 0, String(countingSearch.calls()));
check('повторный заход не зовёт редактора', countingEditor.calls() === 0, String(countingEditor.calls()));

/* Пустой кеш «сегодня» не мешает вчерашнему: читаем по дню явно. */
check('вчерашнего кеша нет', same(personal.readPersonalBlocks('u-1', '2026-11-08'), []));

/* --- Потолок в две новости ----------------------------------------- */
const greedy = await personal.buildPersonalBlocks('u-2', [topic('own-2')], {
  now: AT,
  deps: { search: makeSearch(threeStories), editor: makeEditor(3) },
});
check(
  'редактор выбрал три — в блок всё равно попало две',
  greedy[0]?.items?.length === 2,
  String(greedy[0]?.items?.length),
);
check('сверх двух новостей в кеше тоже нет', JSON.parse(fs.readFileSync(cacheFile('u-2'), 'utf8')).blocks[0].items.length === 2);

/* --- Недобор и отказы ---------------------------------------------- */
const lonely = await personal.buildPersonalBlocks('u-3', [topic('own-3')], {
  now: AT,
  deps: { search: makeSearch(threeStories.slice(0, 1)), editor: makeEditor(2) },
});
check('одной новости мало — блок пустой', lonely[0]?.status === 'empty' && lonely[0]?.items?.length === 0);

captureWarnings();
const broken = await personal.buildPersonalBlocks('u-4', [topic('own-4')], {
  now: AT,
  deps: { search: makeSearch(new Error('поиск недоступен')), editor: makeEditor(2) },
});
restoreWarnings();
check('падение поиска не роняет раздел', broken.length === 1 && broken[0].status === 'empty');
check(
  'причина падения записана в журнал',
  warnings.some((line) => line.includes('своя тема')),
  warnings[0] || '—',
);

const quietSearch = makeSearch(threeStories);
captureWarnings();
const noQuery = await personal.buildPersonalBlocks('u-5', [topic('own-5', { query: '' })], {
  now: AT,
  deps: { search: quietSearch, editor: makeEditor(2) },
});
restoreWarnings();
check('тема без запроса — пустой блок', noQuery[0]?.status === 'empty');
check('тема без запроса не ищется в интернете', quietSearch.calls() === 0);

const noLinkSearch = makeSearch([
  candidate({ title: 'Новость без нормальной ссылки', url: 'ftp://files.example/a', site: 'Файлы' }),
  ...threeStories,
]);
const noLink = await personal.buildPersonalBlocks('u-6', [topic('own-6')], {
  now: AT,
  deps: { search: noLinkSearch, editor: makeEditor(2) },
});
check(
  'кандидат без http-ссылки отброшен',
  noLink[0]?.items?.length === 2 && noLink[0].items.every((item) => /^https?:\/\//i.test(item.url)),
);

/* --- Пустой список тем --------------------------------------------- */
const none = await personal.buildPersonalBlocks('u-empty', []);
check('нет своих тем — сразу пустой ответ', same(none, []));
check('и каталог не создаётся', !fs.existsSync(path.join(personal.PERSONAL_DIR, 'u-empty')));
check('без идентификатора пользователя сборки нет', same(await personal.buildPersonalBlocks('', [topic('own-x')]), []));

/* --- Состояние «собирается» ---------------------------------------- */
let release;
const gate = new Promise((resolve) => {
  release = resolve;
});
const slowSearch = async () => {
  await gate;
  return threeStories;
};
const running = personal.buildPersonalBlocks('u-7', [topic('own-7')], {
  now: AT,
  deps: { search: slowSearch, editor: makeEditor(2) },
});
const duringBuild = personal.readPersonalBlocks('u-7', DAY);
check('пока идёт сборка, экран видит «собирается»', duringBuild[0]?.status === 'building', JSON.stringify(duringBuild));
check(
  'метка начала сборки наружу не уходит',
  same(Object.keys(duringBuild[0] || {}).sort(), ['items', 'kicker', 'status', 'title', 'tone', 'topicId']),
);
check('состояние сборки видно снаружи', personal.isBuilding('u-7') === true);
release();
const finished = await running;
check('после сборки блок готов', finished[0]?.status === 'ready' && finished[0].items.length === 2);
check('после сборки состояние снято', personal.isBuilding('u-7') === false);

/* Перезапуск сервиса посреди сборки: запись «собирается» осталась в кеше, но
   собирать уже некому. Раздел должен увидеть пустоту и запустить сборку заново,
   а не показывать «собираем…» до полуночи. */
writeCache('u-11', {
  dateKey: DAY,
  builtAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
  blocks: [
    {
      topicId: 'own-11',
      title: 'Своя тема',
      kicker: 'своя тема',
      tone: 'blue',
      status: 'building',
      items: [],
      buildingAt: new Date(Date.now() - 40 * 60 * 1000).toISOString(),
    },
    {
      topicId: 'own-12',
      title: 'Своя тема',
      kicker: 'своя тема',
      tone: 'blue',
      status: 'ready',
      items: threeStories.slice(0, 2).map((item, index) => ({
        rank: index + 1,
        headline: item.title,
        summary: 'Суть.',
        source: 'Тест',
        url: item.url,
        publishedAt: item.publishedAt,
      })),
    },
  ],
});
const afterRestart = personal.readPersonalBlocks('u-11', DAY);
check(
  'протухшее «собирается» считается отсутствующим',
  afterRestart.length === 1 && afterRestart[0].topicId === 'own-12',
  afterRestart.map((block) => `${block.topicId}:${block.status}`).join(', '),
);
const restartSearch = makeSearch(threeStories);
const afterRestartBuild = await personal.buildPersonalBlocks('u-11', [topic('own-11'), topic('own-12')], {
  now: AT,
  deps: { search: restartSearch, editor: makeEditor(2) },
});
check('после перезапуска тема собирается заново', restartSearch.calls() === 1, String(restartSearch.calls()));
check(
  'вторая тема берётся из кеша, а не собирается снова',
  afterRestartBuild.length === 2 && afterRestartBuild.every((block) => block.status === 'ready'),
);

writeCache('u-13', {
  dateKey: DAY,
  builtAt: '',
  blocks: [{ topicId: 'own-13', title: 'Т', kicker: '', tone: 'blue', status: 'building', items: [] }],
});
check('«собирается» без метки тоже считается протухшим', same(personal.readPersonalBlocks('u-13', DAY), []));

/* --- Параллельные заходы ------------------------------------------- */
let sharedCalls = 0;
let openGate;
const sharedGate = new Promise((resolve) => {
  openGate = resolve;
});
const parallelSearch = async () => {
  sharedCalls += 1;
  await sharedGate;
  return threeStories;
};
const firstCall = personal.buildPersonalBlocks('u-8', [topic('own-8')], {
  now: AT,
  deps: { search: parallelSearch, editor: makeEditor(2) },
});
const secondCall = personal.buildPersonalBlocks('u-8', [topic('own-8')], {
  now: AT,
  deps: { search: parallelSearch, editor: makeEditor(2) },
});
openGate();
const [one, two] = await Promise.all([firstCall, secondCall]);
check('два одновременных запроса дают один поиск', sharedCalls === 1, String(sharedCalls));
check('оба запроса получают готовый блок', one[0]?.status === 'ready' && two[0]?.status === 'ready');
check('второй отдаёт те же новости', same(one[0].items.map((item) => item.url), two[0].items.map((item) => item.url)));

/* --- Уборка кеша --------------------------------------------------- */
check('удаление темы чистит кеш', personal.clearPersonalCache('u-1', 'own-1') === true);
check('после удаления блок не читается', same(personal.readPersonalBlocks('u-1', DAY), []));
check('повторное удаление ничего не делает', personal.clearPersonalCache('u-1', 'own-1') === false);
check('удаление чужой темы не трогает кеш', personal.clearPersonalCache('u-1', 'own-чужой') === false && fs.existsSync(cacheFile('u-2')));

/* Тема собирается заново после удаления кеша, а не отдаётся из памяти. */
const rebuiltSearch = makeSearch(threeStories);
const rebuilt = await personal.buildPersonalBlocks('u-1', [topic('own-1')], {
  now: AT,
  deps: { search: rebuiltSearch, editor: makeEditor(2) },
});
check('после удаления кеша тема собирается заново', rebuilt[0]?.status === 'ready' && rebuiltSearch.calls() === 1);

personal.clearPersonalCache('u-2');
check('без темы удаляется весь кеш пользователя', !fs.existsSync(cacheFile('u-2')) && same(personal.readPersonalBlocks('u-2', DAY), []));

/* --- Три дня кеша -------------------------------------------------- */
fs.mkdirSync(path.join(personal.PERSONAL_DIR, 'u-9'), { recursive: true });
const oldPayload = JSON.stringify({ dateKey: '2026-11-06', builtAt: '', blocks: [] });
fs.writeFileSync(path.join(personal.PERSONAL_DIR, 'u-9', '2026-11-06.json'), oldPayload);
fs.writeFileSync(path.join(personal.PERSONAL_DIR, 'u-9', '2026-11-07.json'), oldPayload);
fs.writeFileSync(path.join(personal.PERSONAL_DIR, 'u-9', '2026-11-08.json'), oldPayload);
await personal.buildPersonalBlocks('u-9', [topic('own-9')], {
  now: AT,
  deps: { search: makeSearch(threeStories), editor: makeEditor(2) },
});
check('кеш старше трёх суток удалён', !fs.existsSync(path.join(personal.PERSONAL_DIR, 'u-9', '2026-11-06.json')));
check(
  'кеш за последние два дня сохранён',
  fs.existsSync(path.join(personal.PERSONAL_DIR, 'u-9', '2026-11-07.json')) &&
    fs.existsSync(path.join(personal.PERSONAL_DIR, 'u-9', '2026-11-08.json')),
);
check('сегодняшний кеш на месте', fs.existsSync(path.join(personal.PERSONAL_DIR, 'u-9', `${DAY}.json`)));

/* --- Кеш собран не нами: не доверяем слепо ------------------------ */
const spoiled = {
  dateKey: DAY,
  builtAt: '',
  blocks: [
    { topicId: 'own-a', title: 'Т', kicker: '', tone: 'blue', status: 'ready', items: threeStories.map((item) => ({ headline: item.title, summary: 'Суть.', source: 'Тест', url: item.url, publishedAt: item.publishedAt, rank: 0 })) },
    { topicId: 'own-b', title: 'Т', kicker: '', tone: 'blue', status: 'ready', items: [{ headline: 'Одна новость без пары', summary: '', source: 'Тест', url: 'https://one.example/news/2026/11/odna', publishedAt: null, rank: 1 }] },
    { topicId: 'own-c', title: 'Т', kicker: '', tone: 'не тон', status: 'ready', items: [{ headline: 'Новость без ссылки вообще', summary: '', source: 'Тест', url: '', publishedAt: null, rank: 1 }, { headline: 'Вторая новость без ссылки', summary: '', source: 'Тест', url: 'not-a-url', publishedAt: null, rank: 2 }] },
  ],
};
writeCache('u-10', spoiled);
const safeRead = personal.readPersonalBlocks('u-10', DAY);
check('из чужого кеша берётся не больше двух новостей', safeRead[0]?.items?.length === 2, String(safeRead[0]?.items?.length));
check('блок с одной новостью считается пустым', safeRead[1]?.status === 'empty' && safeRead[1]?.items?.length === 0);
check('блок без ссылок пуст', safeRead[2]?.status === 'empty');
check('незнакомый тон заменяется на золотой', safeRead[2]?.tone === 'gold', safeRead[2]?.tone);

/* --- Итог ---------------------------------------------------------- */
const failed = results.filter((item) => !item.ok);
fs.rmSync(dataDir, { recursive: true, force: true });
console.log(`\n${results.length - failed.length}/${results.length} проверок пройдено`);
if (failed.length) process.exitCode = 1;
