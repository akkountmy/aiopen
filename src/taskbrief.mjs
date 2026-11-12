/**
 * brief-core — движок «реестра задания» (task brief).
 *
 * Задача, которую он решает: человек присылает постановку из многих пунктов,
 * переменных и чисел, а агент в длинной сессии теряет пункты. Здесь постановка
 * превращается в машиночитаемый реестр, где
 *
 *   P1..Pn — пункты ДОСЛОВНО из постановки (не пересказ: пересказ и есть потеря),
 *   V1..Vm — переменные (значения, единицы, откуда взяты),
 *   Q1..Qk — открытые вопросы (то, чего в постановке нет),
 *   C1..Ck — проверки, которые обязаны пройти до слова «готово».
 *
 * Идеи взяты из трёх проектов (не код, а дисциплина):
 *  - github/spec-kit: разделение spec / plan / tasks, идентификаторы задач,
 *    чек-лист требований как отдельный артефакт;
 *  - Fission-AI/OpenSpec: требование с идентификатором + сценарий
 *    Given/When/Then как критерий приёмки; `validate` как механическая проверка;
 *  - eyaltoledano/claude-task-master: задачи и подзадачи со статусом и
 *    зависимостями в машинном файле, а не в голове модели.
 *
 * Модуль чистый: ни файловой системы, ни сети, ни процесса. Это копия
 * D:\DSHarness-0.1\plugins\dsh-task-brief\lib\brief-core.mjs — держите их
 * одинаковыми: test/taskbrief.mjs сверяет вердикты обеих копий на одних и
 * тех же реестрах, и любое расхождение валит тест. Иначе выйдет обычная беда
 * двух реализаций одной проверки: «на сайте зелёно, а в работе нет».
 */

export const SCHEMA = 'dsh.task-brief/1';

export const POINT_STATUSES = ['todo', 'doing', 'done', 'blocked', 'dropped'];
export const POINT_KINDS = ['requirement', 'number', 'constraint', 'variable', 'deliverable', 'question'];
export const VAR_STATUSES = ['set', 'assumed', 'open'];

/** Статусы, при которых пункт считается закрытым. */
const CLOSED = new Set(['done', 'dropped']);

/**
 * Идентификаторы. Стабильны: P1 остаётся P1 до конца задания, даже если пункт
 * переписан, — иначе в отчёте «P7 готов» указывает уже не туда.
 */
export function makeId(prefix, index) {
  return `${prefix}${index}`;
}

