/**
 * Дневная сводка качества ответов.
 *
 * Зачем: проверяющий ответ уже пишет строку `[review]` в журнал, но журнал
 * никто не читает — улучшения меряются ощущением. Здесь то же событие
 * складывается в файл на день (одна строка JSON на ответ), чтобы потом
 * свернуть его в таблицу «день / ответов / правилось / находки».
 *
 * Правила:
 *  - запись никогда не ломает ход: ошибки глотаются, ответ важнее статистики;
 *  - файл на день (`<data>/quality/2026-10-25.jsonl`) — его можно открыть
 *    руками, склеить с прошлым и удалить без последствий;
 *  - в записи нет текста ответа и текста вопроса: только признаки. Переписка
 *    остаётся в чатах, статистике она не нужна;
 *  - старые файлы подчищаются сами (по умолчанию 90 дней).
 */
import fs from 'node:fs';
import path from 'node:path';

export const QUALITY_LIMITS = {
  /* Сколько дней хранить: сводка смотрит на неделю, но история нужна и для
     «а как было месяц назад». */
  keepDays: 90,
  /* Больше этого числа файлов за один проход уборки не трогаем. */
  maxFiles: 400,
};

const dayStamp = (date = new Date()) => date.toISOString().slice(0, 10);

export function qualityDir(dataDir) {
  return path.join(dataDir, 'quality');
}

/** Одна строка статистики на ответ. Поле `review` приходит от проверяющего. */
export function qualityRecord({ chatId, projectId, route, model, answerChars, tools, review, usage, now } = {}) {
  const issues = Array.isArray(review?.issues)
    ? review.issues
        .filter((issue) => issue && typeof issue === 'object')
        .slice(0, 20)
        .map((issue) => ({ kind: String(issue.kind || 'other'), severity: String(issue.severity || 'medium') }))
    : [];
  return {
    ts: (now ? new Date(now) : new Date()).toISOString(),
    chat: String(chatId || ''),
    project: String(projectId || ''),
    route: String(route?.profile || 'flash'),
    model: String(route?.model || model || ''),
    chars: Number(answerChars) || 0,
    tools: Array.isArray(tools) ? tools.filter(Boolean).slice(0, 40).map(String) : [],
    checked: Boolean(review?.checked),
    verdict: String(review?.verdict || 'ok'),
    issues,
    fixed: Boolean(review?.fixed),
    attempts: Number(review?.attempts) || 0,
    reviewModel: String(review?.model || ''),
    tokensIn: Number(usage?.tokensIn) || 0,
    tokensOut: Number(usage?.tokensOut) || 0,
  };
}

