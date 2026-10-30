/**
 * Выбор модели под задачу.
 *
 * Короткий вопрос («переименуй файл», «сколько будет 3×7») не должен стоить
 * как аудит отчётности: его быстрее и дешевле делает flash. Аудит, финмодель,
 * ресёрч с источниками и сборка документов — это длинная цепочка рассуждений,
 * где ошибка в цифре дороже, поэтому такие задачи идут на сильной модели с
 * максимальным усилием. Решение принимается один раз на ход и не меняется
 * между шагами: переключение профиля посреди работы сбивало бы нить и стоило
 * бы лишних токенов.
 *
 * Оценка детерминированная и объяснимая: список признаков виден в `reasons`,
 * а не спрятан в эвристике «на глаз». Если признаков мало — profile 'flash'.
 */

/* Тяжёлые темы: работа, в которой ошибка стоит денег и переделки. */
const HEAVY_TERMS = [
  { re: /аудит|аудитор|заключени[ея] по мса|мса\s*\d|существенност/i, weight: 3, reason: 'аудит' },
  { re: /финмодел|финансов(ая|ой) модел|юнит-эконом|dfc|dcf|npv|irr|wacc|дисконтир/i, weight: 3, reason: 'финмодель' },
  { re: /бизнес-план|инвестор|кредитн|банк[уа]|обосновани[ея] кредит/i, weight: 2, reason: 'бизнес-план' },
  { re: /ресёрч|исследован|рынок|конкурент|бенчмарк|статистик|источник/i, weight: 2, reason: 'ресёрч' },
  { re: /бухгалтер|отчётност|баланс|опд|оддс|сходимост|свер(ь|ка|ить)|консолидац/i, weight: 3, reason: 'сверка отчётности' },
  { re: /договор|контракт|соглашени|устав|юрид|правов/i, weight: 2, reason: 'юридический текст' },
  { re: /презентац|питч|лендинг|отчёт|документ|смет|таблиц[ауы]|эксель|word|pdf/i, weight: 1, reason: 'документы' },
  { re: /проанализируй|анализ|вывод|рекомендац|стратег|оптимизац/i, weight: 2, reason: 'анализ' },
];

/* Признаки большой работы: объём, число разделов, диапазон файлов. */
function volumeScore(text, filesBrief) {
  const reasons = [];
  let score = 0;
  const chars = String(text || '').length;
  if (chars > 2400) {
    score += 3;
    reasons.push('очень длинный запрос');
  } else if (chars > 1200) {
    score += 2;
    reasons.push('длинный запрос');
  } else if (chars > 500) {
    score += 1;
    reasons.push('подробный запрос');
  }
  const sections = (String(text || '').match(/(^|\n)\s*(\d+[.)]|[-—•])\s+/g) || []).length;
  if (sections >= 5) {
    score += 2;
    reasons.push('много пунктов');
  } else if (sections >= 3) {
    score += 1;
    reasons.push('несколько пунктов');
  }
  const sources = String(text || '').match(/https?:\/\//g)?.length || 0;
  if (sources >= 2) {
    score += 1;
    reasons.push('несколько источников');
  }
  /* В проекте уже много файлов — задача, скорее всего, про сведение данных. */
  const fileLines = (String(filesBrief || '').match(/\n/g) || []).length;
  if (fileLines >= 6) {
    score += 2;
    reasons.push('большой проект');
  } else if (fileLines >= 3) {
    score += 1;
    reasons.push('несколько файлов');
  }
  return { score, reasons };
}

/**
 * Оценка задачи. Возвращает баллы сложности и человеческое объяснение —
 * по нему видно, почему ход ушёл на сильную модель.
 */
export function scoreTask({ text = '', filesBrief = '', tools = [], images = 0 } = {}) {
  let score = 0;
  const reasons = [];
  const source = String(text || '');

  for (const term of HEAVY_TERMS) {
    if (term.re.test(source)) {
      score += term.weight;
      reasons.push(term.reason);
    }
  }

  const volume = volumeScore(source, filesBrief);
  score += volume.score;
  reasons.push(...volume.reasons);

  /* Несколько картинок или документов на входе — задача на сверку данных. */
  if (Number(images) >= 2) {
    score += 1;
    reasons.push('несколько вложений');
  }
  /* Создание документов само по себе — сильная модель: вёрстка и числа. */
  const docTools = (Array.isArray(tools) ? tools : []).filter((name) => /^create_/.test(String(name)));
  if (docTools.length) {
    score += 1;
    reasons.push('создание документов');
  }

  return { score, reasons: [...new Set(reasons)] };
}

/**
 * Профиль модели для хода. `force` позволяет тестам и вызывающему коду
 * зафиксировать профиль явно.
 */
export function chooseProfile({ text = '', filesBrief = '', tools = [], images = 0, config, force = null } = {}) {
  const settings = config || {};
  const enabled = settings.enabled !== false && Boolean(settings.proModel);
  if (!enabled) {
    return {
      profile: 'flash',
      model: settings.flashModel || 'deepseek-flash',
      effort: settings.flashEffort || 'high',
      score: 0,
      reasons: ['эскалация выключена'],
    };
  }
  if (force === 'pro' || force === 'flash') {
    return {
      profile: force,
      model: force === 'pro' ? settings.proModel : settings.flashModel,
      effort: force === 'pro' ? settings.proEffort || 'max' : settings.flashEffort || 'high',
      score: 0,
      reasons: ['профиль задан явно'],
    };
  }

  const { score, reasons } = scoreTask({ text, filesBrief, tools, images });
  const threshold = Math.max(1, Number(settings.threshold) || 3);
  const profile = score >= threshold ? 'pro' : 'flash';
  return {
    profile,
    model: profile === 'pro' ? settings.proModel : settings.flashModel,
    effort: profile === 'pro' ? settings.proEffort || 'max' : settings.flashEffort || 'high',
    score,
    threshold,
    reasons,
  };
}

