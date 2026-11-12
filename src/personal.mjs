/**
 * «Личный слой» — своя часть дашборда и выпуска новостей.
 *
 * Здесь живёт только предметная часть: границы полей, проверка того, что человек
 * прислал из окна создания, и журнал обратных действий. Ни файлов, ни сети, ни
 * store: модуль должен вызываться и из хранилища, и из маршрутов, и из тестов без
 * поднятия сервера.
 *
 * Почему проверки именно здесь: одно место правды. Маршрут отдаёт текст ошибки
 * человеку как есть (`toast(error.message)` в клиенте), store пишет уже
 * проверенные поля, а тест проверяет ровно те границы, которые видит
 * пользователь. Если бы границы жили в двух местах, окно создания и сервер
 * разошлись бы в первой же правке.
 *
 * Почему личный слой — данные, а не ветвление кода: основа сервиса (шесть блоков
 * дашборда и шесть тем выпуска) остаётся в коде и меняется только владельцем
 * через git. Всё, что человек добавляет сам, лежит записями в его аккаунте, и
 * добавить его можно по общим правилам, не трогая основу.
 */
import crypto from 'node:crypto';

/**
 * Границы личного слоя. Числа держим рядом с проверками: клиент показывает их
 * в подсказках, сервер — в текстах ошибок, и расхождение здесь читается как
 * ошибка сервиса, а не как ограничение.
 */
export const PERSONAL_LIMITS = {
  blocks: 6,
  topics: 3,
  undoKeep: 30,
  titleChars: 60,
  shortChars: 120,
  descriptionChars: 240,
  promptChars: 2000,
  topicTitleChars: 40,
  kickerChars: 60,
  queryChars: 120,
  extraQueryChars: 120,
  maxExtraQueries: 3,
};

/**
 * Набор значков для своего блока — реальные ключи объекта `ICONS` из
 * `public/app.js` (сверено с файлом, не выдумано): карточка рисует значок по
 * имени, и имя, которого нет в клиенте, оставило бы пустой квадрат.
 *
 * `chart` здесь не случайно: это же значение клиент подставляет как запасное
 * (`ICONS[DASH_ICON_BY_BLOCK[blockId] || 'chart']`), поэтому оно обязано быть в
 * наборе — иначе запасной вариант сам оказался бы недопустимым.
 */
export const BLOCK_ICONS = ['chart', 'calendar', 'receipt', 'scale', 'globe', 'sliders', 'file', 'users'];

/**
 * Тона карточек своих тем — ровно `NEWS_TONES` из `public/app.js`. Тон задаёт
 * цвет рамки и значка; незнакомый тон клиент молча заменил бы на `gold`, но
 * лучше не пускать его в данные вовсе.
 */
export const TOPIC_TONES = ['gold', 'blue', 'green', 'violet', 'sky', 'rose'];

/* Расписание по умолчанию для своего блока. Час — 9 утра, как у основы
   (HOUR_DEFAULT в src/dashboard.mjs): к началу рабочего дня отчёт уже лежит в
   диалоге. День месяца — первое число, день недели — понедельник. */
const DEFAULT_CADENCE = 'monthly';
const DEFAULT_DAY_OF_MONTH = 1;
const DEFAULT_DAY_OF_WEEK = 1;
const DEFAULT_HOUR = 9;
const DEFAULT_ICON = 'chart';
const DEFAULT_TONE = 'gold';
/* День месяца держим до 28-го, как в основе: иначе «31-е» пропускало бы
   февраль, и задание молча не срабатывало бы раз в год. */
const DAY_OF_MONTH_MAX = 28;
const CADENCES = new Set(['weekly', 'monthly', 'quarterly']);

/** Запись журнала — объект, а не массив: массив пришёл бы из чужого JSON. */
function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Однострочный текст: пробелы и переводы строк схлопываются, края обрезаются.
 * Не строки (число, объект, массив) дают пустую строку: «название» из числа или
 * из `[object Object]` — это не название, и честнее показать «нужно название»,
 * чем создать блок с мусором в заголовке.
 */
function oneLine(value) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

/**
 * Текст задания: переводы строк приводятся к одному виду, хвостовые пробелы
 * убираются, а лесенка из трёх и более Enter сжимается до пустой строки.
 *
 * Почему не «всё в одну строку»: в тексте задания законны списки и абзацы —
 * склеив их, мы получили бы нечитаемый промпт. Почему не оставляем как есть:
 * скопированный из другого окна текст приносит хвостовые пробелы и по пять
 * пустых строк подряд, и это молча съедает лимит в 2000 знаков.
 */
