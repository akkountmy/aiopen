/**
 * Обрезка результатов инструментов и автосжатие истории — то, что в локальном
 * харнессе делает плагин dsh-trim, но здесь без плагинов: сервис — один
 * процесс, результат инструмента — обычная строка, а история чата — массив
 * сообщений, поэтому сжимать их можно прямо перед отправкой модели.
 *
 * Правила, которые здесь соблюдаются:
 *  1. Ничего не теряем: всё, что выкинуто из подсказки, сначала пишется в
 *     файл `.trims/…` внутри проекта — модель может открыть его read_file.
 *  2. Детерминированно: одинаковый вход даёт одинаковый выход, чтобы
 *     провайдерский кеш префикса продолжал попадать.
 *  3. Не раздуваем: compact() никогда не возвращает больше, чем получил.
 *  4. Малые результаты не трогаем: ниже compactAboveChars — как есть.
 *  5. Осознанное чтение не трогаем: read_file, read_document и use_skill
 *     проходят дословно (иначе модель теряла бы то, что сама попросила).
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { estimateTokens } from './util.mjs';

export const TRIM_DEFAULTS = {
  /* Меньше этого — не трогаем вовсе: экономия не стоит риска. */
  compactAboveChars: 1200,
  /* Больше этого не отдаём в подсказку: вырезаем середину и даём ссылку на файл. */
  maxInlineChars: 8000,
  headChars: 3200,
  tailChars: 2200,
  /* Инструменты, чей ответ — осознанное чтение или инструкция: дословно. */
  skipTools: [
    'read_file',
    'read_document',
    'use_skill',
    'analyze_image',
    'remember',
    'create_word',
    'create_excel',
    'create_pptx',
    'create_pdf',
  ],
  keepDiffContextLines: 2,
  /* Пока контекст свежий, средние результаты идут как есть: качество важнее
     экономии. Сжатие включается, когда истории уже много. */
  adaptive: true,
  adaptivePressureTokens: 20000,
  /* Есть ли вообще смысл сжимать: мельче 5% выигрыша — не трогаем текст. */
  minShrinkRatio: 0.05,
  spillDir: '.trims',
  /* Старые выгрузки чистим, чтобы папка проекта не росла бесконечно. */
  maxSpillFiles: 60,
  /* Ниже этого автосжатие истории не о чем рассказывать модели. */
  minHistoryChars: 2500,
};

/** Настройки обрезки: значения по умолчанию плюс переопределения из config.mjs. */
export function resolveTrimConfig(overrides = {}) {
  const merged = { ...TRIM_DEFAULTS };
  for (const [key, value] of Object.entries(overrides || {})) {
    if (value === undefined || value === null) continue;
    merged[key] = value;
  }
  if (Array.isArray(merged.skipTools)) merged.skipTools = new Set(merged.skipTools);
  if (!(merged.skipTools instanceof Set)) merged.skipTools = new Set(TRIM_DEFAULTS.skipTools);
  return merged;
}

/* ------------------------------- сжатие ------------------------------- */

const ANSI = /\u001b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\))/g;

/** Управляющие последовательности терминала: в подсказке модели они мусор. */
export function stripEscapes(text) {
  return String(text ?? '').replace(ANSI, '');
}

/** Пустые строки: три и больше подряд превращаются в две. */
export function collapseBlankRuns(text) {
  return String(text ?? '').replace(/\n[ \t]*\n(?:[ \t]*\n)+/g, '\n\n');
}

const FOLDED = /\(×\d+\)$/;

/** Похоже на строку таблицы или CSV: такие не сворачиваем, даже если подряд. */
function dataRow(line) {
  if (line.startsWith('|') || line.startsWith('+')) return true;
  const commas = (line.match(/,/g) || []).length;
  return commas >= 2 && line.length < 400;
}