/** Дописать запись и, если пора, подчистить старые дни. Никогда не бросает. */
export function recordQuality(dataDir, record) {
  try {
    if (!dataDir || !record || !record.ts) return false;
    const dir = qualityDir(dataDir);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${dayStamp(new Date(record.ts))}.jsonl`);
    fs.appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8');
    /* Уборка — не на каждой записи: раз в сотню ходов достаточно. */
    if (Math.random() < 0.01) pruneQuality(dataDir);
    return true;
  } catch {
    return false;
  }
}

/** Удалить файлы старше keepDays. Возвращает число удалённых. */
export function pruneQuality(dataDir, { keepDays = QUALITY_LIMITS.keepDays, now = new Date() } = {}) {
  try {
    const dir = qualityDir(dataDir);
    if (!fs.existsSync(dir)) return 0;
    const border = new Date(now.getTime() - keepDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    let removed = 0;
    for (const name of fs.readdirSync(dir).slice(0, QUALITY_LIMITS.maxFiles)) {
      if (!/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)) continue;
      if (name.slice(0, 10) < border) {
        fs.rmSync(path.join(dir, name), { force: true });
        removed += 1;
      }
    }
    return removed;
  } catch {
    return 0;
  }
}

/** Прочитать записи за N последних дней (по возрастанию даты). */
export function readQuality(dataDir, { days = 7, now = new Date() } = {}) {
  const dir = qualityDir(dataDir);
  const limit = Math.max(1, Math.min(QUALITY_LIMITS.keepDays, Number(days) || 7));
  const out = [];
  const today = new Date(now);
  for (let index = limit - 1; index >= 0; index -= 1) {
    const date = new Date(today.getTime() - index * 24 * 60 * 60 * 1000);
    const file = path.join(dir, `${dayStamp(date)}.jsonl`);
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        out.push(JSON.parse(trimmed));
      } catch {
        /* Битый хвост после падения процесса — не повод терять весь день. */
      }
    }
  }
  return out;
}

const KIND_LABELS = {
  figure: 'числа без опоры',
  file: 'файл обещан, но не создан',
  incomplete: '«готово» при открытых пунктах',
  date: 'дата или год',
  source: 'источник',
  other: 'прочее',
};

export function kindLabel(kind) {
  const key = String(kind || 'other');
  return KIND_LABELS[key] || key;
}

/** Свернуть записи в дни: что было, что правилось, какие находки. */
export function summarizeQuality(records = []) {
  const byDay = new Map();
  for (const record of records) {
    if (!record || typeof record !== 'object') continue;
    const day = String(record.ts || '').slice(0, 10) || 'нет даты';
    if (!byDay.has(day)) {
      byDay.set(day, {
        day,
        answers: 0,
        pro: 0,
        reviewed: 0,
        fixed: 0,
        secondRounds: 0,
        high: 0,
        issues: {},
        tools: {},
        tokensIn: 0,
        tokensOut: 0,
      });
    }
    const row = byDay.get(day);
    row.answers += 1;
    if (record.route === 'pro') row.pro += 1;
    if (record.checked) row.reviewed += 1;
    if (record.fixed) row.fixed += 1;
    if (Number(record.attempts) > 1) row.secondRounds += 1;
    for (const issue of Array.isArray(record.issues) ? record.issues : []) {
      row.issues[issue.kind] = (row.issues[issue.kind] || 0) + 1;
      if (issue.severity === 'high') row.high += 1;
    }
    for (const tool of Array.isArray(record.tools) ? record.tools : []) {
      row.tools[tool] = (row.tools[tool] || 0) + 1;
    }
    row.tokensIn += Number(record.tokensIn) || 0;
    row.tokensOut += Number(record.tokensOut) || 0;
  }
  const rows = [...byDay.values()].sort((a, b) => (a.day < b.day ? 1 : -1));
  const totals = rows.reduce(
    (acc, row) => {
      acc.answers += row.answers;
      acc.pro += row.pro;
      acc.reviewed += row.reviewed;
      acc.fixed += row.fixed;
      acc.secondRounds += row.secondRounds;
      acc.high += row.high;
      acc.tokensIn += row.tokensIn;
      acc.tokensOut += row.tokensOut;
      for (const [kind, count] of Object.entries(row.issues)) acc.issues[kind] = (acc.issues[kind] || 0) + count;
      return acc;
    },
    { answers: 0, pro: 0, reviewed: 0, fixed: 0, secondRounds: 0, high: 0, issues: {}, tokensIn: 0, tokensOut: 0 },
  );
  return { days: rows, totals, checkedAt: new Date().toISOString() };
}

const percent = (part, total) => (total > 0 ? `${Math.round((part / total) * 100)}%` : '—');

/** Текст сводки: таблица по дням и итог. Годится и в админку, и в лог. */
export function formatQuality(summary = { days: [], totals: {} }, { emptyText = 'Статистики пока нет: ответы ещё не записаны.' } = {}) {
  const rows = Array.isArray(summary.days) ? summary.days : [];
  const totals = summary.totals || {};
  if (!rows.length) return emptyText;
  const width = Math.max(...rows.map((row) => String(row.day).length), 10);
  const lines = [`Дневная сводка качества (день / ответов / правилось / находки)`];
  for (const row of rows) {
    const kinds = Object.entries(row.issues || {})
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([kind, count]) => `${kindLabel(kind)} ${count}`)
      .join(', ');
    const fix = row.fixed ? `правка ${row.secondRounds ? `(вторая ${row.secondRounds})` : ''}` : 'без правки';
    lines.push(
      `${String(row.day).padEnd(width)}  ответов ${String(row.answers).padStart(3)}  проверено ${String(row.reviewed).padStart(3)}  ${fix}${kinds ? ` — ${kinds}` : ''}`,
    );
  }
  const kinds = Object.entries(totals.issues || {})
    .sort((a, b) => b[1] - a[1])
    .map(([kind, count]) => `${kindLabel(kind)}: ${count}`)
    .join(', ');
  lines.push(
    `Итого: ответов ${totals.answers || 0}, проверено ${totals.reviewed || 0} (${percent(totals.reviewed || 0, totals.answers || 0)}), правилось ${totals.fixed || 0} (${percent(
      totals.fixed || 0,
      totals.answers || 0,
    )}), сильная модель ${totals.pro || 0} (${percent(totals.pro || 0, totals.answers || 0)}), находок ${totals.high || 0} серьёзных`,
  );
  if (kinds) lines.push(`Находки по видам: ${kinds}`);
  return lines.join('\n');
}
