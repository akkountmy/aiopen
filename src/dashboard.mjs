/**
 * «Дашборд» — шесть постоянных заданий для предпринимателя.
 *
 * Здесь живёт только предметная часть: описания блоков, их расписания по
 * умолчанию и арифметика «когда следующий запуск». Хранение заданий — в
 * store.mjs, запуск по расписанию — в server.mjs, показ — в public/app.js.
 *
 * Почему шесть блоков именно такие: у компании со средней списочной
 * численностью около 60 работников (Республика Беларусь) руководитель каждый
 * месяц закрывает примерно один и тот же круг вопросов — закон, налоги,
 * деньги, люди, закупки и рынок. Отрасль при этом любая, поэтому тексты
 * заданий написаны так, чтобы работать без отраслевой настройки, а профиль
 * компания уточняет в постоянной памяти.
 */

/* Расписание считается по минскому времени, а не по времени контейнера:
   сервер в облаке живёт в UTC, и «9 утра» без часового пояса уезжало бы на
   три часа — отчёт приходил бы ночью. */
export const DASHBOARD_TZ = 'Europe/Minsk';

/** Ежемесячные задания ставим на 9:00, недельные — на 8:00: к началу рабочего
 *  дня отчёт уже лежит в диалоге. */
const HOUR_DEFAULT = 9;