/**
 * Подряд идущие одинаковые строки: `x`, `x`, `x` → `x (×3)`.
 * Меняем только когда строка длиннее 12 знаков и повторяется 3 раза и более,
 * а результат короче исходного — иначе текст не трогаем.
 */
export function foldRepeatedLines(text, { minRun = 3, minChars = 12 } = {}) {
  const source = String(text ?? '');
  if (!source.includes('\n')) return source;
  const lines = source.split('\n');
  const out = [];
  let changed = false;
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    let run = 1;
    while (index + run < lines.length && lines[index + run] === line) run++;
    const foldable = run >= minRun && line.length >= minChars && !FOLDED.test(line) && !dataRow(line);
    if (foldable) {
      const folded = `${line} (×${run})`;
      if (folded.length < line.length * run - run) {
        out.push(folded);
        changed = true;
        index += run;
        continue;
      }
    }
    out.push(line);
    index++;
  }
  return changed ? out.join('\n') : source;
}

/**
 * Длинные куски неизменённых строк в diff-подобном тексте: оставляем
 * keep строк вокруг изменений, остальное — счётчиком.
 */
export function collapseDiffContext(text, { keep = 2 } = {}) {
  const source = String(text ?? '');
  const lines = source.split('\n');
  const isHunk = lines.some((line) => line.startsWith('@@'));
  if (!isHunk) return source;
  const isContext = (line) => line.startsWith(' ') || line === '';
  const out = [];
  let index = 0;
  let changed = false;
  while (index < lines.length) {
    if (!isContext(lines[index])) {
      out.push(lines[index]);
      index++;
      continue;
    }
    let end = index;
    while (end < lines.length && isContext(lines[end])) end++;
    const run = end - index;
    /* Края блока важны: они примыкают к изменениям (или к границам файла). */
    const inner = run - keep * 2;
    if (inner >= 4) {
      out.push(...lines.slice(index, index + keep));
      out.push(`⟮… ${inner} строк без изменений⟯`);
      out.push(...lines.slice(end - keep, end));
      changed = true;
    } else {
      out.push(...lines.slice(index, end));
    }
    index = end;
  }
  return changed ? out.join('\n') : source;
}

/**
 * Детерминированное сжатие без потери уникального содержимого.
 * Возвращает исходный текст, если сжатие не дало выигрыша или текст вырос.
 */
export function compactText(text, config = {}) {
  const source = String(text ?? '');
  if (!source) return source;
  const keep = Number(config.keepDiffContextLines) >= 0 ? Number(config.keepDiffContextLines) : 2;
  let result = stripEscapes(source);
  result = collapseBlankRuns(result);
  result = collapseDiffContext(result, { keep });
  result = foldRepeatedLines(result);
  if (result.length >= source.length) return source;
  return result;
}

/* ------------------------------ выгрузка ------------------------------ */

function spillStamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

function pruneSpills(dir, limit) {
  try {
    const entries = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => ({ name: entry.name, full: path.join(dir, entry.name), time: fs.statSync(path.join(dir, entry.name)).mtimeMs }))
      .sort((a, b) => a.time - b.time);
    for (let index = 0; index < entries.length - limit; index++) {
      try {
        fs.unlinkSync(entries[index].full);
      } catch {
        /* файл уже удалён — не повод падать */
      }
    }
  } catch {
    /* папки нет — чистить нечего */
  }
}

/**
 * Полный текст во временный файл проекта. Возвращает путь относительно корня
 * проекта (его можно отдать модели) или null, если записать не удалось:
 * обрезка не должна ломать инструмент.
 */
export function spillText({ workspace, label = 'result', text, config = {} }) {
  const settings = config.spillDir ? config : resolveTrimConfig(config);
  if (!workspace || typeof text !== 'string' || !text) return null;
  try {
    const dir = path.join(workspace, settings.spillDir);
    fs.mkdirSync(dir, { recursive: true });
    const safeLabel = String(label || 'result').replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 24) || 'result';
    const name = `${spillStamp()}-${safeLabel}-${crypto.randomBytes(3).toString('hex')}.txt`;
    fs.writeFileSync(path.join(dir, name), text, 'utf8');
    pruneSpills(dir, settings.maxSpillFiles);
    return `${settings.spillDir}/${name}`;
  } catch {
    return null;
  }
}