/** Строка для лога: «pro (7 из 3): аудит, финмодель» — без служебных деталей. */
export function describeProfile(route) {
  if (!route) return '';
  const why = route.reasons?.length ? route.reasons.join(', ') : 'без признаков';
  return `${route.profile} (${route.score}${route.threshold ? `/${route.threshold}` : ''}): ${why}`;
}

/**
 * Механические инструменты: их результат — материал для следующего шага, а не
 * решение. Кто именно прочитал файл или скачал страницу, на качество ответа не
 * влияет; влияет то, кто будет эти данные разбирать.
 */
export const MECHANICAL_TOOLS = new Set([
  'list_files',
  'find_in_files',
  'read_file',
  'read_document',
  'read_page',
  'fetch_url',
  'fetch_many',
  'crawl',
  'scrape_page',
  'extract_archive',
  'check_links',
  'delete_path',
  'move_path',
  'remember',
  'use_skill',
]);

export function isMechanicalTool(name) {
  return MECHANICAL_TOOLS.has(String(name || '').trim());
}

/** Маршрут одного профиля: модель и усилие берутся из настроек эскалации. */
function profileRoute(profile, config = {}) {
  if (profile === 'pro' && config.proModel) {
    return { profile: 'pro', model: config.proModel, effort: config.proEffort || 'max' };
  }
  return {
    profile: 'flash',
    model: config.flashModel || 'deepseek-flash',
    effort: config.flashEffort || 'high',
  };
}

/**
 * Маршрут ОДНОГО шага хода внутри задачи.
 *
 * Профиль хода выбран по сложности задачи и служит базой. Но шаги внутри хода
 * неравноценны, поэтому база уточняется по предыдущему шагу:
 *
 *  — шаг упал с ошибкой инструмента → следующий шаг ведёт сильная модель
 *    (быстрая уже попробовала и не справилась);
 *  — предыдущий шаг принёс много данных (файл, страница, выгрузка) → разбирает
 *    сильная модель, даже если ход вообще начинался как лёгкий: задача
 *    оказалась содержательнее, чем выглядела в запросе;
 *  — предыдущий шаг работал «умным» инструментом (расчёт, создание документа,
 *    проверка, запуск кода) → дальше нужна проверка, её делает сильная;
 *  — продолжалась механика (чтение, поиск, перенос) → остаёмся на профиле хода;
 *    на сильном профиле такую работу можно отдать быстрой модели, но только
 *    если это включено явно (`split.grind`): экономия здесь может стоить
 *    качества, поэтому по умолчанию выключено.
 *
 * Возвращает полный маршрут шага плюс `switched` и `why` — по ним видно, почему
 * шаг пошёл не на модели хода.
 */
export function chooseStepRoute({ route, step = 1, previous = null, config = {}, split = {} } = {}) {
  const settings = config || {};
  const baseProfile = route?.profile === 'pro' && settings.proModel ? 'pro' : 'flash';
  const base = { ...(route || {}), ...profileRoute(baseProfile, settings) };

  /* Сильная модель не настроена — выбора нет. */
  if (!settings.proModel) {
    return { ...base, ...profileRoute('flash', settings), switched: false, why: 'сильная модель не настроена' };
  }
  if (split && split.enabled === false) {
    return { ...base, switched: false, why: 'распределение шагов выключено (DSHOW_SPLIT=0)' };
  }
  if (Number(step) <= 1 || !previous) {
    return { ...base, switched: false, why: 'первый шаг идёт на профиле хода' };
  }

  const decide = (profile, why) => {
    const target = profileRoute(profile, settings);
    return {
      ...base,
      ...target,
      switched: target.profile !== baseProfile,
      why,
    };
  };

  if (previous.failed) return decide('pro', 'предыдущий шаг сорвался — берёт сильная модель');

  const tools = Array.isArray(previous.tools) ? previous.tools.filter(Boolean) : [];
  if (!tools.length) return { ...base, switched: false, why: 'на прошлом шаге не было инструментов' };

  const chars = Number(previous.chars) || 0;
  const dataLimit = Math.max(200, Number(split?.dataChars) || 2500);
  const mechanical = tools.every(isMechanicalTool);

  if (!mechanical) {
    return decide('pro', `прошлый шаг работал инструментом ${tools[0]} — нужна проверка сильной моделью`);
  }
  if (chars >= dataLimit) {
    const kb = Math.round((chars / 1000) * 10) / 10;
    return decide('pro', `на прошлом шаге пришло ${kb} тыс. знаков данных — разбирает сильная модель`);
  }
  if (split?.grind === true && baseProfile === 'pro' && Number(previous.mechanicalRun) >= Math.max(1, Number(split?.grindAfter) || 2)) {
    return decide('flash', 'идёт перекладывание файлов подряд — его быстрее сделает быстрая модель');
  }
  return { ...base, switched: false, why: 'идёт механика: чтение и перенос материалов' };
}

/** Строка для лога шага: «шаг 4: pro, переключено с flash — …». */
export function describeStepRoute(route) {
  if (!route) return '';
  const mark = route.switched ? 'переключено' : 'профиль хода';
  return `шаг на ${route.profile}: ${mark} — ${route.why || 'без причины'}`;
}