export function briefId(now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}`;
  const tail = Math.random().toString(36).slice(2, 6).padEnd(4, '0');
  return `tb-${stamp}-${tail}`;
}

function text(value) {
  return typeof value === 'string' ? value.trim() : value === undefined || value === null ? '' : String(value).trim();
}

function list(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null || value === '') return [];
  return [value];
}

/** Строка → критерий приёмки. Принимает и «текст», и {given, when, then}. */
export function normalizeAcceptance(raw) {
  if (typeof raw === 'string') {
    const one = text(raw);
    if (!one) return null;
    const parts = one.split(/\s*;\s*|\s{2,}/).filter(Boolean);
    if (parts.length === 3 && /^(дано|given)/i.test(parts[0])) {
      return { given: parts[0], when: parts[1], then: parts[2] };
    }
    return { given: '', when: '', then: one };
  }
  if (raw && typeof raw === 'object') {
    const given = text(raw.given);
    const when = text(raw.when);
    const then = text(raw.then) || text(raw.expect) || text(raw.result);
    if (!given && !when && !then) return null;
    return { given, when, then };
  }
  return null;
}

export function formatAcceptance(criterion) {
  if (!criterion) return '';
  const { given, when, then } = criterion;
  if (given && when && then) return `${given} → ${when} → ${then}`;
  if (when && then) return `${when} → ${then}`;
  return then || when || given || '';
}

function normalizePoint(raw, index) {
  const source = raw && typeof raw === 'object' ? raw : { text: raw };
  const kindRaw = text(source.kind).toLowerCase();
  const kind = POINT_KINDS.includes(kindRaw) ? kindRaw : 'requirement';
  const statusRaw = text(source.status).toLowerCase();
  const status = POINT_STATUSES.includes(statusRaw) ? statusRaw : 'todo';
  return {
    id: text(source.id) || makeId('P', index + 1),
    text: text(source.text),
    source: text(source.source), // дословный фрагмент постановки, если text — уже нормализация
    kind,
    refs: list(source.refs).map(text).filter(Boolean),
    acceptance: list(source.acceptance)
      .map(normalizeAcceptance)
      .filter(Boolean),
    status,
    evidence: list(source.evidence).map(text).filter(Boolean),
    note: text(source.note),
  };
}

function normalizeVariable(raw, index) {
  const source = raw && typeof raw === 'object' ? raw : { name: raw };
  const value = text(source.value);
  const declared = text(source.status).toLowerCase();
  const status = VAR_STATUSES.includes(declared) ? declared : value ? 'set' : 'open';
  return {
    id: text(source.id) || makeId('V', index + 1),
    name: text(source.name) || text(source.id) || makeId('V', index + 1),
    meaning: text(source.meaning) || text(source.description),
    value: status === 'open' ? '' : value,
    unit: text(source.unit),
    source: text(source.source), // user — из постановки, assumed — принято по умолчанию
    status,
  };
}

function normalizeQuestion(raw, index) {
  const source = raw && typeof raw === 'object' ? raw : { text: raw };
  const answer = text(source.answer);
  return {
    id: text(source.id) || makeId('Q', index + 1),
    text: text(source.text) || text(source.question),
    status: answer ? 'answered' : text(source.status) || 'open',
    answer,
  };
}

function normalizeCheck(raw, index) {
  const source = raw && typeof raw === 'object' ? raw : { text: raw };
  return {
    id: text(source.id) || makeId('C', index + 1),
    text: text(source.text),
    done: source.done === true,
    evidence: text(source.evidence),
  };
}

/**
 * Приведение входа к каноническому реестру. Ничего не проверяет и не бросает:
 * мусор отбрасывается, идентификаторы проставляются, пустой реестр остаётся
 * пустым — а сказать «это не готово» должен validate().
 */
export function normalizeBrief(input = {}, { now = new Date(), workspace = '' } = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const iso = now.toISOString();
  const points = list(source.points).map(normalizePoint);
  const usedPointIds = new Set(points.map((point) => point.id));
  /* Дубли идентификаторов — не повод молча переписать: переносим на свободный. */
  const seen = new Set();
  points.forEach((point, index) => {
    if (seen.has(point.id)) {
      let candidate = index + 1;
      while (usedPointIds.has(makeId('P', candidate))) candidate += 1;
      point.id = makeId('P', candidate);
      usedPointIds.add(point.id);
    }
    seen.add(point.id);
  });

  return {
    schema: SCHEMA,
    id: text(source.id) || briefId(now),
    title: text(source.title),
    goal: text(source.goal),
    workspace: text(source.workspace) || workspace,
    createdAt: text(source.createdAt) || iso,
    updatedAt: iso,
    definitionOfDone: list(source.definitionOfDone).map(text).filter(Boolean),
    nonGoals: list(source.nonGoals).map(text).filter(Boolean),
    variables: list(source.variables).map(normalizeVariable),
    points,
    openQuestions: list(source.openQuestions).concat(
      /* Вопрос можно объявить и пунктом kind=question — он обязан попасть в список. */
      points.filter((point) => point.kind === 'question').map((point) => ({
        id: text(point.id).replace(/^P/, 'Q'),
        text: point.text,
        status: point.status === 'done' ? 'answered' : 'open',
        answer: point.note,
      })),
    ).map(normalizeQuestion),
    checks: list(source.checks).map(normalizeCheck),
    history: list(source.history).map((entry) => ({
      at: text(entry?.at) || iso,
      event: text(entry?.event),
      detail: text(entry?.detail),
    })),
  };
}

function sameText(a, b) {
  const norm = (value) => String(value || '').toLowerCase().replace(/\s+/g, ' ').replace(/[«»"'`]/g, '').trim();
  return norm(a) === norm(b);
}