const EXIT_MARKER = /^\s*\[(exit code|код выхода)[^\]]*\]\s*$/i;

/** Хвостовые служебные пометки (`[exit code: 1]`) остаются в конце всегда. */
function tailMarkers(text) {
  const lines = String(text ?? '').split('\n');
  const markers = [];
  for (let index = lines.length - 1; index >= 0 && markers.length < 3; index--) {
    if (!lines[index].trim()) continue;
    if (!EXIT_MARKER.test(lines[index])) break;
    markers.unshift(lines[index]);
  }
  return markers;
}

/**
 * Ограниченная выжимка: начало, метка о сокращении и конец. Середина не
 * теряется — она лежит в файле, путь к которому есть в самой выжимке.
 */
export function boundPreview(text, { head = 3200, tail = 2200, note = '' } = {}) {
  const source = String(text ?? '');
  const limit = head + tail;
  if (source.length <= limit) return source;
  const markers = tailMarkers(source);
  const markerText = markers.length ? `\n${markers.join('\n')}` : '';
  const body = source.replace(/\s+$/, '');
  const headText = body.slice(0, head);
  const tailText = tail > 0 ? body.slice(Math.max(head, body.length - tail)) : '';
  const cut = body.length - headText.length - tailText.length;
  const middle = note || `⟮… сокращено ${cut} знаков ⟯`;
  return `${headText}\n\n${middle}${tailText ? `\n\n${tailText}` : ''}${markerText}`;
}

/* --------------------------- результат инструмента --------------------------- */

function savedNote({ before, after, spill }) {
  const tail = spill ? ` Полный текст: ${spill} — прочитай его read_file, если нужны детали.` : '';
  return `[Результат сокращён: ${before} → ${after} знаков.${tail}]`;
}

/**
 * Главная точка входа: результат инструмента перед отправкой модели.
 *
 * @param {object} params
 * @param {string} params.name имя инструмента
 * @param {string} params.text ответ инструмента
 * @param {string} params.workspace папка проекта (для выгрузки полного текста)
 * @param {number} [params.pressure] сколько токенов уже в истории
 * @param {object} [params.config] настройки обрезки
 * @returns {{text: string, applied: 'none'|'compacted'|'preview', before: number,
 *            after: number, spill: string|null, savedChars: number}}
 */
export function trimToolResult({ name, text, workspace, pressure = 0, config = {} }) {
  const settings = config.skipTools ? config : resolveTrimConfig(config);
  const source = typeof text === 'string' ? text : String(text ?? '');
  const idle = { text: source, applied: 'none', before: source.length, after: source.length, spill: null, savedChars: 0 };
  if (!source || source.length < settings.compactAboveChars) return idle;
  if (settings.skipTools.has(name)) return idle;

  const fresh = settings.adaptive && pressure < settings.adaptivePressureTokens;
  /* Свежий контекст и текст влезает как есть — не трогаем: качество важнее. */
  if (fresh && source.length <= settings.maxInlineChars) return idle;

  const compacted = compactText(source, settings);
  const worthIt = compacted.length < source.length * (1 - settings.minShrinkRatio);
  const compactedIsSmall = compacted.length <= settings.maxInlineChars;

  if (worthIt && compactedIsSmall) {
    return {
      text: compacted,
      applied: 'compacted',
      before: source.length,
      after: compacted.length,
      spill: null,
      savedChars: source.length - compacted.length,
    };
  }

  /* Дальше — только выжимка: полный текст обязателен в файле, иначе теряем данные. */
  const spill = spillText({ workspace, label: name, text: source, config: settings });
  if (!spill) {
    /* Выгрузить некуда — отдаём хотя бы сжатый текст, если он короче. */
    if (compacted.length < source.length) {
      return {
        text: compacted,
        applied: 'compacted',
        before: source.length,
        after: compacted.length,
        spill: null,
        savedChars: source.length - compacted.length,
      };
    }
    return idle;
  }

  const body = compacted.length < source.length * 0.7 ? compacted : source;
  const preview = boundPreview(body, {
    head: settings.headChars,
    tail: settings.tailChars,
    note: `⟮… сокращено ${Math.max(0, body.length - settings.headChars - settings.tailChars)} знаков: текст длиннее, чем стоит держать в подсказке ⟯`,
  });
  const note = savedNote({ before: source.length, after: preview.length, spill });
  const withNote = `${note}\n${preview}`;
  return {
    text: withNote,
    applied: 'preview',
    before: source.length,
    after: withNote.length,
    spill,
    savedChars: source.length - withNote.length,
  };
}

