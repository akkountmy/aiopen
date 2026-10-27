import { CONTEXT, ESCALATION, MODEL, REVIEW, costUsd } from './config.mjs';
import { documentExcerpt, documentKind } from './doccheck.mjs';
import { getDeepSeekKey } from './keys.mjs';
import { chooseProfile } from './model.mjs';
import { createNarrationGate } from './narration.mjs';
import { summaryPrompt, systemPrompt, titlePrompt } from './prompt.mjs';
import { describeReview, reviewAnswer } from './review.mjs';
import { skillsPromptText } from './skills.mjs';
import { continuePrompt, taskSummaryLine, updateTaskState } from './taskstate.mjs';
import { availableToolDefs, TOOL_LABELS, executeTool, toolSummary } from './tools.mjs';
import {
  compressHistory,
  createTrimStats,
  historyTokens,
  mergeTrim,
  noteTrim,
  resolveTrimConfig,
  trimToolResult,
} from './trim.mjs';
import { sha256, sleep } from './util.mjs';

const MAX_IMAGE_PARTS = 6;

/* «Продолжай» после отрезка шагов: большая задача не должна обрываться на
   счётчике и не должна заставлять человека писать «продолжи» руками. */
const CONTINUE_PROMPT =
  'Продолжай выполнение задачи с того места, где остановился. Не переспрашивай и не проси ' +
  'подтверждения — доведи работу до готового результата: файлы созданы и проверены, ответ ' +
  'содержит итог и пути к файлам.';

/* Финальная просьба, если исчерпан технический предел длины задачи. */
const WRAP_UP_PROMPT =
  'Инструменты больше недоступны. Коротко подведи итог: что уже сделано, какие файлы готовы ' +
  'и что в них. Не задавай вопросов и не предлагай продолжить.';

function friendlyError(error) {
  const status = error?.status;
  if (error?.name === 'AbortError') return 'Генерация остановлена.';
  if (status === 401 || status === 403) return 'Нет доступа к сервису. Сообщите администратору.';
  if (status === 429) return 'Слишком много запросов подряд. Подождите пару секунд и повторите.';
  if (status === 402) return 'Закончился баланс сервиса. Сообщите администратору.';
  if (status >= 500) return 'Сервис временно перегружен. Попробуйте ещё раз.';
  const message = String(error?.message || '');
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|network|socket/i.test(message)) {
    return 'Нет связи с сервисом. Проверьте интернет и повторите.';
  }
  return 'Не удалось получить ответ. Попробуйте ещё раз.';
}

export function describeFailure(error) {
  return friendlyError(error);
}