export const DASHBOARD_BLOCKS = [
  {
    id: 'law',
    title: 'Законодательство',
    short: 'Что изменилось в законах вашей отрасли',
    description:
      'Раз в месяц проверяет Национальный правовой портал и сайты регуляторов: что принято, что вступает в силу, что нужно успеть сделать и чем грозит нарушение.',
    icon: 'scale',
    skill: 'web-research',
    cadence: 'monthly',
    dayOfMonth: 1,
    dayOfWeek: 1,
    hour: 9,
    prompt:
      'Ты готовишь ежемесячную сводку по законодательству для руководителя компании среднего бизнеса в Республике Беларусь. ' +
      'Проверь pravo.by (Национальный правовой интернет-портал) и официальные сайты регуляторов за последние 30 дней: какие законы, указы, постановления Совета Министров и ведомств приняты и что из этого вступает в силу. ' +
      'Для каждого изменения укажи: реквизиты и дату, суть в одну-две строки, на кого распространяется, что конкретно сделать и к какому сроку, чем грозит нарушение. ' +
      'Отрасль компании возьми из постоянной памяти или из последних проектов; если её там нет — дай общую часть (налоги, труд, закупки, лицензирование) и отдельным пунктом напиши, что отрасль не задана и её стоит уточнить. ' +
      'В конце — список «что сделать в этом месяце» с ответственными ролями. Ссылки на первоисточники обязательны, в начале ответа — дата проверки. ' +
      'Ответ пришли в чат компактно, маркированными списками и без вступлений, а полную версию сохрани файлом .docx в проекте.',
  },
  {
    id: 'taxes',
    title: 'Налоги и отчётность',
    short: 'Сроки платежей, ФСЗН и изменения ставок',
    description:
      'Перед отчётной датой собирает календарь: что и когда платить и сдавать, какие ставки и формы изменились, что подготовить бухгалтеру заранее.',
    icon: 'receipt',
    skill: 'web-research',
    cadence: 'monthly',
    dayOfMonth: 20,
    dayOfWeek: 1,
    hour: 9,
    prompt:
      'Ты готовишь налоговый календарь на ближайший месяц для компании из Республики Беларусь; если в постоянной памяти не указано иное — общая система налогообложения. ' +
      'Собери: сроки уплаты и сдачи НДС, налога на прибыль, подоходного налога, ФСЗН и Белгосстраха, земельного и экологического налога; изменения ставок, форм и порядков заполнения за последние 30 дней (МНС, ФСЗН, Белгосстрах); что нужно подготовить заранее — документы, сверки, ЭСЧФ. ' +
      'Раздели ответ на три части: «оплатить», «сдать», «проверить». Для каждой строки — точная дата, основание и ссылка на первоисточник. Если срок попадает на выходной или праздник — пересчитай по правилам переноса и покажи итоговую дату. ' +
      'В конце — чек-лист для бухгалтера на 6–8 пунктов с датами. Ответ пришли в чат, а календарь продублируй файлом .xlsx в проекте (листы «Календарь» и «Чек-лист»).',
  },
  {
    id: 'finance',
    title: 'Финансы компании',
    short: 'Деньги, долги и маржа за месяц',
    description:
      'Собирает месячную картину: поступления и платежи, дебиторка и кредиторка, кассовые разрывы, маржа по направлениям и что с этим делать.',
    icon: 'chart',
    skill: 'fin-audit',
    cadence: 'monthly',
    dayOfMonth: 5,
    dayOfWeek: 1,
    hour: 9,
    prompt:
      'Ты готовишь месячный финансовый срез для руководителя компании в Республике Беларусь. ' +
      'Опирайся на файлы и выгрузки в проекте, на предыдущие отчёты и на постоянную память. Чего не хватает — назови явно в разделе «нужны данные» и не выдумывай цифры. ' +
      'Посчитай за период: поступления и платежи, остаток на счетах и в кассе, дебиторскую и кредиторскую задолженность с выделением просрочки, платёжный календарь на четыре недели вперёд, кассовые разрывы, маржу по направлениям (если данные есть), долю трёх крупнейших клиентов и поставщиков. ' +
      'Для каждой найденной проблемы — причина и одно конкретное действие с ответственным и сроком. ' +
      'Итог в чат: пять ключевых цифр, три риска, три решения — без общих слов. Расчёт сохрани файлом .xlsx с листами «Сводка», «Платёжный календарь», «Задолженность».',
  },
  {
    id: 'people',
    title: 'Кадры и охрана труда',
    short: 'Люди, документы и обязательные проверки',
    description:
      'Раз в месяц проверяет кадровый контур: изменения Трудового кодекса, отпуска и больничные, инструктажи и аттестацию, типичные штрафы при проверке.',
    icon: 'people',
    skill: 'web-research',
    cadence: 'monthly',
    dayOfMonth: 25,
    dayOfWeek: 1,
    hour: 9,
    prompt:
      'Ты готовишь кадровую сводку для компании из Республики Беларусь. ' +
      'Проверь: изменения Трудового кодекса и постановлений Минтруда за последние 30 дней; обязательные кадровые документы и сроки их актуальности; график отпусков, больничные и их оплату, сверхурочные и совмещение; охрану труда — инструктажи, обучение, средства индивидуальной защиты, аттестацию рабочих мест, медосмотры; требования Департамента государственной инспекции труда и типичные нарушения со размерами штрафов. ' +
      'Составь три части: «что изменилось», «что просрочено или просрочится в ближайший месяц», «что подготовить к проверке». ' +
      'В конце — чек-лист на 8 пунктов с ответственными ролями (кадры, охрана труда, руководитель). Ответ пришли в чат, компактно; сводку сохрани файлом .docx в проекте.',
  },
  {
    id: 'tenders',
    title: 'Тендеры и закупки',
    short: 'Новые закупки по вашему профилю',
    description:
      'Каждую неделю просматривает площадки и закупки: подходящие лоты, сроки подачи, требования к участнику и документы, которые нужно успеть собрать.',
    icon: 'gavel',
    skill: 'web-research',
    cadence: 'weekly',
    dayOfMonth: 1,
    dayOfWeek: 1,
    hour: 8,
    prompt:
      'Ты готовишь недельную подборку закупок для компании из Республики Беларусь. ' +
      'Проверь icetrade.by, zakupki.butb.by, goszakupki.by и закупки крупных заказчиков по профилю компании. Профиль возьми из постоянной памяти, файлов и последних проектов; если его нигде нет — предложи три вероятных направления, явно пометь их как предположение и попроси уточнить. ' +
      'Отбери лоты, в которых мы можем участвовать: предмет, заказчик, цена, срок подачи, требования к участнику, обеспечение заявки, комплект документов. Отсортируй по сроку подачи и отдельно отметь самые срочные (подача меньше чем через 5 дней). ' +
      'Для трёх самых релевантных лотов — короткий план участия: что подготовить, кто нужен, за сколько дней начинать. ' +
      'В начале ответа поставь дату проверки, у каждого лота — ссылку на карточку закупки. Ответ пришли в чат, а таблицу лотов сохрани файлом .xlsx в проекте.',
  },
  {
    id: 'market',
    title: 'Рынок и конкуренты',
    short: 'Цены, спрос и что делают конкуренты',
    description:
      'Раз в квартал собирает картину рынка: статистика Белстата, цены и ассортимент конкурентов, динамика спроса и ниши, куда стоит смотреть в следующем квартале.',
    icon: 'globe',
    skill: 'web-research',
    cadence: 'quarterly',
    dayOfMonth: 10,
    dayOfWeek: 1,
    hour: 10,
    prompt:
      'Ты готовишь квартальный обзор рынка для компании из Республики Беларусь. ' +
      'Собери: официальную статистику Белстата по нашей отрасли за последний доступный период (объёмы, индексы цен, число организаций); пять–семь конкурентов — цены, ассортимент, сильные стороны, изменения за квартал; динамику спроса и сезонность; две–три ниши или продукта, которые стоит попробовать, с оценкой ёмкости и риска; что меняется в поведении покупателей. ' +
      'Каждую цифру сопровождай источником и датой публикации. Где публичных данных нет — пиши «нет публичных данных», а не оценку. ' +
      'Итог: пять выводов и три решения на квартал, с ожидаемым эффектом и риском. Ответ пришли в чат, компактно; полный обзор сохрани файлом .docx в проекте.',
  },
];