function tidyPrompt(value) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Целое в границах. Пустая строка, `null` и «двадцать пять» — это «не задано»,
 * а не ноль: `Number('')` и `Number(null)` дают 0, и без этой проверки пустое
 * поле «час» превращалось бы в полночь. Число вне границ поджимается к границе
 * (`31-е` → `28-е`), а не отвергается: расписание — не то место, где стоит
 * спорить с человеком из-за одного клика в селекте.
 */
function intOr(value, min, max, fallback) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'string' && value.trim() === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** Восемь hex-знаков — хвост идентификатора своего блока. */
function hex8() {
  return crypto.randomBytes(4).toString('hex');
}

/**
 * Идентификатор своего блока: `own_<8 hex>`.
 *
 * Почему префикс: основа использует короткие имена (`law`, `taxes`, …), поэтому
 * `own_` разводит два вида блоков без единого флага в коде — по префиксу видно,
 * можно ли удалить блок навсегда и надо ли его воскрешать при досоздании.
 */
export function customBlockId() {
  return `own_${hex8()}`;
}

/**
 * Проверяет то, что пришло из окна «Свой блок», и отдаёт готовые поля задания.
 *
 * Возвращает `{ ok, errors, value }`: `errors` — фразы для человека (клиент
 * показывает их как есть), `value` — готовый набор полей либо `null`, если
 * хотя бы одно обязательное поле не прошло. Частично заполненное значение не
 * отдаём: записывать половину задания хуже, чем попросить поправить форму.
 */
export function normalizeBlockInput(body) {
  if (!isRecord(body)) {
    return {
      ok: false,
      errors: ['Не понял данные блока. Пришлите название и что должен сделать агент — остальное подставим сами.'],
      value: null,
    };
  }

  const errors = [];

  const title = oneLine(body.title);
  if (!title) errors.push(`У блока должно быть название — до ${PERSONAL_LIMITS.titleChars} знаков`);
  else if (title.length > PERSONAL_LIMITS.titleChars) {
    errors.push(`Название блока длиннее ${PERSONAL_LIMITS.titleChars} знаков — сократите.`);
  }

  const prompt = tidyPrompt(body.prompt);
  if (!prompt) errors.push(`Расскажите, что должен сделать агент: до ${PERSONAL_LIMITS.promptChars} знаков`);
  else if (prompt.length > PERSONAL_LIMITS.promptChars) {
    errors.push(`Текст задания длиннее ${PERSONAL_LIMITS.promptChars} знаков — сократите.`);
  }

  /* Подпись и описание необязательны: карточка умеет показывать пустую строку
     (`task.short || ''`). Но если их прислали — они тоже не бесконечные. */
  const short = oneLine(body.short);
  if (short.length > PERSONAL_LIMITS.shortChars) {
    errors.push(`Подпись блока длиннее ${PERSONAL_LIMITS.shortChars} знаков — сократите.`);
  }

  const description = oneLine(body.description);
  if (description.length > PERSONAL_LIMITS.descriptionChars) {
    errors.push(`Описание блока длиннее ${PERSONAL_LIMITS.descriptionChars} знаков — сократите.`);
  }

  /* Частота, значок и включённость не спорят с человеком: незнакомое значение
     заменяется разумным, а не превращается в ошибку. Ошибиться в селекте легко,
     а последствие безобидно. */
  const cadence = CADENCES.has(String(body.cadence)) ? String(body.cadence) : DEFAULT_CADENCE;
  const icon = BLOCK_ICONS.includes(String(body.icon)) ? String(body.icon) : DEFAULT_ICON;

  return {
    ok: errors.length === 0,
    errors,
    value:
      errors.length > 0
        ? null
        : {
            title,
            short,
            description,
            icon,
            prompt,
            cadence,
            dayOfMonth: intOr(body.dayOfMonth, 1, DAY_OF_MONTH_MAX, DEFAULT_DAY_OF_MONTH),
            dayOfWeek: intOr(body.dayOfWeek, 1, 7, DEFAULT_DAY_OF_WEEK),
            hour: intOr(body.hour, 0, 23, DEFAULT_HOUR),
            enabled: body.enabled === undefined ? true : Boolean(body.enabled),
          },
  };
}