/* ---------------------------- история разговора ---------------------------- */

/** Сколько токенов занимает сообщение — та же оценка, что у агента. */
export function messageCost(message) {
  const content = message?.content;
  const text =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content.map((part) => (typeof part === 'string' ? part : part?.type === 'text' ? part.text : '')).join('\n')
        : '';
  let cost = estimateTokens(text) + 4;
  if (Array.isArray(message?.tool_calls)) {
    for (const call of message.tool_calls) {
      cost += estimateTokens(call?.function?.name || '') + estimateTokens(call?.function?.arguments || '') + 6;
    }
  }
  return cost;
}

export function historyTokens(history) {
  let total = 0;
  for (const message of history || []) total += messageCost(message);
  return total;
}

/**
 * Срезает самые старые сообщения, пока история не влезет в бюджет.
 * Режет по границе «сообщение пользователя», чтобы вызовы инструментов
 * оставались рядом со своими ответами; закреплённое сообщение (задача) и
 * порядок остальных не меняет. Возвращает срезанное.
 */
export function dropHistory(history, { budget, keepRecent = 10, pinned = null, maxRounds = 400 } = {}) {
  const removed = [];
  if (!Array.isArray(history) || !history.length) return removed;
  const pinIndex = pinned ? history.indexOf(pinned) : -1;
  let total = historyTokens(history);
  let guard = 0;
  while (total > budget && history.length > keepRecent && guard < maxRounds) {
    guard++;
    let cut = 1;
    while (cut < history.length && history[cut].role !== 'user') cut++;
    if (cut >= history.length) {
      cut = -1;
      for (let index = 1; index < history.length; index++) {
        const message = history[index];
        if (message.role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length) {
          cut = index;
          break;
        }
      }
      if (cut < 0) break;
    }
    if (pinIndex >= 0) {
      if (cut > pinIndex) cut = pinIndex;
      if (cut <= 0) break;
    }
    if (history.length - cut < keepRecent) break;
    const slice = history.splice(0, cut);
    for (const message of slice) {
      total -= messageCost(message);
      removed.push(message);
    }
  }
  return removed;
}

/** Срезанные сообщения одним текстом — для сводки и для файла. */
export function renderRemoved(removed) {
  return (removed || [])
    .map((message) => {
      const content = message?.content;
      const text =
        typeof content === 'string'
          ? content
          : Array.isArray(content)
            ? content.map((part) => (typeof part === 'string' ? part : part?.type === 'text' ? part.text : '[изображение]')).join('\n')
            : '';
      const calls = Array.isArray(message?.tool_calls) && message.tool_calls.length
        ? ` [вызовы: ${message.tool_calls.map((call) => call?.function?.name).filter(Boolean).join(', ')}]`
        : '';
      return `${message?.role || 'message'}: ${text}${calls}`;
    })
    .join('\n')
    .slice(0, 16000);
}

