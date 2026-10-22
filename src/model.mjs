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