/**
 * Проверяет свою тему топ-новостей.
 *
 * Отличие от блока: здесь обязателен ещё и поисковый запрос — тема без запроса
 * не соберётся, и человек ждал бы пустую карточку вместо понятной ошибки.
 */
export function normalizeTopicInput(body) {
  if (!isRecord(body)) {
    return {
      ok: false,
      errors: ['Не понял данные темы. Пришлите название и что искать в новостях — остальное подставим сами.'],
      value: null,
    };
  }

  const errors = [];

  const title = oneLine(body.title);
  if (!title) errors.push(`У темы должно быть название — до ${PERSONAL_LIMITS.topicTitleChars} знаков`);
  else if (title.length > PERSONAL_LIMITS.topicTitleChars) {
    errors.push(`Название темы длиннее ${PERSONAL_LIMITS.topicTitleChars} знаков — сократите.`);
  }

  const query = oneLine(body.query);
  if (!query) errors.push(`Напишите, что искать в новостях — до ${PERSONAL_LIMITS.queryChars} знаков`);
  else if (query.length > PERSONAL_LIMITS.queryChars) {
    errors.push(`Поисковый запрос длиннее ${PERSONAL_LIMITS.queryChars} знаков — сократите.`);
  }

  /* Пустой подзаголовок — не ошибка: под ним и так читается название темы. */
  const kicker = oneLine(body.kicker) || title;
  if (kicker.length > PERSONAL_LIMITS.kickerChars) {
    errors.push(`Подзаголовок темы длиннее ${PERSONAL_LIMITS.kickerChars} знаков — сократите.`);
  }

  /* Дополнительные запросы расширяют выдачу, когда основная узкая. Пустые
     строки выбрасываем (лишний Enter в поле — не ошибка), а повторы и повтор
     основного запроса — тоже: две одинаковые строки дали бы одни и те же две
     новости в одном блоке. */
  const extraQueries = [];
  if (Array.isArray(body.extraQueries)) {
    let tooLong = false;
    for (const item of body.extraQueries) {
      const value = oneLine(item);
      if (!value) continue;
      if (value.length > PERSONAL_LIMITS.extraQueryChars) {
        tooLong = true;
        continue;
      }
      const lower = value.toLowerCase();
      if (lower === query.toLowerCase()) continue;
      if (extraQueries.some((seen) => seen.toLowerCase() === lower)) continue;
      extraQueries.push(value);
    }
    if (tooLong) {
      errors.push(`Дополнительный запрос длиннее ${PERSONAL_LIMITS.extraQueryChars} знаков — сократите.`);
    }
    if (extraQueries.length > PERSONAL_LIMITS.maxExtraQueries) {
      errors.push(`Дополнительных запросов может быть не больше ${PERSONAL_LIMITS.maxExtraQueries}.`);
    }
  }

  const tone = TOPIC_TONES.includes(String(body.tone)) ? String(body.tone) : DEFAULT_TONE;

  return {
    ok: errors.length === 0,
    errors,
    value: errors.length > 0 ? null : { title, kicker, query, extraQueries, tone },
  };
}

/**
 * Служебные поля записи журнала добираем сами: запись без `id` нельзя отменить,
 * а без подписи — показать человеку. Ошибка в одном поле не должна ломать
 * кнопку «Отменить» для всех остальных действий.
 */
function journalEntry(entry) {
  const data = isRecord(entry.data) ? entry.data : {};
  return {
    id: String(entry.id ?? '') || `u_${hex8()}`,
    at: String(entry.at ?? '') || new Date().toISOString(),
    kind: String(entry.kind ?? ''),
    label: String(entry.label ?? '') || undoLabel(entry.kind, data),
    data,
  };
}

/**
 * Кладёт запись в журнал и возвращает **новый** массив.
 *
 * Почему новый, а не `push`: журнал лежит в состоянии аккаунта, и молчаливая
 * мутация массива обошла бы запись на диск в том месте, где её делают.
 *
 * Почему свежая запись впереди: кнопка «Отменить» берёт последнее действие
 * (`lastUndo` — нулевой элемент), а список в интерфейсе читается сверху вниз
 * как «что было недавно». Тогда `undoKeep` вытесняет самые старые записи в
 * хвосте — ровно то, что ожидает человек.
 */