export const DASHBOARD_LIMITS = {
  /** Сколько символов в своём тексте задания разрешаем. */
  promptChars: 2000,
  /** День месяца держим до 28-го: иначе «31-е» пропускает февраль. */
  dayOfMonthMax: 28,
  /** Сколько документов можно приложить к одному заданию. */
  maxFiles: 10,
  /** Сколько символов текста из всех документов задания уходит в модель. */
  filesContextChars: 40000,
};

/** Папка в проекте, куда перед запуском кладутся документы задания. */
export const DASHBOARD_FILES_SUBDIR = 'materials';

/**
 * Убирает из текста задания численность компании: она больше не нужна в
 * скобках, страну оставляем словами. Функция нужна и для новых текстов, и для
 * уже сохранённых заданий — у людей в настройках лежат старые формулировки.
 */
export function withoutCompanySize(text) {
  let out = String(text || '');
  const rules = [
    [
      'для руководителя компании среднего бизнеса (около 60 работников)',
      'для руководителя компании среднего бизнеса в Республике Беларусь',
    ],
    [
      'для компании из Республики Беларусь (около 60 работников; если в постоянной памяти не указано иное — общая система налогообложения)',
      'для компании из Республики Беларусь; если в постоянной памяти не указано иное — общая система налогообложения',
    ],
    [' (около 60 работников, Республика Беларусь)', ' в Республике Беларусь'],
    [' со средней списочной численностью около 60 работников', ''],
    [' (около 60 работников)', ''],
    [' (около 60 сотрудников)', ''],
  ];
  for (const [from, to] of rules) out = out.split(from).join(to);
  return out;
}

/**
 * Абзац про приложенные документы: без него агент может «не заметить» файлы
 * и построить отчёт на общих данных.
 */
export function dashboardDocsBlock(docs) {
  const list = Array.isArray(docs) ? docs : [];
  if (!list.length) return '';
  const names = list.map((doc) => `«${doc.name}»`).join(', ');
  return (
    `\n\nМатериалы задания (их приложил человек): ${names}. ` +
    `Файлы лежат в папке проекта ${DASHBOARD_FILES_SUBDIR} — прочитай их до начала работы и опирайся на факты из них. ` +
    'Если документ расходится с общими данными или с постоянной памятью — верь документу и отдельным пунктом отметь расхождение.'
  );
}