async function requestCompletion(body, { signal, onDelta, onReasoning }) {
  const key = getDeepSeekKey();
  if (!key) {
    const error = new Error('Ключ сервиса не настроен');
    error.status = 401;
    throw error;
  }
  const payload = { ...body, stream: true, stream_options: { include_usage: true } };
  const response = await fetch(`${MODEL.baseURL}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal,
  });

  if (!response.ok) {
    const raw = await response.text().catch(() => '');
    const error = new Error(`upstream ${response.status}: ${raw.slice(0, 400)}`);
    error.status = response.status;
    error.raw = raw;
    throw error;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let reasoning = '';
  const toolCalls = [];
  let usage = null;
  let finishReason = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split('\n\n');
    buffer = chunks.pop() ?? '';
    for (const chunk of chunks) {
      const line = chunk.split('\n').find((l) => l.startsWith('data:'));
      if (!line) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      let json;
      try {
        json = JSON.parse(data);
      } catch {
        continue;
      }
      if (json.usage) usage = json.usage;
      const choice = json.choices?.[0];
      if (!choice) continue;
      if (choice.finish_reason) finishReason = choice.finish_reason;
      const delta = choice.delta || {};
      if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
        reasoning += delta.reasoning_content;
        onReasoning?.(delta.reasoning_content);
      }
      if (typeof delta.content === 'string' && delta.content) {
        text += delta.content;
        onDelta?.(delta.content);
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const part of delta.tool_calls) {
          const index = part.index ?? 0;
          if (!toolCalls[index]) {
            toolCalls[index] = { id: part.id || `call_${index}`, type: 'function', function: { name: '', arguments: '' } };
          }
          if (part.id) toolCalls[index].id = part.id;
          if (part.function?.name) toolCalls[index].function.name += part.function.name;
          if (part.function?.arguments) toolCalls[index].function.arguments += part.function.arguments;
        }
      }
    }
  }

  return { text, reasoning, toolCalls: toolCalls.filter(Boolean), usage, finishReason };
}

/**
 * Запрос к модели с двумя поправками на реальность:
 * — маршрут может не принимать reasoning_effort — повторяем без него;
 * — сильной модели может не быть в доступе — откатываемся на рабочую, чтобы
 *   задача не падала из-за недоступного профиля.
 * Обе поправки безопасны: сервер отвечает ошибкой до начала потока, поэтому
 * повтор не дублирует уже показанный текст.
 */
async function callModel(body, options, { fallbackModel = '' } = {}) {
  let current = { ...body };
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await requestCompletion(current, options);
    } catch (error) {
      const raw = String(error?.raw || '');
      if (current.reasoning_effort && error?.status === 400 && /reasoning_effort|unsupported|unknown/i.test(raw)) {
        const { reasoning_effort, ...rest } = current;
        current = rest;
        continue;
      }
      const modelMissing =
        (error?.status === 400 || error?.status === 404) &&
        fallbackModel &&
        current.model !== fallbackModel &&
        /model|not found|does not exist|invalid|unknown/i.test(raw);
      if (modelMissing) {
        current = { ...current, model: fallbackModel, reasoning_effort: ESCALATION.flashEffort };
        continue;
      }
      throw error;
    }
  }
  throw new Error('Не удалось получить ответ сервиса');
}

/**
 * Короткий запрос без потоковой выдачи: конспект истории, проверка ответа,
 * правка. `onUsage` получает расход, чтобы служебные вызовы попадали в счёт
 * задачи, а не были бесплатными для владельца сервиса.
 */
export async function simpleCompletion(messages, { maxTokens = 500, signal, effort = 'low', onUsage = null, model = '' } = {}) {
  const key = getDeepSeekKey();
  if (!key) return '';
  const call = (withEffort, name) => {
    const body = { model: name || MODEL.name, messages, max_tokens: maxTokens, stream: false };
    if (withEffort) body.reasoning_effort = effort;
    return fetch(`${MODEL.baseURL}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
  };
  /* effort не знает каждая модель: на 400 повторяем тот же запрос без него. */
  const attempt = async (name) => {
    let answer = await call(true, name);
    if (answer.status === 400) answer = await call(false, name);
    return answer;
  };
  let response = await attempt(model);
  /* Модели проверяющего может не быть в доступе: лучше проверить основной,
     чем промолчать. */
  if (!response.ok && model) response = await attempt('');
  if (!response.ok) throw new Error(`simple completion ${response.status}`);
  if (!response.ok) throw new Error(`simple completion ${response.status}`);
  const json = await response.json();
  if (onUsage && json?.usage) {
    onUsage(Number(json.usage.prompt_tokens || 0), Number(json.usage.completion_tokens || 0));
  }
  return String(json?.choices?.[0]?.message?.content || '').trim();
}


/**
 * Выдержки из готовых файлов для проверяющего: имя, тема и первые строки.
 * В харнессе это делает чтение документа обратно (word_read/ppt_read); здесь
 * то же самое без Python. Отсутствующие и нечитаемые файлы пропускаем молча —
 * ревью не должно падать из-за выдержки.
 */
async function buildReviewExcerpts(paths, workspace, { limit = REVIEW.excerptFiles } = {}) {
  const out = [];
  const seen = new Set();
  for (const rel of Array.isArray(paths) ? paths : []) {
    const name = String(rel || '').trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    if (!documentKind(name)) continue;
    try {
      const text = await documentExcerpt(path.join(workspace, name), { chars: REVIEW.excerptChars });
      if (text) out.push({ file: name, text });
    } catch {
      /* нечитаемый файл остаётся без выдержки */
    }
    if (out.length >= limit) break;
  }
  return out;
}

function buildUserContent(text, images) {
  if (!images.length) return text;
  const parts = [{ type: 'text', text }];
  for (const image of images.slice(0, MAX_IMAGE_PARTS)) {
    parts.push({ type: 'image_url', image_url: { url: image } });
  }
  return parts;
}

/**
 * Выполняет один ход агента: стримит ответ и выполняет инструменты.
 *
 * Помимо обычной работы умеет запускать субагентов (spawn_agent): каждый
 * получает изолированную историю, суженный набор инструментов и потолок шагов,
 * а его расход прибавляется к расходу этого хода.
 *
 * @param {object} params
 * @param {string} params.workspace путь рабочей папки проекта
 * @param {{history: Array, memory: string}} params.chat
 * @param {string} params.userText текст пользователя с уже вставленными выдержками из файлов
 * @param {string} params.filesBrief сводка по файлам проекта (что уже лежит в папке и что внутри)
 * @param {string[]} params.images data-url изображений текущего сообщения
 * @param {Function} params.emit события для UI
 * @param {AbortSignal} params.signal
 */
/* Что доступно субагенту: чтение, анализ, веб, расчёты и запись — но только в
   свою папку `.dshow/work/parts/<слаг>/`. Так четыре воркера могут готовить
   четыре части одного отчёта параллельно и не затирать файлы друг друга:
   основная задача потом читает готовые части и сводит их. Скрытая папка не
   засоряет пользователю блок «Файлы проекта». */