/**
 * Механическая проверка реестра. Возвращает вердикт и список замечаний:
 * каждое замечание — код, важность, место и что сделать. Это и есть ответ на
 * «ты ничего не забыл?»: забытое видно как незакрытый пункт, а не как надежда.
 *
 * `finalize: true` — режим перед словом «готово»: незакрытые пункты становятся
 * ошибками, а не предупреждениями.
 */
export function validateBrief(brief, { finalize = false } = {}) {
  const issues = [];
  const add = (code, severity, message, extra = {}) => issues.push({ code, severity, message, ...extra });

  const points = Array.isArray(brief?.points) ? brief.points : [];
  const variables = Array.isArray(brief?.variables) ? brief.variables : [];
  const questions = Array.isArray(brief?.openQuestions) ? brief.openQuestions : [];

  if (!text(brief?.title)) add('NO_TITLE', 'warn', 'У задания нет короткого названия — в списке заданий его будет не узнать.');
  if (!text(brief?.goal)) add('NO_GOAL', 'error', 'Не сформулирована цель: непонятно, что считать результатом.');
  if (!list(brief?.definitionOfDone).length) {
    add('NO_DOD', 'error', 'Нет определения готовности (definitionOfDone): «сделано» останется на усмотрение агента.');
  }
  if (!points.length) add('NO_POINTS', 'error', 'В реестре нет ни одного пункта: постановка не разобрана.');

  const variableIds = new Set(variables.map((variable) => variable.id));

  points.forEach((point) => {
    const where = { pointId: point.id };
    if (!text(point.text)) add('POINT_NO_TEXT', 'error', `Пункт ${point.id}: пустой текст — такой пункт нельзя ни выполнить, ни проверить.`, where);
    if (!text(point.source) && point.kind === 'requirement') {
      add('POINT_NO_SOURCE', 'warn', `Пункт ${point.id}: нет дословного фрагмента постановки — проверьте, что пересказ не потерял условие.`, where);
    }
    if (!CLOSED.has(point.status) && !point.acceptance.length && point.kind !== 'question') {
      add('NO_ACCEPTANCE', 'error', `Пункт ${point.id}: нет критерия приёмки. Без него «сделано» — это мнение, а не факт.`, where);
    }
    if (point.status === 'done' && !point.evidence.length) {
      add('DONE_WITHOUT_EVIDENCE', 'error', `Пункт ${point.id} закрыт без доказательства: нужен файл, команда, ссылка или тест.`, where);
    }
    if (point.status === 'dropped' && !text(point.note)) {
      add('DROPPED_WITHOUT_REASON', 'error', `Пункт ${point.id} снят без причины — через неделю никто не вспомнит, почему.`, where);
    }
    if (point.status === 'blocked' && !text(point.note)) {
      add('BLOCKED_WITHOUT_REASON', 'warn', `Пункт ${point.id} заблокирован, но причина не записана.`, where);
    }
    point.refs.forEach((ref) => {
      if (!variableIds.has(ref)) add('DANGLING_VAR', 'error', `Пункт ${point.id} ссылается на переменную ${ref}, которой нет в реестре.`, { ...where, variableId: ref });
    });
    if (!CLOSED.has(point.status)) {
      add(
        'POINT_OPEN',
        finalize && point.status !== 'todo' ? 'error' : finalize ? 'error' : 'warn',
        `Пункт ${point.id} не закрыт (статус ${point.status}): ${text(point.text).slice(0, 120)}`,
        where,
      );
    }
    const twin = points.find((other) => other.id !== point.id && sameText(other.text, point.text));
    if (twin && points.indexOf(twin) < points.indexOf(point)) {
      add('DUPLICATE_POINT', 'warn', `Пункты ${twin.id} и ${point.id} совпадают по тексту — возможно, один и тот же пункт разобран дважды.`, where);
    }
  });

  variables.forEach((variable) => {
    if (variable.status === 'open' || !text(variable.value)) {
      add('VAR_UNRESOLVED', 'warn', `Переменная ${variable.id} (${variable.name}) без значения: ${variable.meaning || 'смысл не описан'}.`, {
        variableId: variable.id,
      });
    }
    if (variable.status === 'assumed') {
      add('VAR_ASSUMED', 'warn', `Переменная ${variable.id} (${variable.name}) принята по умолчанию (${variable.value || '—'}) — подтвердите у человека.`, {
        variableId: variable.id,
      });
    }
  });

  questions
    .filter((question) => question.status !== 'answered' && !text(question.answer))
    .forEach((question) => {
      add('QUESTION_OPEN', 'warn', `Открытый вопрос ${question.id}: ${question.text}`, { questionId: question.id });
    });

  (Array.isArray(brief?.checks) ? brief.checks : [])
    .filter((check) => !check.done)
    .forEach((check) => {
      add('CHECK_UNDONE', 'warn', `Проверка ${check.id} не пройдена: ${check.text}`, { checkId: check.id });
    });

  const errors = issues.filter((issue) => issue.severity === 'error');
  const warnings = issues.filter((issue) => issue.severity === 'warn');
  const coverage = coverageOf(brief);
  const verdict = errors.length ? 'blocked' : coverage.open > 0 ? 'incomplete' : 'ready';
  return { verdict, coverage, errors, warnings, issues };
}