export function pushUndo(list, entry) {
  const base = normalizeUndoList(list);
  if (!isRecord(entry)) return base;
  const record = journalEntry(entry);
  /* Повтор с тем же id не удваиваем: откат по id применился бы дважды. */
  const rest = base.filter((item) => String(item.id ?? '') !== record.id);
  return [record, ...rest].slice(0, PERSONAL_LIMITS.undoKeep);
}

/**
 * Достаёт запись по id и остаток журнала. `null` — записи нет (или id пустой):
 * маршрут ответит «отменять нечего» вместо тихого отката чего-нибудь другого.
 */
export function undoById(list, id) {
  const key = String(id ?? '');
  if (!key) return null;
  const entries = normalizeUndoList(list);
  const index = entries.findIndex((item) => String(item.id ?? '') === key);
  if (index < 0) return null;
  return {
    entry: entries[index],
    rest: entries.slice(0, index).concat(entries.slice(index + 1)),
  };
}

/** Последнее действие — то, что отменит кнопка без выбора. */
export function lastUndo(list) {
  const entries = normalizeUndoList(list);
  return entries.length > 0 ? entries[0] : null;
}

/**
 * Название блока или темы для подписи отмены. Смотрим все места, где оно может
 * лежать: у `task-patch` это поля задания, у `own-delete` — сохранённый блок, у
 * `topic-delete` — сохранённая тема. Названия нет — вернём пустую строку, и
 * подпись скажет «Настройки задания изменены» без выдуманного имени.
 */
function undoTitle(data) {
  if (!isRecord(data)) return '';
  const sources = [data.title, data.task?.title, data.before?.title, data.topic?.title, data.name];
  for (const source of sources) {
    const value = oneLine(source);
    if (value) return value.slice(0, PERSONAL_LIMITS.titleChars);
  }
  return '';
}

/**
 * Человеческая подпись действия. Хранится вместе с записью журнала, поэтому
 * фраза остаётся понятной и через неделю, когда самого задания уже нет.
 */
export function undoLabel(kind, data) {
  const title = undoTitle(data);
  const quoted = title ? `«${title}»` : '';
  switch (String(kind ?? '')) {
    case 'task-patch':
      return title ? `Настройки задания ${quoted} изменены` : 'Настройки задания изменены';
    case 'task-delete':
      return title ? `Задание ${quoted} убрано` : 'Задание убрано';
    case 'task-restore-all': {
      const ids = Array.isArray(data?.taskIds) ? data.taskIds : [];
      return ids.length > 1 ? `Возвращены удалённые задания (${ids.length})` : 'Возвращены удалённые задания';
    }
    case 'own-create':
      return title ? `Свой блок ${quoted} создан` : 'Свой блок создан';
    case 'own-delete':
      return title ? `Свой блок ${quoted} удалён` : 'Свой блок удалён';
    case 'topic-create':
      return title ? `Своя тема ${quoted} создана` : 'Своя тема создана';
    case 'topic-delete':
      return title ? `Своя тема ${quoted} удалена` : 'Своя тема удалена';
    default:
      return 'Изменение в личном слое';
  }
}

/**
 * Тема в том виде, в каком её можно отдать клиенту: только поля контракта.
 *
 * Почему белый список, а не «удалить известные служебные»: у темы появляются
 * внутренние поля (владелец, кеш выпуска, статус сборки) — при первом же
 * добавлении такого поля оно утекло бы в браузер вместе с чужим `ownerId`.
 */
export function publicTopic(topic) {
  if (!isRecord(topic)) return null;
  return {
    id: String(topic.id ?? ''),
    title: String(topic.title ?? ''),
    kicker: String(topic.kicker ?? ''),
    query: String(topic.query ?? ''),
    extraQueries: Array.isArray(topic.extraQueries)
      ? topic.extraQueries.filter((item) => typeof item === 'string')
      : [],
    tone: String(topic.tone ?? ''),
    createdAt: String(topic.createdAt ?? ''),
  };
}

/**
 * Журнал из состояния аккаунта: массив объектов — массив, всё остальное — пустой
 * журнал. Файл состояния мог быть записан старой версией, а `null` вместо
 * журнала не должен ронять загрузку дашборда.
 */
export function normalizeUndoList(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => isRecord(item))
    .slice(0, PERSONAL_LIMITS.undoKeep);
}