const SUBAGENT_TOOLS = [
  'list_files',
  'read_file',
  'read_document',
  'find_in_files',
  'analyze_data',
  'analyze_image',
  'calculate',
  'write_file',
  'append_file',
  'create_word',
  'create_excel',
  'create_pptx',
  'create_pdf',
  'run_js',
  'web_search',
  'fetch_url',
  'fetch_many',
  'crawl',
  'read_page',
  'scrape_page',
  'use_skill',
  'check_document',
];
const SUBAGENT_MAX_DEPTH = 1;
const SUBAGENT_MAX_TASKS = 4;
const SUBAGENT_STEPS = 14;
const SUBAGENT_TASK_CHARS = 4000;

const SUBAGENT_BRIEF =
  'Ты субагент внутри большой задачи. Работай самостоятельно и экономно: ' +
  'проверь факты инструментами, не пересказывай задание, не задавай вопросов. ' +
  'Верни сжатый отчёт: что проверил, что получил (числа с источником), где сомнения. ' +
  'Если для твоей части нужен файл — создай его в своей папке .dshow/work/parts/ и укажи путь в отчёте; ' +
  'файлы вне своей папки писать нельзя, их сведёт основная задача.';

/** Оставляет в списке инструментов только разрешённые имена. */
function filterToolDefs(defs, allowed) {
  if (!Array.isArray(allowed) || !allowed.length) return defs;
  const names = new Set(allowed);
  const filtered = defs.filter((def) => names.has(def.function.name));
  return filtered.length ? filtered : defs;
}

/** Разбирает аргументы spawn_agent: строки или объекты { name, task }. */
function normalizeSubagentTasks(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const tasks = [];
  for (const item of list.slice(0, SUBAGENT_MAX_TASKS)) {
    const task = String(typeof item === 'string' ? item : item?.task || '').trim();
    if (!task) continue;
    const name = String((typeof item === 'object' && item?.name) || `Подзадача ${tasks.length + 1}`).slice(0, 60);
    tasks.push({ name, task: task.slice(0, SUBAGENT_TASK_CHARS) });
  }
  return tasks;
}

/** Короткий слаг для папки воркера: латиница/цифры, остальное — дефис. */
function slugify(text) {
  const map = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya' };
  return String(text || '')
    .toLowerCase()
    .split('')
    .map((char) => (map[char] !== undefined ? map[char] : char))
    .join('')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 28) || 'part';
}