export function coverageOf(brief) {
  const points = Array.isArray(brief?.points) ? brief.points : [];
  const byStatus = { todo: 0, doing: 0, done: 0, blocked: 0, dropped: 0 };
  points.forEach((point) => {
    if (byStatus[point.status] === undefined) byStatus.todo += 1;
    else byStatus[point.status] += 1;
  });
  const open = byStatus.todo + byStatus.doing + byStatus.blocked;
  return {
    total: points.length,
    ...byStatus,
    open,
    donePercent: points.length ? Math.round(((byStatus.done + byStatus.dropped) / points.length) * 100) : 0,
  };
}

const STATUS_MARK = { todo: '☐', doing: '◐', done: '☑', blocked: '⛔', dropped: '⊘' };
const VERDICT_RU = { ready: 'готово', incomplete: 'не готово: пункты открыты', blocked: 'не готово: есть ошибки' };

/** Реестр для чата: то, что человек должен увидеть в первом ответе. */
export function renderRegister(brief) {
  const lines = [];
  const coverage = coverageOf(brief);
  lines.push(`## ${brief.title || 'Задание'} — ${coverage.done}/${coverage.total} закрыто (${coverage.donePercent}%)`);
  if (brief.goal) lines.push(`**Цель:** ${brief.goal}`);
  if (brief.definitionOfDone.length) {
    lines.push('**Готово, когда:**');
    brief.definitionOfDone.forEach((line) => lines.push(`- ${line}`));
  }
  if (brief.nonGoals.length) {
    lines.push('**Не входит в задачу:**');
    brief.nonGoals.forEach((line) => lines.push(`- ${line}`));
  }
  if (brief.points.length) {
    lines.push('', '| Пункт | Что сделать | Статус | Критерий приёмки | Доказательство |', '|---|---|---|---|---|');
    brief.points.forEach((point) => {
      const criteria = point.acceptance.map(formatAcceptance).filter(Boolean).join('; ');
      const evidence = point.evidence.length
        ? point.evidence.join(', ')
        : point.status === 'dropped' && point.note
          ? point.note
          : '—';
      lines.push(
        `| ${point.id} | ${mdCell(point.text)} | ${STATUS_MARK[point.status] || '☐'} ${point.status} | ${mdCell(criteria || '—')} | ${mdCell(evidence)} |`,
      );
    });
  }
  if (brief.variables.length) {
    lines.push('', '| Переменная | Смысл | Значение | Статус |', '|---|---|---|---|');
    brief.variables.forEach((variable) => {
      const value = variable.value ? `${variable.value}${variable.unit ? ` ${variable.unit}` : ''}` : '—';
      lines.push(`| ${variable.id} · ${mdCell(variable.name)} | ${mdCell(variable.meaning || '—')} | ${mdCell(value)} | ${variable.status} |`);
    });
  }
  const open = brief.openQuestions.filter((question) => question.status !== 'answered' && !question.answer);
  if (open.length) {
    lines.push('', '**Открытые вопросы:**');
    open.forEach((question) => lines.push(`- ${question.id}: ${question.text}`));
  }
  if (brief.checks.length) {
    lines.push('', '**Проверки:**');
    brief.checks.forEach((check) => lines.push(`- ${check.done ? '☑' : '☐'} ${check.id}: ${check.text}`));
  }
  if (brief.workspace) lines.push('', `_Рабочая папка: ${brief.workspace}; реестр: ${brief.id}_`);
  return lines.join('\n');
}

