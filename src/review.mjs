/**
 * Финальный ревью-пасс перед выдачей ответа.
 *
 * Две проверки работают вместе:
 *
 * 1. Детерминированная и бесплатная. Из ответа вытаскиваются числа и имена
 *    файлов, и сверяются с тем, что действительно вернули инструменты. Сумма,
 *    которой нет ни в одном результате, — почти всегда выдумка; файл, о
 *    котором ответ говорит «готов», но которого нет в проекте, — обещание.
 * 2. Модельная, один вызов по чек-листу. Смотрит то, что нельзя проверить
 *    регуляркой: сходятся ли итоги, не подменены ли единицы, нет ли «красивого
 *    но пустого» текста, совпадают ли годы и названия источников. При серьёзных
 *    находках — правка ответа; если правка сама внесла числа без опоры,
 *    разрешён второй круг со строгим запретом на выдумку (REVIEW.fixRounds).
 *
 * Ревью факультативно: любой сбой возвращает исходный ответ (fail-open).
 */

import { ESCALATION, REVIEW } from './config.mjs';

/**
 * На какой модели проверять ответ. Одна и та же модель повторяет свои слепые
 * зоны, поэтому ответ, собранный быстрой моделью, проверяет сильная. Если
 * задача уже шла на сильной — проверяем той же (не платим дважды за одно и то
 * же). Явный DSHOW_REVIEW_MODEL сильнее автоматики; пустая строка — «как
 * основная».
 */
export function reviewModelName({ routeModel = '', model = REVIEW.model, escalation = ESCALATION } = {}) {
  const explicit = String(model || '').trim();
  if (explicit) return explicit;
  const pro = String(escalation?.proModel || '').trim();
  if (!escalation?.enabled || !pro) return '';
  if (routeModel && routeModel === pro) return '';
  return pro;
}

/* Мелкие числа (годы, номера, проценты-одиночки) не проверяем: они почти
   всегда повторяются из запроса, а не берутся из расчётов. */
const MIN_FIGURE_DIGITS = 3;

/* Прямой отчёт о завершении. Именно прямой: «готово», «выполнено», «все
   пункты закрыты». «Продолжаю», «в работе» и «следующий шаг» — не повод
   сравнивать ответ с карточкой задачи. */
const COMPLETION_WORDS = /(всё готово|все готово|готово[.:!,]|задача выполнена|задача решена|работа выполнена|выполнено полностью|все пункты|все разделы готовы|я закончил)/i;

/** Цифры из текста: 4+ знаков или десятичные с разделителями. */
export function extractFigures(text) {
  const source = String(text || '');
  const out = [];
  const re = /(?:^|[^\d.,])(\d{1,3}(?:[ \u00a0\u202f]\d{3})+(?:[.,]\d+)?|\d{4,}(?:[.,]\d+)?)(?![\d])/g;
  let match;
  while ((match = re.exec(source))) {
    const raw = match[1];
    const digits = raw.replace(/[^\d]/g, '');
    if (digits.length < MIN_FIGURE_DIGITS) continue;
    if (digits.length === 4 && /^(19|20)\d\d$/.test(digits)) continue; // год
    const value = Number(raw.replace(/[ \u00a0\u202f]/g, '').replace(',', '.'));
    if (!Number.isFinite(value)) continue;
    if (out.includes(value)) continue;
    out.push(value);
  }
  return out;
}

