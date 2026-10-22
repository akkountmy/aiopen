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
 *    но пустого» текста. При серьёзных находках — одна правка ответа, без
 *    второго круга: правка ради правки дороже ошибки.
 *
 * Ревью факультативно: любой сбой возвращает исходный ответ (fail-open).
 */

import { ESCALATION, REVIEW } from './config.mjs';

/* Мелкие числа (годы, номера, проценты-одиночки) не проверяем: они почти
   всегда повторяются из запроса, а не берутся из расчётов. */
const MIN_FIGURE_DIGITS = 3;

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
 * Детерминированные проверки ответа. `toolDigest` — склеенный текст
 * результатов инструментов за ход, `createdFiles` — файлы, которые реально
 * появились в проекте.
 */
export function checkAnswer({ answer = '', toolDigest = '', createdFiles = [], maxIssues = 12 } = {}) {
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

Ответ — строгий JSON без пояснений:
{"verdict":"ok|fix","issues":[{"kind":"figure|file|incomplete|unit|promise","severity":"high|medium","quote":"фрагмент ответа","hint":"что исправить"}]}
Если всё в порядке — {"verdict":"ok","issues":[]}.`;

/**
 * Модельная часть ревью. Возвращает {checked, verdict, issues}; при любой
 * ошибке — {checked:false} и пустой список, чтобы не блокировать ответ.
 */
export async function reviewWithModel({ userQuestion = '', answer = '', digest = '', createdFiles = [], complete } = {}) {
  if (typeof complete !== 'function') return { checked: false, verdict: 'ok', issues: [] };
  const prompt = [
    `Запрос пользователя:\n${String(userQuestion || '').slice(0, 2000)}`,
    `Ответ, который будет выдан:\n${String(answer || '').slice(0, 12000)}`,
    `Результаты инструментов (источник фактов):\n${String(digest || 'инструменты не вызывались').slice(0, REVIEW.digestChars)}`,
    createdFiles.length ? `Созданные файлы: ${createdFiles.join(', ')}` : 'Файлы не создавались.',
  ].join('\n\n');
  try {
    const raw = await complete(
      [
        { role: 'system', content: CHECKLIST },
        { role: 'user', content: prompt },
      ],
      { maxTokens: 900, effort: 'high' },
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

/** Одна правка ответа по замечаниям. Возвращает текст или '' при сбое. */
export async function reviseAnswer({ userQuestion = '', answer = '', issues = [], digest = '', complete } = {}) {
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
        { role: 'system', content: FIX_INSTRUCTION },
        { role: 'user', content: prompt },
      ],
      { maxTokens: 4000, effort: 'high' },
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
 * Полный проход ревью: детерминированные проверки, затем модель, затем
 * одна правка при серьёзных находках. Возвращает итоговый текст и отчёт.
 */
export async function reviewAnswer({ userQuestion = '', answer = '', history = [], createdFiles = [], complete, depth = 0, tools = [] } = {}) {
  const report = { checked: false, verdict: 'ok', issues: [], fixed: false, modelChecked: false };
  if (!needsReview({ answer, tools, depth })) return { text: String(answer || ''), report };

  const digest = buildDigest(history);
  const deterministic = checkAnswer({ answer, toolDigest: digest, createdFiles });
  let issues = deterministic;
  report.issues = issues.slice();

  if (complete) {
    const model = await reviewWithModel({ userQuestion, answer, digest, createdFiles, complete });
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
  if (!high.length || !REVIEW.fix || !complete) {
    report.verdict = issues.length ? 'issues' : 'ok';
    report.checked = true;
    return { text: String(answer || ''), report };
  }

  const revised = await reviseAnswer({ userQuestion, answer, issues: high, digest, complete });
  if (!revised) {
    report.verdict = 'issues';
    report.checked = true;
    return { text: String(answer || ''), report };
  }
  /* Проверяем правку теми же правилами: правка не должна добавить новых цифр. */
  const again = checkAnswer({ answer: revised, toolDigest: digest, createdFiles });
  const newHigh = again.filter((issue) => issue.severity === 'high' && !issues.some((item) => item.quote === issue.quote));
  if (newHigh.length) {
    report.verdict = 'issues';
    report.checked = true;
    return { text: String(answer || ''), report };
  }
  report.fixed = true;
  report.verdict = 'fixed';
  report.checked = true;
  report.issues = again.slice(0, REVIEW.maxIssues);
  return { text: revised, report };
}

/** Строка для лога сервера. */
export function describeReview(report) {
  if (!report?.checked) return '';
  const count = report.issues?.length || 0;
  if (report.fixed) return `правка ответа по ${count} замечаниям`;
  if (count) return `${count} замечаний, ответ без правки (${report.verdict})`;
  return 'замечаний нет';
}