/** Отчёт проверки: вердикт, покрытие, замечания с готовым действием. */
export function renderCheck(report, { brief = null, limit = 40 } = {}) {
  const lines = [`**Вердикт: ${report.verdict}** — ${VERDICT_RU[report.verdict] || report.verdict}`];
  const c = report.coverage;
  lines.push(
    `Покрытие: ${c.done}/${c.total} готово, ${c.doing} в работе, ${c.todo} не начато, ${c.blocked} заблокировано, ${c.dropped} снято (${c.donePercent}%).`,
  );
  if (!report.issues.length) {
    lines.push('Замечаний нет.');
  } else {
    const shown = report.issues.slice(0, limit);
    lines.push('', '| Код | Где | Что не так |', '|---|---|---|');
    shown.forEach((issue) => {
      const where = issue.pointId || issue.variableId || issue.questionId || issue.checkId || '—';
      lines.push(`| ${issue.severity === 'error' ? '❗' : '⚠'} ${issue.code} | ${where} | ${mdCell(issue.message)} |`);
    });
    if (report.issues.length > shown.length) lines.push('', `…и ещё ${report.issues.length - shown.length} замечаний.`);
  }
  if (brief) {
    const open = brief.points.filter((point) => !CLOSED.has(point.status));
    if (open.length) {
      lines.push('', '**Что осталось:**');
      open.forEach((point) => lines.push(`- ${point.id} (${point.status}): ${point.text}`));
    }
  }
  return lines.join('\n');
}

/** Пункты, которые обязаны закрыться: для таблицы покрытия в финальном ответе. */
export function coverageTable(brief) {
  const lines = ['| Пункт | Статус | Доказательство |', '|---|---|---|'];
  (brief.points || []).forEach((point) => {
    const evidence = point.evidence.length ? point.evidence.join(', ') : point.status === 'dropped' ? point.note : '—';
    lines.push(`| ${point.id} | ${STATUS_MARK[point.status] || '☐'} ${point.status} | ${mdCell(evidence)} |`);
  });
  return lines.join('\n');
}

function mdCell(value) {
  return String(value || '')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, ' ')
    .trim();
}