/**
 * Автосжатие: вместо молчаливой потери старой части разговора она уходит в
 * файл проекта, а в память чата попадает короткая сводка. Если модель
 * недоступна, кладём детерминированную выжимку — контекст не пропадает.
 *
 * @param {object} params
 * @param {{history: Array, memory?: string}} params.chat
 * @param {string} params.workspace
 * @param {number} params.budget бюджет токенов истории
 * @param {number} [params.keepRecent]
 * @param {object} [params.pinned] сообщение текущей задачи
 * @param {(text: string) => Promise<string>} [params.summarize]
 * @param {object} [params.config]
 * @param {object} [params.stats]
 */
export async function compressHistory({
  chat,
  workspace,
  budget,
  keepRecent = 10,
  pinned = null,
  summarize = null,
  memoryChars = 2200,
  config = {},
  stats = null,
}) {
  const settings = resolveTrimConfig(config);
  const removed = dropHistory(chat?.history, { budget, keepRecent, pinned });
  const result = { removed: removed.length, chars: 0, spill: null, summarized: false, fallback: false };
  if (!removed.length) return result;

  const text = renderRemoved(removed);
  result.chars = text.length;
  if (stats) stats.historyDrops += 1;

  const spill = spillText({ workspace, label: 'history', text, config: settings });
  result.spill = spill;

  if (text.length < settings.minHistoryChars) return result;

  let summary = '';
  if (typeof summarize === 'function') {
    try {
      summary = String((await summarize(text)) || '').trim();
    } catch {
      summary = '';
    }
  }

  if (summary) {
    result.summarized = true;
    if (stats) stats.historySummaries += 1;
  } else {
    result.fallback = true;
    if (stats) stats.historyFallbacks += 1;
    const flat = text.replace(/\s+/g, ' ').trim();
    summary = `Ранее в разговоре (сжато): ${flat.slice(0, 900)}${flat.length > 900 ? '…' : ''}`;
  }

  const pointer = spill ? ` Полный текст срезанной части: ${spill}` : '';
  const merged = `${chat.memory ? `${chat.memory}\n` : ''}${summary}${pointer}`;
  const limit = Math.max(400, Number(memoryChars) || 2200);
  chat.memory = merged.length > limit ? `${merged.slice(0, limit - 20)}\n…[сокращено]` : merged;
  return result;
}

/** Счётчики для отчёта и логов: сколько сэкономили и сколько раз выгружали. */
export function createTrimStats() {
  return {
    toolResults: 0,
    compacted: 0,
    previews: 0,
    spills: 0,
    savedChars: 0,
    repeated: 0,
    historyDrops: 0,
    historySummaries: 0,
    historyFallbacks: 0,
  };
}

export function noteTrim(stats, info) {
  if (!stats) return;
  stats.toolResults += 1;
  if (info.applied === 'compacted') stats.compacted += 1;
  if (info.applied === 'preview') stats.previews += 1;
  if (info.spill) stats.spills += 1;
  stats.savedChars += Math.max(0, Number(info.savedChars) || 0);
}

/** Слить счётчики субагента в счётчики основной задачи: расход общий. */
export function mergeTrim(target, source) {
  if (!target || !source) return target;
  for (const key of Object.keys(target)) {
    if (typeof source[key] === 'number') target[key] += source[key];
  }
  return target;
}

/** Человеческая строка для лога: «сжато 48 213 → 5 400 знаков (3 из 12)». */
export function describeTrim(stats) {
  if (!stats || !stats.toolResults) return '';
  const parts = [`сжато ${stats.savedChars} знаков`, `результатов ${stats.toolResults}`];
  if (stats.compacted) parts.push(`сжато без потерь ${stats.compacted}`);
  if (stats.previews) parts.push(`выжимок ${stats.previews}`);
  if (stats.spills) parts.push(`выгружено в .trims ${stats.spills}`);
  if (stats.historyDrops) parts.push(`срезов истории ${stats.historyDrops}`);
  return parts.join(', ');
}