/** Параллельный запуск с ограничением числа одновременных работ. */
async function runLimited(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runners = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

export async function runTurn({
  workspace,
  chat,
  projectName,
  userName,
  userText,
  /* Выжимка прошлых диалогов проекта: новый чат не начинает с чистого листа. */
  projectContext = '',
  filesBrief = '',
  images = [],
  emit,
  signal,
  budget = null,
  /* Постоянная память пользователя: факты уже прочитаны из store вызывающей
     стороной, remember — функция их записи. */
  facts = [],
  remember = null,
  /* Набор инструментов для этого хода: null — все доступные. Субагенты
     получают суженный список, чтобы не писать файлы и не зацикливаться. */
  toolFilter = null,
  /* Глубина вложенности: субагент субагента уже не запускает. */
  depth = 0,
  /* Потолок шагов для вложенной работы (основной ход его не задаёт). */
  maxSteps = null,
  /* Папка, за пределы которой субагенту писать нельзя (у основной задачи пусто). */
  writeRoot = '',
  /* Режимы, выбранные человеком в композере: «Рассуждения» и «Поиск».
     Это не глобальная настройка сервиса, а решение для текущего хода. */
  thinking = false,
  search = false,
}) {
  const usage = { tokensIn: 0, tokensOut: 0 };
  const toolsUsed = [];
  const skillsText = skillsPromptText();
  const trimStats = createTrimStats();
  const trimConfig = resolveTrimConfig(CONTEXT.trim);
  /* Повторы вызовов внутри хода: отпечаток вызова → {шаг, отпечаток ответа}.
     Нужен, чтобы не платить дважды за один и тот же результат. */
  const callIndex = new Map();
  /* Сводка срезанной части разговора: заказываем моделью, но если её нет —
     сработает детерминированная выжимка (это внутри compressHistory). */
  const summarizeGone = (text) =>
    simpleCompletion([{ role: 'user', content: summaryPrompt(text) }], {
      maxTokens: 600,
      signal,
      onUsage: (tokensIn, tokensOut) => {
        usage.tokensIn += tokensIn;
        usage.tokensOut += tokensOut;
      },
    });

  /* Автосжатие в начале хода: если история уже тяжёлая, старые сообщения
     уходят в файл проекта `.trims/…`, а в память чата попадает короткая
     сводка. Контекст не пропадает — он становится короче. */
  if (historyTokens(chat.history) > CONTEXT.historyTokens) {
    try {
      await compressHistory({
        chat,
        workspace,
        budget: CONTEXT.historyTokens,
        keepRecent: CONTEXT.keepRecentMessages,
        memoryChars: CONTEXT.summaryChars,
        summarize: summarizeGone,
        config: trimConfig,
        stats: trimStats,
      });
    } catch {
      if (signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    }
  }

  const turnMessage = { role: 'user', content: buildUserContent(userText, images) };
  chat.history.push(turnMessage);

  const toolDefs = filterToolDefs(await availableToolDefs(), toolFilter);
  /* Класс задачи решает, кто её делает: короткий вопрос — быстро и дёшево,
     аудит/финмодель/ресёрч — сильная модель с максимальным усилием. Профиль
     выбирается один раз на ход и держится до конца: посреди работы модель не
     меняется, иначе теряется нить и удваивается плата за разбор. */
  const route = chooseProfile({
    text: userText,
    filesBrief,
    tools: toolDefs.map((def) => def.function.name),
    images: images.length,
    config: ESCALATION,
    /* «Рассуждения» — явный выбор человека: не полагаемся на эвристику
       сложности и сразу берём сильную модель с максимальным усилием. */
    force: thinking ? 'pro' : null,
  });
  /* Файл чата — единственный канал, переживающий ход: карточку задачи держим
     в нём, чтобы «продолжай» и следующий ход начинались с неё. */
  if (!chat.task) chat.task = updateTaskState(null, { userText });
  /* Задача целиком закрепляется в истории: обрезка контекста её не съедает. */
  const taskMessage = turnMessage;
  const segmentSize = Math.max(1, Number(CONTEXT.maxSteps) || 30);
  const stepCeiling = segmentSize * Math.max(1, Number(CONTEXT.maxSegments) || 1);
  const stepLimit = Number(maxSteps) > 0 ? Math.min(stepCeiling, Number(maxSteps)) : stepCeiling;
  let finalText = '';
  /* Ход рассуждений копится отдельно от ответа: он уходит в интерфейс
     свёрнутым блоком и не подмешивается в markdown. */
  let reasoningText = '';
  let steps = 0;
  let finished = false;

  /* Субагенты: изолированный контекст, суженный набор инструментов, отчёт
     текстом. Расход вложенной работы прибавляется к расходу основной задачи,
     поэтому бюджет и статистика остаются честными. */
  async function spawnSubagents(args) {
    if (depth >= SUBAGENT_MAX_DEPTH) {
      throw new Error('Субагент не может запускать своих субагентов — сделай эту часть сам.');
    }
    const tasks = normalizeSubagentTasks(args?.tasks ?? args);
    if (!tasks.length) throw new Error('Нужен хотя бы один пункт tasks с текстом задачи');
    const allowed =
      Array.isArray(args?.tools) && args.tools.length
        ? SUBAGENT_TOOLS.filter((name) => args.tools.includes(name))
        : SUBAGENT_TOOLS;
    const extra = String(args?.context || '').slice(0, 2000);
    const limit = Math.max(1, Math.min(SUBAGENT_MAX_TASKS, Number(args?.concurrency) || 3));

    return runLimited(tasks, limit, async (task, index) => {
      const nested = { history: [], memory: null };
      /* Своя папка на воркера: части одного отчёта не конфликтуют, а основная
         задача видит, чей файл чей. */
      const folder = `.dshow/work/parts/${String(index + 1).padStart(2, '0')}-${slugify(task.name)}`;
      try {
        const outcome = await runTurn({
          workspace,
          chat: nested,
          projectName,
          userName,
          userText: `${SUBAGENT_BRIEF}\nТвоя рабочая папка: ${folder}/ — только в неё можно писать файлы.${extra ? `\n\nОбщий контекст задачи: ${extra}` : ''}\n\nТвоя часть: ${task.task}`,
          filesBrief,
          images: [],
          emit: () => {},
          signal,
          budget: null,
          facts,
          remember: null,
          toolFilter: allowed,
          writeRoot: folder,
          depth: depth + 1,
          maxSteps: SUBAGENT_STEPS,
        });
        usage.tokensIn += outcome.usage.tokensIn;
        usage.tokensOut += outcome.usage.tokensOut;
        /* Экономия субагента — тоже часть хода: расход считаем общий. */
        mergeTrim(trimStats, outcome.trim);
        const made = outcome.tools.filter((tool) => tool.path && tool.status !== 'error').map((tool) => tool.path);
        const notes = [
          outcome.steps ? `шагов ${outcome.steps}` : '',
          outcome.tools.length ? `инструментов ${outcome.tools.length}` : '',
          made.length ? `файлы: ${made.join(', ')}` : '',
        ].filter(Boolean);
        const tail = notes.length ? `\n\n(${notes.join(', ')})` : '';
        return { name: task.name, text: `${String(outcome.text || '').trim()}${tail}`, error: null, files: made, folder };
      } catch (error) {
        if (error?.name === 'AbortError') throw error;
        return { name: task.name, text: '', error: String(error?.message || error), files: [], folder };
      }
    });
  }

  const toolCtx = { workspace, signal, remember, projectName, userName, facts, depth, spawnAgent: spawnSubagents };

  /* За пять шагов до предела модель получает предупреждение, а человек —
     строку в живом статусе. Раньше предел наступал внезапно: агент упирался в
     него посреди сборки и выдавал обрубок; теперь у него есть шаги, чтобы
     закончить главное и честно назвать незаконченное. */
  const warnAt = Math.max(6, stepLimit - 5);
  let warnedAboutLimit = false;

  while (!finished && steps < stepLimit) {
    steps++;
    if (!warnedAboutLimit && steps >= warnAt) {
      warnedAboutLimit = true;
      const left = Math.max(1, stepLimit - steps + 1);
      chat.history.push({
        role: 'user',
        content: `До предела шагов осталось ${left}. Приоритет: доведи главное до результата, назови готовые файлы и прямо перечисли, что не успел. Не начинай новых крупных разделов.`,
      });
      emit({ type: 'progress', step: steps, limit: stepLimit, note: `осталось ${left} шагов до предела` });
    }
    /* Длинная задача не должна упираться в окно контекста: лишнюю историю
       отрезаем между шагами, а не только в начале хода. Задача закреплена,
       поэтому агент всегда видит, что от него требуется. Сводку заказываем
       раз в три шага: иначе расход на пересказ съел бы всю экономию. */
    if (historyTokens(chat.history) > CONTEXT.historyTokens) {
      try {
        await compressHistory({
          chat,
          workspace,
          budget: CONTEXT.historyTokens,
          keepRecent: CONTEXT.keepRecentMessages,
          pinned: taskMessage,
          memoryChars: CONTEXT.summaryChars,
          summarize: steps % 3 === 0 ? summarizeGone : null,
          config: trimConfig,
          stats: trimStats,
        });
      } catch {
        if (signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      }
    }
    const system = systemPrompt({ projectName, projectContext, memory: chat.memory, userName, question: userText, facts, skillsText, filesBrief, task: chat.task, modes: { thinking, search } });
    const messages = [{ role: 'system', content: system }, ...chat.history];

    /* У каждого шага свой буфер начала реплики — см. src/narration.mjs. */
    const narration = createNarrationGate({ emit: (text) => emit({ type: 'delta', text }) });

    const result = await callModel(
      {
        model: route.model,
        messages,
        tools: toolDefs,
        tool_choice: 'auto',
        max_tokens: CONTEXT.maxOutputTokens,
        reasoning_effort: route.effort,
      },
      {
        signal,
        /* Начало реплики шага держим в буфере: если шаг вызовет инструменты,
           это был ход мысли («I'll start by…»), и в ленту он не пойдёт. */
        onDelta: (text) => narration.push(text),
        onReasoning: (text) => {
          if (thinking) emit({ type: 'reasoning', text });
        },
      },
      { fallbackModel: ESCALATION.flashModel },
    );

    if (thinking && result.reasoning) reasoningText = (reasoningText + result.reasoning).slice(-24000);

    /* Проверяем, был ли шаг ответом; при вызове инструментов реплика шага
       выбрасывается целиком — ни в поток, ни в итоговый текст ответа. */
    const stepAnswer = narration.finish(result.toolCalls.length > 0);

    if (result.usage) {
      usage.tokensIn += result.usage.prompt_tokens || 0;
      usage.tokensOut += result.usage.completion_tokens || 0;
    }

    finalText += stepAnswer;

    /* Стоимость именно этой задачи превысила порог: останавливаемся, чтобы не
       жечь деньги пользователя. Накопленный расход проекта здесь не участвует —
       иначе сотня мелких задач упиралась бы в лимит. */
    if (budget && Number(budget.limitUsd) > 0) {
      const spentUsd = costUsd(usage.tokensIn, usage.tokensOut);
      if (spentUsd >= Number(budget.limitUsd)) {
        const budgetHit = {
          spentUsd: Math.round(spentUsd * 100) / 100,
          limitUsd: Math.round(Number(budget.limitUsd) * 100) / 100,
        };
        emit({ type: 'budget', ...budgetHit });
        return { text: finalText, usage, tools: toolsUsed, steps, memory: chat.memory, budgetHit, trim: trimStats, route, reasoning: reasoningText };
      }
    }

    if (!result.toolCalls.length) {
      chat.history.push({ role: 'assistant', content: result.text || '' });
      finished = true;
      break;
    }

    const assistantMessage = {
      role: 'assistant',
      content: result.text || null,
      tool_calls: result.toolCalls.map((call) => ({
        id: call.id,
        type: 'function',
        function: { name: call.function.name, arguments: call.function.arguments || '{}' },
      })),
    };
    chat.history.push(assistantMessage);

    for (const call of assistantMessage.tool_calls) {
      let args = {};
      let brokenArguments = false;
      try {
        args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
      } catch {
        args = {};
        brokenArguments = true;
      }
      const label = TOOL_LABELS[call.function.name] || call.function.name;
      const summary = toolSummary(call.function.name, args);
      const toolId = call.id || `${Date.now()}`;
      emit({ type: 'tool', id: toolId, name: call.function.name, label, summary, status: 'run' });
      const started = Date.now();
      let content = '';
      let status = 'ok';
      /* Что инструмент реально создал: путь нужен и карточке задачи, и
         проверяющему, который сверяет обещанные файлы с готовыми. */
      let toolPath = '';
      if (brokenArguments) {
        status = 'error';
        content =
          'Ошибка инструмента: аргументы вызова пришли обрезанными (слишком длинный ответ). ' +
          'Не повторяй тот же вызов целиком: для большого файла сначала write_file с первой частью (4–8 КБ), ' +
          'затем append_file с остальными частями.';
        emit({
          type: 'tool',
          id: toolId,
          name: call.function.name,
          label,
          summary,
          status: 'error',
          detail: 'аргументы обрезаны',
          ms: 0,
        });
        console.warn(`[tool] ${call.function.name}: аргументы обрезаны`);
      } else {
        try {
          const executed = await executeTool(call.function.name, args, toolCtx);
          /* Обрезка результата (аналог dsh-trim): малый ответ — как есть,
             крупный детерминированно сжимается, а не влезающий в подсказку
             уходит в файл проекта с выжимкой и ссылкой на полный текст. */
          const trimmed = trimToolResult({
            name: call.function.name,
            text: String(executed.text ?? ''),
            workspace,
            pressure: historyTokens(chat.history),
            config: trimConfig,
          });
          content = trimmed.text;
          if (trimmed.applied !== 'none') noteTrim(trimStats, trimmed);

          /* Тот же вызов с теми же аргументами даёт тот же ответ: второй раз
             платить за него токенами незачем — говорим об этом прямо. */
          const fingerprint = `${call.function.name}:${call.function.arguments || '{}'}`;
          const seen = callIndex.get(fingerprint);
          const digest = sha256(content);
          if (seen && seen.digest === digest) {
            content = `[Тот же вызов уже был на шаге ${seen.step}, результат не изменился. Не повторяй его — используй то, что уже получил.]`;
            trimStats.repeated += 1;
          } else {
            callIndex.set(fingerprint, { step: steps, digest });
          }
          if (trimmed.spill) {
            console.log(`[trim] ${call.function.name}: ${trimmed.before} → ${trimmed.after} знаков, полный текст ${trimmed.spill}`);
          }

          const pathDetail = executed.meta?.path ? String(executed.meta.path) : '';
          toolPath = pathDetail;
          /* Короткая приписка инструмента («проверяю страницу в живом браузере:
             снимков 3»): её показывает живой статус ответа, чтобы человек видел,
             чем именно проверяли и не подменили ли браузер разбором по коду. */
          const noteDetail = executed.meta?.note ? String(executed.meta.note) : '';
          const trimDetail =
            trimmed.applied === 'none'
              ? ''
              : trimmed.spill
                ? `сжато ${trimmed.before} → ${trimmed.after}, полный текст ${trimmed.spill}`
                : `сжато ${trimmed.before} → ${trimmed.after}`;
          emit({
            type: 'tool',
            id: toolId,
            name: call.function.name,
            label,
            summary,
            status: 'ok',
            detail: [pathDetail, trimDetail].filter(Boolean).join(' · '),
            ...(noteDetail ? { note: noteDetail } : {}),
            ms: Date.now() - started,
          });
        } catch (error) {
          status = 'error';
          content = `Ошибка инструмента: ${error.message}`;
          console.warn(`[tool] ${call.function.name}: ${error.message}`);
          emit({
            type: 'tool',
            id: toolId,
            name: call.function.name,
            label,
            summary,
            status: 'error',
            detail: String(error.message || '').slice(0, 160),
            ms: Date.now() - started,
          });
        }
      }
      toolsUsed.push({ id: toolId, name: call.function.name, label, summary, status, ...(toolPath ? { path: toolPath } : {}) });
      chat.history.push({
        role: 'tool',
        tool_call_id: call.id,
        content: content || 'Готово.',
      });
      if (signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    }
    if (signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    /* Отрезок шагов закончился, а работа ещё идёт: человека не спрашиваем —
       агент получает «продолжай» и ведёт задачу дальше сам. Вместо голого
       «продолжай» прикладываем карточку задачи: что уже готово и что осталось.
       Иначе через десяток отрезков модель начинает работу заново. */
    if (steps % segmentSize === 0 && steps < stepLimit) {
      chat.task = updateTaskState(chat.task, {
        userText,
        tools: toolsUsed,
        steps,
        segments: Math.floor(steps / segmentSize),
      });
      chat.history.push({ role: 'user', content: continuePrompt(chat.task, CONTINUE_PROMPT) });
      emit({ type: 'progress', step: steps, limit: stepLimit });
    }
  }

  /* Предел исчерпан — в жизни это почти всегда зацикливание, а не настоящая
     работа. Не заставляем человека писать «продолжи»: просим короткий итог
     без инструментов, приложив карточку задачи — что успели и что осталось. */
  if (!finished) {
    chat.task = updateTaskState(chat.task, { userText, tools: toolsUsed, steps });
    try {
      const system = systemPrompt({ projectName, projectContext, memory: chat.memory, userName, question: userText, facts, skillsText, filesBrief, task: chat.task, modes: { thinking, search } });
      /* Карточка задачи в финальном сообщении помогает итогу быть по делу:
         модель называет готовые файлы, а не пересказывает процесс. */
      const card = taskSummaryLine(chat.task);
      const result = await callModel(
        {
          model: route.model,
          messages: [
            { role: 'system', content: system },
            ...chat.history,
            { role: 'user', content: card ? `${WRAP_UP_PROMPT}\n\n${card}` : WRAP_UP_PROMPT },
          ],
          max_tokens: CONTEXT.maxOutputTokens,
          reasoning_effort: route.effort,
        },
        {
          signal,
          onDelta: (text) => emit({ type: 'delta', text }),
          onReasoning: (text) => {
            if (thinking) emit({ type: 'reasoning', text });
          },
        },
        { fallbackModel: ESCALATION.flashModel },
      );
      if (result.usage) {
        usage.tokensIn += result.usage.prompt_tokens || 0;
        usage.tokensOut += result.usage.completion_tokens || 0;
      }
      if (thinking && result.reasoning) reasoningText = (reasoningText + result.reasoning).slice(-24000);
      finalText += result.text || '';
      chat.history.push({ role: 'assistant', content: result.text || '' });
      finished = true;
    } catch {
      /* итог не получился — остаётся всё, что уже сказано в ленте */
    }
  }

  /* Карточка задачи закрывает ход: она же станет началом следующего. */
  chat.task = updateTaskState(chat.task, { userText, tools: toolsUsed, steps });

  /* Финальный ревью-пасс: сверяем ответ с тем, что вернули инструменты.
     Дорогой вызов делаем только для содержательных ответов с инструментами;
     при находках — одна правка, при сбое — исходный текст. Проверяющий
     получает выдержки готовых файлов и, если настроено, другую модель: одна
     и та же модель повторяет свои слепые зоны. */
  let review = null;
  if (finalText && REVIEW.enabled) {
    try {
      const createdFiles = toolsUsed.map((tool) => tool.path).filter(Boolean);
      const excerpts = await buildReviewExcerpts(createdFiles, workspace);
      const result = await reviewAnswer({
        userQuestion: userText,
        answer: finalText,
        history: chat.history,
        createdFiles,
        excerpts,
        routeModel: route.model,
        tools: toolsUsed,
        task: chat.task,
        depth,
        complete: (messages, options = {}) =>
          simpleCompletion(messages, {
            signal,
            maxTokens: options.maxTokens || 900,
            effort: options.effort || 'high',
            model: options.model || '',
            onUsage: (tokensIn, tokensOut) => {
              usage.tokensIn += tokensIn;
              usage.tokensOut += tokensOut;
            },
          }),
      });
      review = result.report;
      if (result.text && result.text !== finalText) {
        /* Правка должна попасть и в историю, и в ответ пользователю: иначе
           следующий ход будет опираться на непроверенный текст. */
        finalText = result.text;
        const last = chat.history[chat.history.length - 1];
        if (last?.role === 'assistant') last.content = finalText;
      }
    } catch {
      review = null;
    }
  }

  return { text: finalText, usage, tools: toolsUsed, steps, memory: chat.memory, trim: trimStats, route, review, reasoning: reasoningText };
}

/* Название диалога не должно зависеть от модели: если её ответ пустой,
   запоздал или не разобрался, диалог всё равно получает рабочее имя по
   первой реплике. Это запасной путь, а не замена названию от модели. */
const TITLE_LEAD = /^(привет|здравствуй(?:те)?|добрый (?:день|вечер)|доброе утро|хай|ку|приветствую)(?![а-яёa-z])[\s!,.-]*/i;
const TITLE_VERB = /^(сделай(?:те)?|сделать|собери(?:те)?|собрать|подготовь(?:те)?|подготовить|составь(?:те)?|составить|напиши(?:те)?|написать|создай(?:те)?|создать|проверь(?:те)?|проверить|покажи(?:те)?|показать|расскажи(?:те)?|рассказать|помоги(?:те)?|помочь|нужно|надо|необходимо)(?![а-яёa-z])[\s,:—–-]*/i;
const TITLE_STOP = /^(чтобы|что|как|почему|зачем|когда|где|кто|ли|можно|не|в|во|на|по|для|с|со|у|о|об|это|мне|нам|пожалуйста)(?![а-яёa-z])/i;
const TITLE_PLEASE = /^(пожалуйста|плиз)(?![а-яёa-z])[\s,]+/i;
const TITLE_GENERIC = /^(новый диалог|диалог|беседа|чат|без названия|название|тема|заголовок)$/i;

/** Короткое название из текста: первая мысль без приветствия и «сделай». */
export function titleFromText(value) {
  const original = String(value || '').replace(/\s+/g, ' ').trim();
  if (!original) return '';
  let text = original.replace(TITLE_LEAD, '').replace(TITLE_PLEASE, '').trim();
  if (!text) text = original;
  /* «Собери отчёт» → «Отчёт», но «Проверь, чтобы…» оставляем: иначе от
     названия останется одно «чтобы». */
  for (let step = 0; step < 2; step += 1) {
    text = text.replace(TITLE_PLEASE, '').trim();
    const match = text.match(TITLE_VERB);
    if (!match) break;
    const rest = text.slice(match[0].length).replace(TITLE_PLEASE, '').trim();
    if (!rest || TITLE_STOP.test(rest)) break;
    text = rest;
  }
  text = text.split(/(?<=[.!?])\s+|\n+/)[0] || text;
  text = text.replace(/\.(pdf|docx?|xlsx?|pptx?|csv|txt|md|png|jpe?g|webp|zip)$/i, '');
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length > 8) text = words.slice(0, 8).join(' ');
  if (text.length > 80) {
    const cut = text.slice(0, 80).lastIndexOf(' ');
    text = cut > 24 ? text.slice(0, cut) : text.slice(0, 80);
  }
  text = text.replace(/[\s,;:—–-]+$/, '').replace(/[.!?]+$/, '').trim();
  if (!text) return '';
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Ответ модели приводим к одному названию: без «Название:», кавычек и точки. */
export function normalizeTitle(value) {
  const lines = String(value || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  let text = lines[0] || '';
  /* Модель иногда пишет «Вот название:» отдельной строкой, а само название —
     следующей. Пустую пометку за название не принимаем. */
  const first = text.replace(/^[#*\-\s]+/, '');
  if (
    lines[1] &&
    /^(?:.*[.!?]\s*)?(?:вот\s+)?(?:название|тема|заголовок)\s*[*]*\s*[:\-—][*]*\s*$/i.test(first)
  ) {
    text = lines[1];
  }
  text = text.replace(/^[#*\-\s]+/, '');
  const labelled = text.match(/(?:название|тема|заголовок)\s*[*]*\s*[:\-—][*]*\s*(.+)$/i);
  if (labelled) text = labelled[1];
  text = text
    .replace(/^(название|тема|заголовок)\s*[*]*\s*[:\-—][*]*\s*/i, '')
    .replace(/\s+/g, ' ')
    .replace(/[.;:,!?]+$/, '')
    .trim()
    .replace(/^["'«»„“”`*]+|["'«»„“”`*]+$/g, '')
    .trim();
  if (text.length > 80) {
    const cut = text.slice(0, 80).lastIndexOf(' ');
    text = (cut > 24 ? text.slice(0, cut) : text.slice(0, 80)).trim();
  }
  text = text.replace(/[.;:,!?]+$/, '').trim();
  return TITLE_GENERIC.test(text) ? '' : text;
}

/**
 * Название диалога по первой реплике. Пустая строка — сигнал «взять запасное
 * имя»: сервис не должен оставлять диалог безымянным из-за сбоя модели.
 */
export async function generateTitle(text, { signal, files = [] } = {}) {
  const clean = String(text || '').trim();
  if (!clean) return '';
  try {
    const raw = await simpleCompletion(
      [{ role: 'user', content: titlePrompt(clean, files) }],
      { maxTokens: 400, signal, effort: 'low' },
    );
    return normalizeTitle(raw);
  } catch {
    return '';
  }
}

export async function waitMs(ms) {
  await sleep(ms);
}