/** Реестр в markdown-файл (человеческая копия рядом с json). */
export function renderBriefMarkdown(brief) {
  const report = validateBrief(brief);
  return [
    `# ${brief.title || 'Задание'} (${brief.id})`,
    '',
    `Создано: ${brief.createdAt}`,
    `Обновлено: ${brief.updatedAt}`,
    brief.workspace ? `Рабочая папка: ${brief.workspace}` : '',
    '',
    renderRegister(brief),
    '',
    '## Проверка',
    renderCheck(report, { brief }),
    '',
    /* Таблица покрытия — то, что человек читает первым: по каждому пункту
       видно статус и доказательство. Без неё копия .md отвечает на «что
       написано», но не на «что сделано». */
    '## Покрытие пунктов',
    coverageTable(brief),
    '',
  ]
    .filter((line) => line !== '')
    .join('\n');
}

/**
 * Обновление существующего реестра новой версией постановки.
 *
 * Главное правило: ПРОГРЕСС ДОРОЖЕ ТЕКСТА. Если в новом входе у пункта не
 * сказано «status», его статус, доказательства и заметка остаются прежними —
 * иначе повторный разбор постановки («я тут дописал три пункта») молча стёр бы
 * всю сделанную работу. Так же с переменными: пустое значение не затирает
 * уже установленное.
 */
export function mergeBrief(existing, input = {}, opts = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const incoming = normalizeBrief(
    {
      ...source,
      id: text(source.id) || existing.id,
      createdAt: text(source.createdAt) || existing.createdAt,
      title: text(source.title) || existing.title,
      goal: text(source.goal) || existing.goal,
      definitionOfDone: list(source.definitionOfDone).length ? source.definitionOfDone : existing.definitionOfDone,
      nonGoals: list(source.nonGoals).length ? source.nonGoals : existing.nonGoals,
    },
    opts,
  );

  const prevPoints = new Map((existing.points || []).map((point) => [point.id, point]));
  incoming.points = incoming.points.map((point, index) => {
    const prev = prevPoints.get(point.id);
    if (!prev) return point;
    const rawItem = Array.isArray(source.points) ? source.points[index] : null;
    const statusGiven = Boolean(rawItem && typeof rawItem === 'object' && rawItem.status !== undefined);
    return {
      ...point,
      status: statusGiven ? point.status : prev.status,
      evidence: point.evidence.length ? point.evidence : prev.evidence,
      note: point.note || prev.note,
      acceptance: point.acceptance.length ? point.acceptance : prev.acceptance,
      source: point.source || prev.source,
    };
  });
  /* Пункты, которых в новом входе нет, не выбрасываем: молчание — не приказ
     удалить. Снятый пункт помечают явно (status: dropped). */
  const incomingIds = new Set(incoming.points.map((point) => point.id));
  (existing.points || []).forEach((point) => {
    if (!incomingIds.has(point.id)) incoming.points.push(point);
  });

  const prevVars = new Map((existing.variables || []).map((variable) => [variable.id, variable]));
  incoming.variables = incoming.variables.map((variable) => {
    const prev = prevVars.get(variable.id);
    if (!prev) return variable;
    const keepValue = !variable.value && prev.value;
    return {
      ...variable,
      value: keepValue ? prev.value : variable.value,
      status: keepValue ? prev.status : variable.status,
      meaning: variable.meaning || prev.meaning,
      source: variable.source || prev.source,
    };
  });

  const prevQuestions = new Map((existing.openQuestions || []).map((question) => [question.id, question]));
  incoming.openQuestions = incoming.openQuestions.map((question) => {
    const prev = prevQuestions.get(question.id);
    if (!prev) return question;
    return question.answer ? question : { ...question, status: prev.status, answer: prev.answer };
  });

  incoming.history = existing.history || [];
  return incoming;
}

/**
 * Добавить историю. История — не украшение: по ней видно, что пункт реально
 * трогали в этой сессии, а не закрыли одной фразой.
 */
export function withHistory(brief, event, detail = '', now = new Date()) {
  const history = Array.isArray(brief.history) ? brief.history.slice(-99) : [];
  history.push({ at: now.toISOString(), event: text(event), detail: text(detail) });
  return { ...brief, history, updatedAt: now.toISOString() };
}