const CADENCES = new Set(['weekly', 'monthly', 'quarterly']);

/* Целое в границах: пустая строка, null и «двадцать пять» превращаются в
   запасное значение, а не в NaN — иначе расписание молча ломается. */
function intOr(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

export function dashboardBlock(id) {
  return DASHBOARD_BLOCKS.find((block) => block.id === id) || null;
}

/* ---------------------------- часовой пояс ---------------------------- */

const zoneFormatters = new Map();

function zoneFormatter(timeZone) {
  let formatter = zoneFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    zoneFormatters.set(timeZone, formatter);
  }
  return formatter;
}

/** Календарные поля момента в нужном поясе: { year, month (0-11), day, hour, minute, second }. */
function partsInZone(ms, timeZone) {
  const out = {};
  for (const part of zoneFormatter(timeZone).formatToParts(new Date(ms))) {
    if (part.type !== 'literal') out[part.type] = part.value;
  }
  return {
    year: Number(out.year),
    month: Number(out.month) - 1,
    day: Number(out.day),
    hour: Number(out.hour) % 24,
    minute: Number(out.minute),
    second: Number(out.second),
  };
}

/** Смещение пояса в миллисекундах на этот момент (Минск — ровно +3, но
 *  функция общая: если пояс когда-нибудь сменят, переходы на летнее время
 *  посчитаются сами). */
function zoneOffsetMs(ms, timeZone) {
  const parts = partsInZone(ms, timeZone);
  const asUtc = Date.UTC(parts.year, parts.month, parts.day, parts.hour, parts.minute, parts.second);
  return asUtc - (ms - (ms % 1000));
}

/** Момент «такое-то число, такой-то час» по поясу — обратно в UTC. */
function zonedInstant(year, month, day, hour, timeZone) {
  const guess = Date.UTC(year, month, day, hour, 0, 0);
  const first = guess - zoneOffsetMs(guess, timeZone);
  /* Вторая попытка нужна на стыке перехода времени: смещение угаданного
     момента может отличаться от смещения итогового. */
  const second = guess - zoneOffsetMs(first, timeZone);
  return second;
}

/* ------------------------------ расписание ------------------------------ */

function hourOf(task) {
  return intOr(task.hour, 0, 23, HOUR_DEFAULT);
}

function dayOfMonthOf(task) {
  return intOr(task.dayOfMonth, 1, DASHBOARD_LIMITS.dayOfMonthMax, 1);
}

function dayOfWeekOf(task) {
  /* 1 — понедельник, 7 — воскресенье: так это выглядит в интерфейсе. */
  return intOr(task.dayOfWeek, 1, 7, 1);
}

/**
 * Когда задание должно отработать в следующий раз. Возвращает ISO-строку.
 *
 * Перебор идёт по календарным дням в нужном поясе: 400 дней хватает на любой
 * из наших ритмов (недельный, месячный, квартальный), а сам расчёт не зависит
 * от того, в каком поясе живёт контейнер.
 */
export function nextRunAt(task, fromMs = Date.now()) {
  const timeZone = task.timeZone || DASHBOARD_TZ;
  const cadence = CADENCES.has(task.cadence) ? task.cadence : 'monthly';
  const hour = hourOf(task);
  const dayOfMonth = dayOfMonthOf(task);
  const dayOfWeek = dayOfWeekOf(task);
  const base = partsInZone(fromMs, timeZone);
  for (let shift = 0; shift < 400; shift += 1) {
    const probe = new Date(Date.UTC(base.year, base.month, base.day + shift));
    const year = probe.getUTCFullYear();
    const month = probe.getUTCMonth();
    const day = probe.getUTCDate();
    const weekday = (probe.getUTCDay() + 6) % 7; // 0 — понедельник
    let matches = false;
    if (cadence === 'weekly') matches = weekday === dayOfWeek - 1;
    else if (cadence === 'monthly') matches = day === dayOfMonth;
    else matches = day === dayOfMonth && [0, 3, 6, 9].includes(month);
    if (!matches) continue;
    const at = zonedInstant(year, month, day, hour, timeZone);
    if (at > fromMs) return new Date(at).toISOString();
  }
  /* Сюда попасть нельзя, но лучше вернуть что-то понятное, чем null. */
  return new Date(fromMs + 24 * 60 * 60 * 1000).toISOString();
}

