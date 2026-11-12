/* Проверка «Top news»: расписание, выбор редактора, состав выпуска и
   тумблер в хранилище. Сеть и модель не нужны — проверяем чистые функции.

   Запуск: node test/topnews.mjs */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshow-topnews-'));
process.env.DSHOW_DATA_DIR = dataDir;
process.env.DSHOW_TOPNEWS_SCHEDULE = '0';
process.env.DSHOW_DEEPSEEK_KEY = '';
process.env.DEEPSEEK_API_KEY = '';

const topnews = await import('../src/topnews.mjs');
const { store } = await import('../src/store.mjs');

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

function same(actual, expected) {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

/* --- Время --------------------------------------------------------- */
check(
  '09.11.2026 07:00 по Минску — это 04:00 UTC',
  topnews.zonedToUtc('2026-11-09', 7) === '2026-11-09T04:00:00.000Z',
  topnews.zonedToUtc('2026-11-09', 7),
);
check('formatRuDate говорит «9 ноября»', topnews.formatRuDate('2026-11-09') === '9 ноября');

const fridayEvening = new Date('2026-11-13T15:00:00.000Z'); // 18:00 в Минске
check(
  'с вечера пятницы следующий выпуск — в понедельник 07:00',
  topnews.nextMorningIso(fridayEvening) === '2026-11-16T04:00:00.000Z',
  topnews.nextMorningIso(fridayEvening),
);
const saturdayNoon = new Date('2026-11-14T09:00:00.000Z');
check(
  'в субботу следующий выпуск — понедельник, без воскресенья',
  topnews.nextMorningIso(saturdayNoon) === '2026-11-16T04:00:00.000Z',
  topnews.nextMorningIso(saturdayNoon),
);
const mondayEarly = new Date('2026-11-09T03:00:00.000Z'); // 06:00
check(
  'в понедельник до семи утра выпуск будет сегодня',
  topnews.nextMorningIso(mondayEarly) === '2026-11-09T04:00:00.000Z',
  topnews.nextMorningIso(mondayEarly),
);
const mondayLate = new Date('2026-11-09T05:00:00.000Z'); // 08:00
check(
  'в понедельник после семи утра — во вторник',
  topnews.nextMorningIso(mondayLate) === '2026-11-10T04:00:00.000Z',
  topnews.nextMorningIso(mondayLate),
);
check(
  'в воскресенье выпуск не ставится на сегодня',
  !topnews.nextMorningIso(new Date('2026-11-15T09:00:00.000Z')).startsWith('2026-11-15'),
);

/* --- Выбор редактора ---------------------------------------------- */
const rawSelection = JSON.stringify({
  categories: [
    {
      id: 'main',
      items: [
        { candidate: 'main-1', headline: ' Первый заголовок ', summary: ' Суть ', importance: 120 },
        { candidate: 'main-2', headline: 'Второй', summary: 'Ещё', importance: 80 },
        { candidate: 'main-3', headline: 'Третий', summary: 'Лишний', importance: 70 },
      ],
    },
  ],
});
const picks = topnews.parseSelection('```json\n' + rawSelection + '\n```');
check('parseSelection снимает markdown-обёртку', Boolean(picks?.main));
check('parseSelection оставляет не больше двух новостей', picks?.main?.length === 2);
check('parseSelection ограничивает важность сотней', picks?.main?.[0]?.importance === 100);
check('parseSelection обрезает пробелы', picks?.main?.[0]?.headline === 'Первый заголовок');
check('parseSelection не падает на мусоре', topnews.parseSelection('не json') === null);

/* --- Состав выпуска ------------------------------------------------ */
function candidate(id, category, site, key = id) {
  return {
    id,
    key,
    categoryId: category,
    title: `Заголовок ${id}`,
    summary: `Короткая суть ${id}`,
    url: `https://example.com/${key}`,
    site,
    publishedAt: '2026-11-09T03:00:00.000Z',
    authority: 2,
    position: 0,
    provider: 'rss',
  };
}

const candidates = {};
for (const cat of topnews.CATEGORIES) {
  candidates[cat.id] = [
    candidate(`${cat.id}-1`, cat.id, 'Издание А'),
    candidate(`${cat.id}-2`, cat.id, 'Издание Б'),
    candidate(`${cat.id}-3`, cat.id, 'Издание В'),
  ];
}
const issue = topnews.composeIssue({
  dateKey: '2026-11-09',
  now: new Date('2026-11-09T04:00:00.000Z'),
  candidates,
});
check('в выпуске шесть тем', issue.categories.length === 6);
check('в каждой теме ровно две новости', issue.categories.every((cat) => cat.items.length === 2));
check('всего двенадцать историй', issue.stats.stories === 12);
check(
  'в выпуске есть Телеграм и Соцсети',
  issue.categories.some((cat) => cat.id === 'telegram') && issue.categories.some((cat) => cat.id === 'social'),
);
check('в блоке две разные площадки', issue.categories.every((cat) => cat.items[0].source !== cat.items[1].source));
check('дата выпуска человеческая', issue.dateLabel === '9 ноября');

const onlyOne = topnews.composeIssue({
  dateKey: '2026-11-09',
  now: new Date('2026-11-09T04:00:00.000Z'),
  candidates: { main: [candidate('main-1', 'main', 'Один')] },
});
check('тема без двух новостей пропускается', onlyOne.categories.length === 0);
check('выпуск без полного набора тем не годится', topnews.assessIssue(onlyOne).ok === false);

/* Пять блоков из шести — это выпуск, а не сбой: узкая тема не должна
   отменять весь день. Проверяем ровно тот случай, что ронял прод. */
const noSocial = {};
for (const cat of topnews.CATEGORIES) {
  if (cat.id === 'social') continue;
  noSocial[cat.id] = [candidate(`${cat.id}-1`, cat.id, 'Издание А'), candidate(`${cat.id}-2`, cat.id, 'Издание Б')];
}
const fiveOfSix = topnews.composeIssue({
  dateKey: '2026-11-09',
  now: new Date('2026-11-09T04:00:00.000Z'),
  candidates: noSocial,
});
const fiveVerdict = topnews.assessIssue(fiveOfSix);
check('выпуск без одной темы годится к показу', fiveVerdict.ok === true, JSON.stringify(fiveVerdict));
check('пропущенная тема записана в выпуске', fiveOfSix.partial === true && same(fiveOfSix.missing, ['social']));

/* Две новости про одну площадку — по-прежнему блок «Соцсети», а не дыра. */
const vkA = {
  ...candidate('social-1', 'social', 'Ведомости'),
  title: 'VK запустил новый сервис для малого бизнеса',
  summary: 'Компания открыла приём заявок на инструменты продвижения для небольших магазинов.',
};
const vkB = {
  ...candidate('social-2', 'social', 'РБК'),
  title: 'Суд оштрафовал VK за неудаление запрещённого контента',
  summary: 'Решение суда касается нескольких сообществ, материалы направлены на удаление.',
};
const samePlatform = topnews.composeIssue({
  dateKey: '2026-11-09',
  now: new Date('2026-11-09T04:00:00.000Z'),
  candidates: { social: [vkA, vkB] },
});
check(
  'две новости про одну площадку заполняют блок «Соцсети»',
  samePlatform.categories.length === 1 && samePlatform.categories[0].items.length === 2,
);

const duplicate = candidate('main-1', 'main', 'Один', 'shared-key');
const cross = topnews.composeIssue({
  dateKey: '2026-11-09',
  now: new Date('2026-11-09T04:00:00.000Z'),
  candidates: { main: [duplicate, candidate('main-2', 'main', 'Два')], world: [duplicate, candidate('world-2', 'world', 'Три')] },
});
check(
  'одна и та же история не попадает в два блока',
  cross.categories.reduce((sum, cat) => sum + cat.items.length, 0) === 2,
);

/* Телеграм-каналы пересказывают то же, о чём пишут ленты: пересказ не должен
   продублировать сюжет из «Главного», а тема должна остаться с двумя
   историями. */
const mainBudget = {
  ...candidate('main-1', 'main', 'Один'),
  title: 'Путин провел совещание по бюджету',
  summary: 'Президент обсудил параметры бюджета на следующий год с правительством.',
};
const mainRate = {
  ...candidate('main-2', 'main', 'Два'),
  title: 'ЦБ сохранил ключевую ставку',
  summary: 'Банк России оставил ставку без изменений и дал сигнал о дальнейшей политике.',
};
const tgEcho = {
  ...candidate('telegram-1', 'telegram', '@kanal'),
  title: 'Путин провел совещание по бюджету страны',
  summary: 'Канал пересказывает то же совещание о бюджете следующего года.',
};
const tgDrills = {
  ...candidate('telegram-2', 'telegram', '@news'),
  title: 'Минобороны сообщило о новых учениях',
  summary: 'Ведомство рассказало о манёврах в нескольких округах.',
};
const tgFlights = {
  ...candidate('telegram-3', 'telegram', '@city'),
  title: 'Аэропорт приостановил рейсы из-за тумана',
  summary: 'Задержано больше двадцати рейсов, пассажиров предупредили заранее.',
};
const echoIssue = topnews.composeIssue({
  dateKey: '2026-11-09',
  now: new Date('2026-11-09T04:00:00.000Z'),
  candidates: { main: [mainBudget, mainRate], telegram: [tgEcho, tgDrills, tgFlights] },
});
const tgBlock = echoIssue.categories.find((cat) => cat.id === 'telegram');
check('пересказ из канала не дублирует сюжет другой темы', Boolean(tgBlock) && !tgBlock.items.some((item) => item.headline.includes('страны')));
check('тема «Телеграм» остаётся с двумя историями', Boolean(tgBlock) && tgBlock.items.length === 2);

check(
  'тема «Телеграм» обещает посты каналов, а не новости о мессенджере',
  topnews.previewCategories().find((cat) => cat.id === 'telegram')?.kicker === 'Что пишут в каналах',
);

const nearA = {
  ...candidate('main-1', 'main', 'Один'),
  title: 'Путин провел совещание по бюджету',
  summary: 'Президент обсудил параметры бюджета на следующий год с правительством.',
};
const nearB = {
  ...candidate('main-2', 'main', 'Два'),
  title: 'Путин провел совещание по бюджету страны',
  summary: 'На совещании речь шла о доходах и расходах бюджета следующего года.',
};
const nearC = {
  ...candidate('main-3', 'main', 'Три'),
  title: 'ЦБ сохранил ключевую ставку',
  summary: 'Банк России оставил ставку без изменений и дал сигнал о дальнейшей политике.',
};
const deduped = topnews.composeIssue({
  dateKey: '2026-11-09',
  now: new Date('2026-11-09T04:00:00.000Z'),
  candidates: { main: [nearA, nearB, nearC] },
  picks: { main: [{ candidate: 'main-1' }, { candidate: 'main-2' }] },
});
check(
  'пересказ одной истории не дублируется',
  deduped.categories[0]?.items.length === 2 &&
    !deduped.categories[0].items.some((item) => item.headline.includes('страны')),
);

const summitA = { ...candidate('main-1', 'main', 'Один'), title: 'Пашинян посетит Турцию в день саммита ОДКБ в Москве' };
const summitB = { ...candidate('main-2', 'main', 'Два'), title: 'Путин 11 ноября проведет в Москве сессию Совета коллективной безопасности ОДКБ' };
const acronymDeduped = topnews.composeIssue({
  dateKey: '2026-11-09',
  now: new Date('2026-11-09T04:00:00.000Z'),
  candidates: { main: [summitA, summitB] },
});
check('два угла одного саммита считаются одной историей', acronymDeduped.categories.length === 0);

const noSummary = {
  ...candidate('main-1', 'main', 'Один'),
  title: 'Заголовок без описания',
  summary: '',
};
const withSummary = {
  ...candidate('main-2', 'main', 'Два'),
  summary: 'Достаточно длинная суть, чтобы карточка не осталась с пустым описанием.',
};
const withSummaryToo = {
  ...candidate('main-3', 'main', 'Три'),
  summary: 'Ещё одна готовая суть для замены карточки без описания в выпуске.',
};
const filled = topnews.composeIssue({
  dateKey: '2026-11-09',
  now: new Date('2026-11-09T04:00:00.000Z'),
  candidates: { main: [noSummary, withSummary, withSummaryToo] },
  picks: { main: [{ candidate: 'main-1' }, { candidate: 'main-2' }] },
});
check(
  'карточка без сути заменяется',
  filled.categories[0]?.items.length === 2 && filled.categories[0].items.every((item) => item.summary.length >= 30),
);

const withLabel = {
  ...candidate('main-1', 'main', 'Четыре'),
  title: 'Мошенники атаковали пользователей мессенджера',
  summary: 'F6: Криптоскамеры атаковали россиян предложениями помочь внешней торговле.',
};
const withLabelToo = {
  ...candidate('main-2', 'main', 'Пять'),
  title: 'Мессенджер обновил правила для каналов',
  summary: 'Новые правила касаются маркировки рекламы и работы с жалобами пользователей.',
};
const labelled = topnews.composeIssue({
  dateKey: '2026-11-09',
  now: new Date('2026-11-09T04:00:00.000Z'),
  candidates: { main: [withLabel, withLabelToo] },
  picks: { main: [{ candidate: 'main-1' }, { candidate: 'main-2' }] },
});
check(
  'служебная метка рубрики снимается',
  Boolean(labelled.categories[0]?.items[0]?.summary) && !/^[A-ZА-Я]\d{1,2}:/.test(labelled.categories[0].items[0].summary),
);

/* --- Тумблер ------------------------------------------------------- */
const first = store.topNewsSettings('new-user');
check('по умолчанию Top news выключен', first.enabled === false);
check('у нового пользователя нет записи', first.updatedAt === null);
store.setTopNewsEnabled('new-user', true);
check('включение сохраняется', store.topNewsSettings('new-user').enabled === true);
check('счётчик включённых видит пользователя', store.topNewsEnabledCount() >= 1);
store.setTopNewsEnabled('new-user', false);
check('выключение сохраняется', store.topNewsSettings('new-user').enabled === false);
check('счётчик выключенных не считает', store.topNewsEnabledCount() === 0);

const offState = await topnews.userState({ enabled: false });
check('выключенный раздел не отдаёт выпуск', offState.issue === null);
check('выключенный раздел не обещает дату', offState.nextAt === null);
check('у выключенного раздела есть превью тем', offState.preview.length === 6);
check('расписание всегда 07:00', same(offState.schedule, { hour: 7, label: '07:00' }));

/* --- Итог ---------------------------------------------------------- */
const failed = results.filter((item) => !item.ok);
fs.rmSync(dataDir, { recursive: true, force: true });
console.log(`\n${results.length - failed.length}/${results.length} проверок пройдено`);
if (failed.length) process.exitCode = 1;