/** Имена файлов, о которых говорит ответ. */
export function extractFileMentions(text) {
  const source = String(text || '');
  const out = [];
  /* Захват намеренно широкий (имя может быть из нескольких слов), а мусор
     вокруг него убираем после: «Файлы: итоги.docx и план.xlsx» — это два
     файла, а «файл summary.md» — один, без слова «файл» в имени. */
  const re = /([\p{L}\p{N}_\-(). ]{2,80}\.(docx|xlsx|pptx|pdf|csv|json|md|txt|html|js|py))/giu;
  let match;
  while ((match = re.exec(source))) {
    for (const piece of match[1].split(/\s+(?:и|или)\s+|,\s*/)) {
      const name = piece
        .trim()
        .replace(/^[«"'(]+/, '')
        .replace(/^(?:файл|файлы|документ|документы|таблиц[ауы]|презентаци[яю]|отч[её]т|итог|результат)\s+/iu, '')
        .trim();
      if (!name || out.includes(name)) continue;
      out.push(name);
    }
  }
  return out;
}

function figureSeen(value, haystack) {
  const digits = String(Math.abs(value)).replace(/\.0+$/, '').replace('.', ',');
  const plain = String(Math.abs(value));
  const candidates = new Set([
    digits,
    plain,
    digits.replace(',', '.'),
    /* Тысячи с пробелом: 1 200 000 и 1200000 — одно и то же число. */
    plain.replace(/\B(?=(\d{3})+(?!\d))/g, ' '),
    plain.replace(/\B(?=(\d{3})+(?!\d))/g, '\u00a0'),
  ]);
  for (const candidate of candidates) {
    if (haystack.includes(candidate)) return true;
  }
  /* Округления: 1 234 567 в ответе и 1 234 567.42 в расчёте — один факт. */
  const rounded = Math.round(value);
  if (String(rounded) !== plain && haystack.includes(String(rounded))) return true;
  return false;
}

/**
 * Источники, которые принесли инструменты: адрес, год публикации и хост.
 * Нужны, чтобы проверяющий видел опору фактического утверждения, а не только
 * цифру без места. Раньше ресёрч с источниками проверялся вслепую: модель
 * видела цифру в выжимке и не могла отличить «по данным ЦБ за 2024» от
 * выдуманной ссылки на тот же ЦБ.
 */
export function extractSources(history, { limit = REVIEW.sources } = {}) {
  const seen = new Map();
  for (const message of Array.isArray(history) ? history : []) {
    if (message?.role !== 'tool') continue;
    const text = typeof message.content === 'string' ? message.content : '';
    if (!text) continue;
    const re = /https?:\/\/[^\s<>"'»«)\]]+/g;
    let match;
    while ((match = re.exec(text))) {
      const url = match[0].replace(/[.,;:]+$/, '');
      if (!/^https?:\/\/[^\s/]+/i.test(url)) continue;
      if (seen.has(url)) continue;
      /* Год ищем рядом с адресом: в выдаче поиска он идёт обычно в двухстах
         знаках от ссылки, а брать первый попавшийся год из всего текста —
         значит приписать статье чужую дату. */
      const around = text.slice(Math.max(0, match.index - 220), Math.min(text.length, match.index + 220));
      const year = (around.match(/\b(19|20)\d\d\b/g) || []).pop() || '';
      let host = '';
      try {
        host = new URL(url).host.replace(/^www\./, '');
      } catch {
        host = '';
      }
      seen.set(url, { url, host, year });
      if (seen.size >= limit) return [...seen.values()];
    }
  }
  return [...seen.values()];
}

/** Строка источников для проверяющего: адрес и год, без заголовков статей. */
export function formatSources(sources) {
  const list = Array.isArray(sources) ? sources.filter((item) => item?.url) : [];
  if (!list.length) return '';
  return `Источники, которые принесли инструменты (адрес; год публикации):\n${list
    .map((item) => `— ${item.host ? `${item.host}: ` : ''}${item.url}${item.year ? ` (${item.year})` : ''}`)
    .join('\n')}`;
}

/**
 * Детерминированные проверки ответа. `toolDigest` — склеенный текст
 * результатов инструментов за ход, `createdFiles` — файлы, которые реально
 * появились в проекте. `task` — карточка задачи: по ней видно, закрыты ли
 * пункты, о которых ответ говорит «готово».
 */
export function checkAnswer({ answer = '', toolDigest = '', createdFiles = [], task = null, maxIssues = 12 } = {}) {
  const issues = [];
  const digest = String(toolDigest || '');
  const files = (Array.isArray(createdFiles) ? createdFiles : []).map((item) =>
    typeof item === 'string' ? item : String(item?.path || item || ''),
  );
  const answerText = String(answer || '');

  /* Файл назван готовым, но такого файла нет в проекте. */
  for (const name of extractFileMentions(answerText)) {
    const base = name.split(/[\\/]/).pop();
    const known = files.some((file) => file === name || file.endsWith(`/${base}`) || file.endsWith(`\\${base}`) || base === file);
    if (!known) {
      issues.push({
        kind: 'file',
        severity: 'high',
        quote: name,
        hint: `файла «${base}» нет в проекте: не обещай его, создай или убери упоминание`,
      });
    }
    if (issues.length >= maxIssues) break;
  }

  /* Число в ответе не встречается ни в одном результате инструментов. */
  const figures = extractFigures(answerText);
  let unsupported = 0;
  for (const value of figures) {
    if (figureSeen(value, digest)) continue;
    unsupported += 1;
    if (unsupported <= 4) {
      issues.push({
        kind: 'figure',
        severity: 'high',
        quote: String(value),
        hint: 'числа нет в результатах инструментов — проверь, откуда оно',
      });
    }
    if (issues.length >= maxIssues) break;
  }
  if (unsupported > 4) {
    issues.push({
      kind: 'figure',
      severity: 'medium',
      quote: '',
      hint: `ещё ${unsupported - 4} чисел без опоры на результаты инструментов`,
    });
  }

  /* «Готово», а в карточке задачи ещё висят пункты. Регулярка ловит только
     прямой отчёт о завершении: «идёт работа» и «продолжу» — не повод для
     замечания, а «задача выполнена» при открытых пунктах — повод. */
  const pending = Array.isArray(task?.next) ? task.next.map((item) => String(item || '').trim()).filter(Boolean) : [];
  if (pending.length && COMPLETION_WORDS.test(answerText)) {
    issues.push({
      kind: 'incomplete',
      severity: 'medium',
      quote: pending[0].slice(0, 120),
      hint: `ответ объявляет работу законченной, но по карточке задачи не закрыто: ${pending
        .slice(0, 3)
        .join('; ')} — либо доделай, либо назови это прямо`,
    });
  }

  return issues;
}

/** Что увидит проверяющий: результаты инструментов, сжатые до бюджета. */
export function buildDigest(history, { budget = REVIEW.digestChars } = {}) {
  const parts = [];
  let used = 0;
  for (let index = (history?.length || 0) - 1; index >= 0; index--) {
    const message = history[index];
    if (message?.role !== 'tool') continue;
    const text = typeof message.content === 'string' ? message.content : '';
    if (!text) continue;
    const room = budget - used;
    if (room <= 200) break;
    const chunk = text.length > room ? text.slice(0, room) : text;
    parts.unshift(chunk);
    used += chunk.length;
  }
  return parts.join('\n\n');
}

const CHECKLIST = `Ты — придирчивый проверяющий готового ответа. Твоя работа: не переписать ответ, а найти в нём то, что подведёт пользователя.

Проверь по чек-листу:
1. Цифры. Каждое число в ответе должно опираться на результаты инструментов ниже. Если числа нет в источниках — это выдумка.
2. Сходимость. Итог, сумма частей, проценты и доли должны сходиться между собой.
3. Файлы. Обещанные файлы должны быть созданы; путь в ответе — существующий.
4. Полнота. На каждый пункт запроса есть ответ; нет «красивого, но пустого» текста.
5. Единицы и период. Рубли/тенге/доллары, тысячи/миллионы и годы не перепутаны.
6. Обещания. Нет фраз «файл будет создан», «можно добавить» вместо сделанного.
7. Содержание файлов. В готовом документе должна быть та тема, разделы и итоги, о которых просили; пустой, чужой или «болванка с заголовком» файл — это провал, даже если имя правильное.
8. Источники. Если цифра подана как «по данным X за N год», такой источник и такой год должны быть в списке источников ниже. Ссылка на источник, которого нет в списке, — выдумка, даже если название звучит правдоподобно.
9. Карточка задачи. Если в карточке остались пункты «Осталось», а ответ объявляет работу законченной — это замечание: назови недоделанное прямо, не выдавай часть за целое.

Ответ — строгий JSON без пояснений:
{"verdict":"ok|fix","issues":[{"kind":"figure|file|incomplete|unit|promise","severity":"high|medium","quote":"фрагмент ответа","hint":"что исправить"}]}
Если всё в порядке — {"verdict":"ok","issues":[]}.`;

/**
 * Модельная часть ревью. Возвращает {checked, verdict, issues}; при любой
 * ошибке — {checked:false} и пустой список, чтобы не блокировать ответ.
 * `excerpts` — короткие выдержки из созданных файлов: проверяющий видит тему
 * и содержимое, а не только имена.
 */
export async function reviewWithModel({ userQuestion = '', answer = '', digest = '', createdFiles = [], excerpts = [], sources = [], task = null, modelName = '', complete } = {}) {
  if (typeof complete !== 'function') return { checked: false, verdict: 'ok', issues: [] };
  const files = Array.isArray(excerpts) ? excerpts.filter((item) => item && item.text) : [];
  const filesBlock = files.length
    ? `Что внутри созданных файлов (выдержка):\n${files.map((item) => `— ${item.file}: ${String(item.text).slice(0, REVIEW.excerptChars)}`).join('\n')}`
    : '';
  const sourcesBlock = formatSources(sources);
  const pending = Array.isArray(task?.next) ? task.next.filter(Boolean) : [];
  const taskBlock = pending.length
    ? `По карточке задачи ещё не закрыто:\n${pending.slice(0, 6).map((item) => `— ${item}`).join('\n')}`
    : '';
  const prompt = [
    `Запрос пользователя:\n${String(userQuestion || '').slice(0, 2000)}`,
    `Ответ, который будет выдан:\n${String(answer || '').slice(0, 12000)}`,
    `Результаты инструментов (источник фактов):\n${String(digest || 'инструменты не вызывались').slice(0, REVIEW.digestChars)}`,
    sourcesBlock,
    createdFiles.length ? `Созданные файлы: ${createdFiles.join(', ')}` : 'Файлы не создавались.',
    filesBlock,
    taskBlock,
  ]
    .filter(Boolean)
    .join('\n\n');
  try {
    const raw = await complete(
      [
        { role: 'system', content: CHECKLIST },
        { role: 'user', content: prompt },
      ],
      { maxTokens: 900, effort: 'high', model: modelName },
    );
    const parsed = parseVerdict(raw);
    if (!parsed) return { checked: false, verdict: 'ok', issues: [] };
    return { checked: true, verdict: parsed.verdict === 'fix' ? 'fix' : 'ok', issues: parsed.issues };
  } catch {
    return { checked: false, verdict: 'ok', issues: [] };
  }
}

/** Разбор ответа проверяющего: JSON может прийти в ```-блоке или с текстом. */
export function parseVerdict(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let data;
  try {
    data = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object') return null;
  const issues = Array.isArray(data.issues) ? data.issues : [];
  return {
    verdict: data.verdict === 'fix' ? 'fix' : 'ok',
    issues: issues
      .filter((issue) => issue && typeof issue === 'object')
      .slice(0, REVIEW.maxIssues)
      .map((issue) => ({
        kind: String(issue.kind || 'other').slice(0, 24),
        severity: issue.severity === 'high' ? 'high' : 'medium',
        quote: String(issue.quote || '').slice(0, 200),
        hint: String(issue.hint || '').slice(0, 300),
      })),
  };
}

const FIX_INSTRUCTION = `Ты правишь готовый ответ по замечаниям проверяющего. Верни только исправленный текст ответа — без пояснений о правке, без заголовка «исправленный ответ», без markdown-обёртки.

Правила:
— Убери или исправь числа, которых нет в результатах инструментов; не заменяй их новыми выдуманными.
— Если итог не сходится — пересчитай из результатов и покажи сходимость.
— Файл, которого нет, не упоминай как готовый: либо он есть в списке созданных, либо убери обещание.
— Сохрани структуру, тон и язык исходного ответа, не сокращай полезное.`;

/* Второй круг — только когда первая правка сама внесла новые цифры. Просить
   «исправь ещё раз» бесполезно: нужен явный запрет на выдумку и разрешение
   написать «данных нет». */
const STRICT_ADDITION = `
Это повторная правка: предыдущая попытка внесла новые числа, которых нет в результатах инструментов. Поэтому:
— Не вводи ни одного числа, которого нет в фактах выше. Нужное число не найдено — напиши словами, что данных нет, вместо оценки «примерно».
— Не ссылайся на источники, которых нет в списке источников.
— Меняй только проблемные места, остальной текст оставь дословно.`;

/** Одна правка ответа по замечаниям. Возвращает текст или '' при сбое. */
export async function reviseAnswer({ userQuestion = '', answer = '', issues = [], digest = '', modelName = '', complete, strict = false } = {}) {
  if (typeof complete !== 'function' || !issues.length) return '';
  const list = issues
    .slice(0, REVIEW.maxIssues)
    .map((issue, index) => `${index + 1}. [${issue.kind}/${issue.severity}] ${issue.quote ? `«${issue.quote}» — ` : ''}${issue.hint}`)
    .join('\n');
  const prompt = [
    `Запрос пользователя:\n${String(userQuestion || '').slice(0, 1500)}`,
    `Замечания проверяющего:\n${list}`,
    `Факты из инструментов:\n${String(digest || 'нет').slice(0, REVIEW.digestChars)}`,
    `Исходный ответ:\n${String(answer || '').slice(0, 12000)}`,
  ].join('\n\n');
  try {
    const raw = await complete(
      [
        { role: 'system', content: strict ? `${FIX_INSTRUCTION}\n${STRICT_ADDITION}` : FIX_INSTRUCTION },
        { role: 'user', content: prompt },
      ],
      { maxTokens: 4000, effort: 'high', model: modelName },
    );
    const text = String(raw || '').trim();
    return text.length >= Math.min(80, String(answer).length / 2) ? text : '';
  } catch {
    return '';
  }
}

/** Нужен ли ревью этому ходу: не для субагентов, не для реплик и мелочи. */
export function needsReview({ answer = '', tools = [], depth = 0, minChars = REVIEW.minAnswerChars } = {}) {
  if (!REVIEW.enabled) return false;
  if (depth > 0) return false;
  const text = String(answer || '').trim();
  if (text.length < minChars) return false;
  const list = Array.isArray(tools) ? tools : [];
  /* Ответ без инструментов — это разговор, а не отчёт: проверять нечего. */
  if (!list.length) return false;
  const succeeded = list.filter((tool) => tool.status !== 'error');
  return succeeded.length > 0;
}

/**
 * Есть ли в ответе то, что можно сверить с результатами инструментов: числа,
 * имена файлов или ссылки на источники. Если сверять нечего, сильная модель
 * проверяющему не нужна — она бы читала тот же текст и говорила «всё ок»,
 * а платили бы мы как за аудит. Такой ответ проверяет модель хода: структуру
 * и полноту она видит не хуже, а детерминированные проверки всё равно уже
 * прошли выше.
 */
export function hasCheckableFacts({ answer = '', sources = [], createdFiles = [] } = {}) {
  const text = String(answer || '');
  if (extractFigures(text).length) return true;
  if (extractFileMentions(text).length) return true;
  /* Файл, который агент реально создал, — тоже предмет сверки: проверяющий
     смотрит, что в ответе сказано про него. */
  if ((Array.isArray(createdFiles) ? createdFiles : []).filter(Boolean).length) return true;
  if ((Array.isArray(sources) ? sources : []).length >= 2) return true;
  return false;
}

/**
 * Полный проход ревью: детерминированные проверки, затем модель, затем
 * правка при серьёзных находках (до REVIEW.fixRounds кругов). Возвращает
 * итоговый текст и отчёт.
 */
export async function reviewAnswer({ userQuestion = '', answer = '', history = [], createdFiles = [], excerpts = [], routeModel = '', complete, depth = 0, tools = [], task = null } = {}) {
  const report = { checked: false, verdict: 'ok', issues: [], fixed: false, modelChecked: false, model: '', attempts: 0 };
  if (!needsReview({ answer, tools, depth })) return { text: String(answer || ''), report };

  const digest = buildDigest(history);
  /* Источники — отдельным блоком: без них проверяющий не отличает цифру из
     статьи от цифры, придуманной вместе со ссылкой на статью. */
  const sources = extractSources(history);
  report.sources = sources.length;
  /* Сильную модель зовём проверяющим только когда есть что сверять: числа,
     файлы, источники. Иначе ответ читает модель хода — она дешевле, а
     детерминированные проверки ниже всё равно выполняются. Явно заданный
     DSHOW_REVIEW_MODEL сильнее этой экономии: его владелец выбрал сам. */
  const explicitModel = String(REVIEW.model || '').trim();
  const checkable = hasCheckableFacts({ answer, sources, createdFiles });
  const modelName = explicitModel || (checkable ? reviewModelName({ routeModel }) : '');
  report.model = modelName;
  report.proChecked = Boolean(modelName) && modelName === ESCALATION.proModel;
  const deterministic = checkAnswer({ answer, toolDigest: digest, createdFiles, task });
  let issues = deterministic;
  report.issues = issues.slice();

  if (complete) {
    const model = await reviewWithModel({ userQuestion, answer, digest, createdFiles, excerpts, sources, task, modelName, complete });
    report.modelChecked = model.checked;
    if (model.checked) {
      /* Модель может найти другое, чем регулярка: объединяем без повторов. */
      for (const issue of model.issues) {
        if (!issues.some((item) => item.kind === issue.kind && item.quote === issue.quote)) issues.push(issue);
      }
    }
  }
  report.issues = issues.slice(0, REVIEW.maxIssues);

  const high = issues.filter((issue) => issue.severity === 'high');
  const evaluate = (text) => checkAnswer({ answer: text, toolDigest: digest, createdFiles, task });
  if (!high.length || !REVIEW.fix || !complete) {
    report.verdict = issues.length ? 'issues' : 'ok';
    report.checked = true;
    return { text: String(answer || ''), report };
  }

  /* Круги правки. Первый круг — обычный. Если правка внесла новые числа без
     опоры, второй круг просит переписать строго: это дешевле, чем отдать
     человеку исходный ответ с той ошибкой, из-за которой правка началась. */
  let current = String(answer || '');
  let target = high;
  let best = '';
  for (let round = 1; round <= REVIEW.fixRounds; round++) {
    const revised = await reviseAnswer({ userQuestion, answer: current, issues: target, digest, modelName, complete, strict: round > 1 });
    if (!revised) break;
    report.attempts = round;
    const again = evaluate(revised);
    const newHigh = again.filter((issue) => issue.severity === 'high' && !target.some((item) => item.quote === issue.quote));
    if (!newHigh.length) {
      best = revised;
      report.issues = again.slice(0, REVIEW.maxIssues);
      break;
    }
    /* Правка не прошла: следующий круг правит её же и знает, что именно
       оказалось выдумкой. Исходный ответ при этом не теряется. */
    current = revised;
    target = newHigh;
    report.issues = again.slice(0, REVIEW.maxIssues);
  }

  report.checked = true;
  if (!best) {
    report.verdict = 'issues';
    return { text: String(answer || ''), report };
  }
  report.fixed = true;
  report.verdict = 'fixed';
  /* Сколько замечаний закрыто этой правкой — для строки в логе: после правки в
     отчёте остаются только незакрытые, и без этого числа лог писал «правка
     ответа по 0 замечаниям». */
  report.fixedCount = high.length;
  return { text: best, report };
}

/** Строка для лога сервера. */
/** Русское склонение: 1 замечание, 2 замечания, 5 замечаний. */
function plural(count, one, few, many) {
  const tail = Math.abs(count) % 100;
  const last = tail % 10;
  if (tail > 10 && tail < 20) return many;
  if (last === 1) return one;
  if (last >= 2 && last <= 4) return few;
  return many;
}

export function describeReview(report) {
  if (!report?.checked) return '';
  const count = report.issues?.length || 0;
  const by = report.model ? ` (проверял ${report.model})` : '';
  if (report.fixed) {
    /* Число — сколько замечаний закрыла правка, а не сколько осталось: остаток
       бывает нулевым, и «правка по 0 замечаниям» читалась как ошибка. */
    const closed = report.fixedCount ?? count;
    const round = Number(report.attempts) > 1 ? ', со второй попытки' : '';
    return `ответ исправлен по ${closed} ${plural(closed, 'замечанию', 'замечаниям', 'замечаниям')}${round}${by}`;
  }
  if (count) return `${count} ${plural(count, 'замечание', 'замечания', 'замечаний')}, ответ без правки (${report.verdict})${by}`;
  return `замечаний нет${by}`;
}