/** Новое задание блока: настройки по умолчанию, выключено до решения человека. */
export function defaultDashboardTask(block, ownerId, fromMs = Date.now()) {
  const now = fromMs;
  const task = {
    id: `d_${block.id}_${String(ownerId).replace(/[^a-z0-9]/gi, '').slice(-6)}`,
    ownerId,
    blockId: block.id,
    enabled: false,
    cadence: block.cadence,
    dayOfMonth: block.dayOfMonth,
    dayOfWeek: block.dayOfWeek,
    hour: block.hour,
    timeZone: DASHBOARD_TZ,
    projectId: '',
    prompt: block.prompt,
    /* Документы, которые человек приложил к заданию: агент получает их при
       каждом запуске. Список — только метаданные, сами файлы лежат рядом с
       данными приложения (см. dashboardFilesDir в store.mjs). */
    files: [],
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
    nextRunAt: null,
    lastRunAt: null,
    lastStatus: '',
    lastChatId: '',
    lastError: '',
  };
  return task;
}

/* --------------------------- правка настроек --------------------------- */

/**
 * Применяет к заданию только разрешённые поля. Типы и границы проверяются
 * здесь, а не в серверной ручке: одно место правды для ручки и для тестов.
 * Возвращает список того, что реально изменилось.
 */
export function applyDashboardPatch(task, patch = {}) {
  const changed = [];
  const set = (key, value) => {
    if (task[key] === value) return;
    task[key] = value;
    changed.push(key);
  };
  if (patch.enabled !== undefined) set('enabled', Boolean(patch.enabled));
  if (patch.cadence !== undefined && CADENCES.has(String(patch.cadence))) set('cadence', String(patch.cadence));
  if (patch.dayOfMonth !== undefined) {
    set('dayOfMonth', intOr(patch.dayOfMonth, 1, DASHBOARD_LIMITS.dayOfMonthMax, task.dayOfMonth));
  }
  if (patch.dayOfWeek !== undefined) set('dayOfWeek', intOr(patch.dayOfWeek, 1, 7, task.dayOfWeek));
  if (patch.hour !== undefined) set('hour', intOr(patch.hour, 0, 23, task.hour));
  if (patch.prompt !== undefined) {
    const text = String(patch.prompt).replace(/\r\n/g, '\n').trim().slice(0, DASHBOARD_LIMITS.promptChars);
    set('prompt', text || task.prompt);
  }
  if (patch.projectId !== undefined) set('projectId', String(patch.projectId || ''));
  return changed;
}

/** Менялось ли что-то, от чего зависит время следующего запуска. */
export function isSchedulePatch(changed) {
  return changed.some((key) => ['enabled', 'cadence', 'dayOfMonth', 'dayOfWeek', 'hour'].includes(key));
}

/** Подписи расписания для интерфейса — держим рядом с самими правилами. */
export function scheduleText(task) {
  const hour = String(hourOf(task)).padStart(2, '0');
  const day = dayOfMonthOf(task);
  if (task.cadence === 'weekly') {
    const names = ['по понедельникам', 'по вторникам', 'по средам', 'по четвергам', 'по пятницам', 'по субботам', 'по воскресеньям'];
    return `${names[dayOfWeekOf(task) - 1]}, ${hour}:00`;
  }
  if (task.cadence === 'quarterly') return `раз в квартал, ${day}-го, ${hour}:00`;
  return `каждый месяц, ${day}-го, ${hour}:00`;
}

