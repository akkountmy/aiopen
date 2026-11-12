import fs from 'node:fs';
import path from 'node:path';
import { CAPACITY, CONTEXT, ESCALATION, MODEL, REVIEW, SPLIT, costUsd } from './config.mjs';
import { buildArtifacts, describeDesign, designView, specFromText, writeSpec } from './design.mjs';
import { documentExcerpt, documentKind } from './doccheck.mjs';
import { normalizeHistory, repairHistoryInPlace } from './history.mjs';
import { getDeepSeekKey } from './keys.mjs';
import { chooseProfile, chooseStepRoute, describeStepRoute, isMechanicalTool } from './model.mjs';
import { createNarrationGate } from './narration.mjs';
import { createReasoningGate, looksRussian } from './reasoning.mjs';
import { summaryPrompt, systemPrompt, titlePrompt } from './prompt.mjs';
import { describeReview, needsReview, reviewAnswer } from './review.mjs';
import { skillsPromptText } from './skills.mjs';
import { continuePrompt, taskSummaryLine, updateTaskState } from './taskstate.mjs';
import { applyReference, availableToolDefs, TOOL_LABELS, executeTool, listTree, toolSummary } from './tools.mjs';
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

/* Задача про интерьер/планировку и про чертёж одновременно: «нарисуй план
   квартиры», «сделай дизайн студии», «3D интерьера». Оба признака обязательны —
   иначе под правило попадал бы «дизайн сайта» или «3D-принтер». */
const INTERIOR_ASK =
  /(квартир|студи|интерьер|комнат[аыуе]|спальн|гостин|кухн|санузел|прихож|дом[аеу]?\b|планировк|расстановк[\p{L}]*\s*мебел|мебел[\p{L}]*\s*(план|расстанов|схем|раскладк))/iu;
const DRAWING_ASK =
  /(дизайн|чертёж|чертеж|план|схем|аксонометр|развёртк|развертк|визуализац|3d|3-д|трёхмерн|объёмн)/iu;
/* Внешний вид сайта, приложения или логотипа — это не проект помещения: там
   работают другие инструменты, и досборка чертежей была бы ошибкой. */
const NOT_INTERIOR =
  /(лендинг|сайт|интерфейс|логотип|айдентик|брендинг|баннер|презентац|приложени|верстк|страниц|промпт|раскладк[\p{L}]*\s*клави)/iu;
/* Ответ, который объявляет работу законченной, но ничего не называет. */
const EMPTY_DONE = /^(всё\s+)?(готово|сделано|выполнено|задача\s+выполнена)[.!\s]*$/iu;
const CLAIMS_DONE = /(готов|сделал|собрал|выполнил|подготовил|закончил)/iu;

const DRAWING_REPAIR_PROMPT =
  'Результата нет: в проекте ни одного листа, а ответ это не назвал. «Готово.» без файлов — брак.\n' +
  'Сделай чертёж инструментом, а не текстом:\n' +
  '1) use_skill {id:"interior-drawings"} — прочитай формат спека;\n' +
  '2) build_design с аргументом design: комнаты полигонами в мм, стены, проёмы, мебель, светильники, высоты.\n' +
  'Сервис сам соберёт design/plan.svg, design/floor.svg, design/ceiling.svg, design/axo.svg и design/3d.html — ' +
  'они появятся в панели «Дизайн-проект» проекта.\n' +
  'Если для спека не хватает размеров — возьми разумные, назови принятые допущения в ответе и всё равно собери листы.';

/* Досборку уже просили, а листов так и нет. Второе «Готово.» человек читать не
   должен: вместо него — честная причина и что делать дальше. */
const MISSING_FILES_ANSWER =
  'Не смог собрать чертежи: модель дважды ответила текстом и ни разу не вызвала сборку проекта, ' +
  'поэтому папка «Дизайн-проект» пустая. Повторите задачу — при повторе сборка запускается заново. ' +
  'Если файлы снова не появятся, это сбой модели, а не вашей задачи: напишите в «Поддержку».';

/* Модель остановилась на плане или обещании. Один адресный шаг дешевле, чем
   человек, который ждёт у пустой папки и потом пишет «продолжи». */
const DELIVERABLE_REPAIR_PROMPT =
  'Ты остановился до результата: в ответе обещано продолжение или запрошен файл, но работа не доведена. ' +
  'Не повторяй план и не пиши «сейчас сделаю». Продолжай выполнение прямо сейчас: ' +
  'создай запрошенный файл профильным инструментом (create_word, create_excel, create_pptx, create_pdf, ' +
  'narrate_document, write_file), проверь, что он существует, и только потом отвечай итогом. ' +
  'Если файл не нужен, а нужен текст — выдай весь результат здесь, а не обещание. ' +
  'В конце назови точные имена готовых файлов.';

const MISSING_DELIVERABLE_NOTE =
  'Работа не доведена до готового результата: файл не создан или ответ оборван. ' +
  'Нажмите «Продолжить» — я подхвачу задачу с этого места и не буду начинать заново.';

/**
 * Собрать дизайн-проект без модели, когда она дважды ответила текстом.
 * Спек строится из самой просьбы, листы — тем же генератором, что и у
 * инструмента сборки. Возвращает текст ответа или null, если не вышло:
 * тогда человек увидит честную причину, а не пустую папку.
 */
export async function rescueDesign({ workspace, userText, attachments = [] } = {}) {
  if (!workspace) return null;
  const text = String(userText || '');
  if (!text || NOT_INTERIOR.test(text)) return null;
  if (!INTERIOR_ASK.test(text) || !DRAWING_ASK.test(text)) return null;
  try {
    const { raw, assumptions } = specFromText(text);
    /* Запасной путь обязан учитывать приложенный референс: иначе он собирает
       проект по тексту и человек видит «палитру из брифа» вместо своего фото.
       applyReference — тот же разбор vision, что и в build_design. */
    if (Array.isArray(attachments) && attachments.some((att) => att?.kind === 'image')) {
      await applyReference(workspace, raw, {}, { workspace, attachments });
    }
    writeSpec(workspace, raw);
    const results = await buildArtifacts(workspace);
    const ok = (key) => results.some((item) => item.key === key && item.ok && item.bytes > 0);
    /* Удачей считаем только план и 3D-сцену: без них это не дизайн-проект. */
    if (!ok('plan') || !ok('scene')) return null;
    const view = designView(workspace);
    return [
      describeDesign(view, results),
      `Допущения, принятые за вас: ${assumptions.join('; ')}.`,
      'Скажите, что поменять — размеры, состав мебели, гамму — и проект пересоберётся.',
    ].join('\n\n');
  } catch {
    return null;
  }
}

/* Инструменты, которые действительно создают файл проекта. `path` в meta есть и
   у чтения/распознавания (analyze_image возвращает путь к исходнику), поэтому
   проверять только наличие path нельзя: после разбора фото задача считалась
   «сделано» и оставалась с пустой папкой. */
const FILE_WRITING_TOOLS = new Set([
  'write_file', 'append_file', 'edit_file', 'create_excel', 'create_word',
  'create_pptx', 'create_deck', 'create_pdf', 'create_drawing', 'build_design', 'extract_archive',
  'narrate_document',
]);

/* Что человек просил сделать файлом. Проверяем не «был ли хоть один файл», а
   именно запрошенный формат: текст в чате не заменяет Word, а .txt — PDF. */
const FORMAT_RULES = [
  { id: 'word', format: /\b(?:word|docx?)\b|ворд/iu, tools: ['create_word'], ext: /\.docx?$/i },
  { id: 'excel', format: /\b(?:excel|xlsx?)\b|эксель/iu, tools: ['create_excel'], ext: /\.xlsx?$/i },
  /* Презентация бывает двух пород: редактируемый .pptx и дизайнерская дека в PDF —\n     поэтому слайд-дека тоже закрывает просьбу «сделай презентацию». */
  { id: 'pptx', format: /\b(?:pptx?|powerpoint)\b|презентац|слайд/iu, tools: ['create_pptx', 'create_deck'], ext: /\.(?:pptx?|pdf)$/i },
  { id: 'pdf', format: /\bpdf\b|пдф/iu, tools: ['create_pdf', 'create_deck'], ext: /\.(?:pdf)$/i },
  { id: 'audio', format: /\bmp3\b|аудио|аудиокниг|озвуч|начита/iu, tools: ['narrate_document'], ext: /\.(?:mp3|wav|m4a|ogg)$/i },
];
const ACTION_VERB_SRC =
  'создай|создать|создайте|сделай|сделать|сделайте|собери|собрать|соберите|подготовь|подготовить|подготовьте|оформи|оформить|оформите|сохрани|сохранить|сохраните|выгрузи|выгрузить|выгрузите|сформируй|сформировать|сформируйте|запиши|записать|запишите|пришли|прислать|пришлите|отправь|отправить|отправьте|сгенерируй|сгенерировать|сгенерируйте|составь|составить|составьте|напиши|написать|напишите';
const MAKE_VERB = new RegExp(`(?:${ACTION_VERB_SRC})`, 'iu');
/* «Книга на 60–65 минут» — это не только текст: в этом продукте книги слушают.
   Раньше такой запрос не называл ни Word, ни MP3, поэтому агент заканчивал
   docx-ом и молчал про озвучку. Теперь книга с хронометражем требует оба файла. */
const BOOK_MINUTES =
  /(?:книг|аудиокниг)[^.!?\n]{0,100}\d{1,3}\s*(?:[-–—]\s*\d{1,3})?\s*мин/iu;
/* Markdown — служебный черновик, а не результат. Удаляем только парный .md,
   рядом с которым уже есть docx/pdf/mp3, и только если его не просили явно. */
const MARKDOWN_ASK = /(?:\bmd\b|markdown|маркдаун|\.md\b)/iu;
const SUMMARY_INTENT = new RegExp(
  `(?:${ACTION_VERB_SRC}|нужен|нужна|нужно|хочу|хотел|требуется)[^.!?\\n]{0,100}(?:выжимк|конспект|отчёт|отчет|смет|таблиц|резюме)`,
  'iu',
);
const FILE_ACTION_ASK =
  /(?:создай|сделай|собери|подготовь|сохрани|выгрузи|оформи|сформируй|запиши|пришли)[^.!?\n]{0,120}(?:файл|файлом)|(?:в\s+файл|файлом|дай\s+скачать|можно\s+скачать)/iu;
const SUMMARY_ASK = SUMMARY_INTENT;
/* Обещание продолжения в конце ответа — самый частый вид «зависания»:
   модель рассказала план и остановилась, а работа осталась в папке. */
const PROMISE =
  /(?:сейчас|сразу|далее|затем|теперь|дальше)\s+(?:же\s+)?(?:соберу|сделаю|подготовлю|создам|сформирую|сгенерирую|озвучу|проверю|приступлю|перейду|начну|запущу|доделаю|завершу|оформлю|напишу|посчитаю|изучу|разберу)|(?:приступаю|приступаем|начинаю|продолжаю)\s+(?:к|с|работ|сборк|подготовк|озвучк)/iu;
const HONEST_REFUSAL = /(?:не могу|не получится|не удалось|нет возможности|не поддержива|не смог)/iu;
const OUTPUT_FILE = /\.(?:docx?|xlsx?|pptx?|pdf|mp3|wav|m4a|ogg|zip|txt|md|html|csv|json|svg|png|jpe?g)$/i;

/** Нужен ли один корректирующий шаг: просили чертёж, а результата нет. */
export function needsDrawingRepair({ userText = '', workspace = '', toolsUsed = [], answer = '', tried = false } = {}) {
  if (tried) return false;
  const text = String(userText || '');
  if (!text || NOT_INTERIOR.test(text)) return false;
  if (!INTERIOR_ASK.test(text) || !DRAWING_ASK.test(text)) return false;
  /* Любой созданный файл — уже результат: домысливать за агентом не нужно. */
  if (toolsUsed.some((tool) => FILE_WRITING_TOOLS.has(tool.name) && tool.status !== 'error')) return false;
  /* Пустой ответ, короткая отписка и прямое «я всё сделал» — те три вида
     ответа, за которыми пустая папка. Содержательный ответ, где человеку
     объясняют, чего не хватает, досборкой не считается. */
  const said = String(answer || '').trim();
  if (said.length > 120 && !EMPTY_DONE.test(said) && !CLAIMS_DONE.test(said)) return false;
  try {
    const view = designView(workspace);
    if (view.hasSpec || view.artifacts.some((item) => item.exists)) return false;
  } catch {
    return false;
  }
  return true;
}

/** Формат упомянут как задача, а не как «прочитай готовый Word». */
function formatRequested(value, rule) {
  const match = rule.format.exec(value);
  if (!match) return false;
  /* «Озвучь…» — уже глагол создания, отдельный формат можно не называть. */
  if (rule.id === 'audio' && /(?:озвуч|начита)/iu.test(value)) return true;
  const boundary = Math.max(
    value.lastIndexOf('!', match.index - 1),
    value.lastIndexOf('?', match.index - 1),
    value.lastIndexOf('\n', match.index - 1),
  );
  const before = value.slice(boundary + 1, match.index);
  return MAKE_VERB.test(before);
}

/** Какие форматы человек назвал явно. Пустой список — формат не задан. */
export function requestedFormats(text) {
  const value = String(text || '');
  const rules = FORMAT_RULES.filter((rule) => formatRequested(value, rule));
  if (!rules.length && BOOK_MINUTES.test(value)) {
    /* Формат не назван, но есть книга и хронометраж: в этом продукте такую
       книгу и слушают, поэтому нужны оба файла. Явно названный Word/PDF
       сильнее: «книга в Word на 40 минут» — это только документ. */
    for (const id of ['word', 'audio']) rules.push(FORMAT_RULES.find((rule) => rule.id === id));
  }
  if (rules.length) return rules;
  return FILE_ACTION_ASK.test(value)
    ? [{ id: 'file', tools: [...FILE_WRITING_TOOLS], ext: OUTPUT_FILE }]
    : [];
}

/**
 * Убирает markdown-черновики, которые агент оставил рядом с готовым файлом.
 * Человеку нужен docx/pdf/mp3, а не два одинаковых по смыслу файла. Чужой
 * markdown не трогаем: только созданный в этом ходе и только парный к
 * docx/pdf/mp3. Явную просьбу «сделай .md» уважаем.
 */
export function cleanupUnrequestedMarkdown({ workspace = '', userText = '', startedMs = 0 } = {}) {
  if (!workspace || !startedMs || MARKDOWN_ASK.test(String(userText || ''))) return [];
  const removed = [];
  let files = [];
  try {
    files = listTree(workspace, '.', { depth: 3, maxEntries: 600 }).filter(
      (item) => !item.dir && /\.md$/i.test(item.path),
    );
  } catch {
    return removed;
  }
  for (const item of files) {
    const modified = Date.parse(item.modified || '');
    if (!Number.isFinite(modified) || modified < startedMs - 2000) continue;
    const full = path.join(workspace, item.path);
    const base = full.replace(/\.md$/i, '');
    if (!['.docx', '.pdf', '.mp3', '.m4a', '.wav'].some((ext) => fs.existsSync(base + ext))) continue;
    try {
      fs.rmSync(full);
      removed.push(item.path);
    } catch {
      /* файл уже удалён или занят — результат важнее уборки */
    }
  }
  return removed;
}

/** Файлы, появившиеся в проекте за текущий ход: страховка, если инструмент
 *  писал через run_js и не вернул path. */
function recentOutputs(workspace, startedMs = 0) {
  if (!workspace) return [];
  const since = Number(startedMs) || 0;
  try {
    return listTree(workspace, '.', { depth: 3, maxEntries: 600 })
      .filter((item) => !item.dir && OUTPUT_FILE.test(item.path))
      .filter((item) => {
        if (!since) return true;
        const modified = Date.parse(item.modified || '');
        return Number.isFinite(modified) && modified >= since - 2000;
      })
      .map((item) => item.path);
  } catch {
    return [];
  }
}

function toolSucceeded(toolsUsed, names) {
  return (Array.isArray(toolsUsed) ? toolsUsed : []).some(
    (tool) => tool?.status !== 'error' && names.includes(String(tool.name || '')),
  );
}

function formatSatisfied(rule, toolsUsed, workspace, startedMs) {
  if (toolSucceeded(toolsUsed, rule.tools)) return true;
  const outputs = recentOutputs(workspace, startedMs);
  if (rule.id === 'file') return outputs.length > 0;
  return outputs.some((file) => rule.ext.test(file));
}

/**
 * Работа закончилась текстом, хотя человек ждал файл или модель сама
 * пообещала продолжить. Возвращаем true — сервис даёт ещё один шаг с явным
 * заданием, вместо того чтобы показывать «готово» и ждать «продолжи».
 */
export function needsDeliverableRepair({
  userText = '',
  workspace = '',
  toolsUsed = [],
  answer = '',
  startedMs = 0,
  tried = false,
} = {}) {
  if (tried) return false;
  const text = String(userText || '');
  const said = String(answer || '').trim();
  if (!text) return false;
  const formats = requestedFormats(text);
  const summaryAsked = SUMMARY_ASK.test(text);
  const promised = PROMISE.test(said);
  if (!formats.length && !summaryAsked && !promised) return false;
  /* Честное «не могу» — не зависание, а результат: досборка его не исправит. */
  if (HONEST_REFUSAL.test(said) && said.length < 1500) return false;

  const outputs = recentOutputs(workspace, startedMs);
  if (formats.length) {
    return formats.some((rule) => !formatSatisfied(rule, toolsUsed, workspace, startedMs));
  }
  if (promised) {
    /* Файл уже есть — «теперь можно озвучить» это не обрыв, а следующий
       необязательный шаг. Досборку включаем только при пустом результате. */
    if (outputs.length || toolSucceeded(toolsUsed, [...FILE_WRITING_TOOLS])) return false;
    return said.length < 1600;
  }
  if (summaryAsked) {
    /* Короткая отписка вместо выжимки/отчёта — тоже обрыв. Содержательный
       текстовый ответ принимаем: не каждая выжимка обязана быть файлом. */
    return !outputs.length && said.length < 700;
  }
  return false;
}

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
  /* Запрос отвергнут по формату. Самая частая причина — разметка вызовов
     инструментов в истории; её уже починили перед сохранением, поэтому
     повтор сообщения проходит. Молчать об этом нельзя: раньше человек видел
     «не удалось получить ответ» и не понимал, что делать. */
  if (status === 400) {
    if (/role 'tool'|tool_calls|tool_call_id/i.test(message)) {
      return 'Запрос к модели отклонён: в истории диалога сбилась разметка вызовов инструментов. Разметку уже исправил — отправьте сообщение ещё раз, ответ придёт.';
    }
    return 'Запрос к модели отклонён. Если это повторяется, покажите администратору строку [agent] из журнала службы — там точная причина.';
  }
  return 'Не удалось получить ответ. Попробуйте ещё раз.';
}

export function describeFailure(error) {
  return friendlyError(error);
}

/* Сон, который просыпается от «Стоп»: пауза перед повтором не должна делать
   задачу неотменяемой. */
function sleepAbortable(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(Object.assign(new Error('Остановлено'), { name: 'AbortError' }));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(Object.assign(new Error('Остановлено'), { name: 'AbortError' }));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, Math.max(0, ms));
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/* Один запрос к модели. Сигнал человека складываем с потолком времени на шаг:
   без второго зависшее соединение держало бы место до утра, а без первого
   «Стоп» перестал бы работать. */
async function requestCompletion(body, { signal, onDelta, onReasoning }) {
  const key = getDeepSeekKey();
  if (!key) {
    const error = new Error('Ключ сервиса не настроен');
    error.status = 401;
    throw error;
  }
  const deadline = CAPACITY.modelTimeoutMs > 0 ? AbortSignal.timeout(CAPACITY.modelTimeoutMs) : null;
  const combined = deadline && signal ? AbortSignal.any([signal, deadline]) : deadline || signal;
  const payload = { ...body, stream: true, stream_options: { include_usage: true } };
  let text = '';
  let reasoning = '';
  try {
  const response = await fetch(`${MODEL.baseURL}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: combined,
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
  } catch (error) {
    /* Признак «уже что-то показали»: после первых байт повтор задвоил бы текст
       в диалоге, поэтому повторяем только до начала выдачи. */
    error.streamed = Boolean(text || reasoning);
    if (deadline?.aborted && !signal?.aborted) {
      error.status = error.status || 504;
      error.timedOut = true;
    }
    throw error;
  }
}

/** Ответы провайдера, которые имеет смысл повторить: перегрузка и таймауты. */
const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);
/** Сколько раз повторяем шаг при перегрузке. Четыре попытки с растущей паузой
 *  перекрывают короткий сбой провайдера, не превращая сбой в минуты ожидания. */
const MODEL_RETRIES = 3;

/**
 * Запрос к модели с поправками на реальность:
 * — маршрут может не принимать reasoning_effort — повторяем без него;
 * — сильной модели может не быть в доступе — откатываемся на рабочую;
 * — провайдер отвечает 429/5xx или рвёт соединение — повторяем с паузой,
 *   но только пока ничего не показали человеку (иначе текст задвоится).
 */
async function callModel(body, options, { fallbackModel = '' } = {}) {
  let current = { ...body };
  let fixups = 0;
  let tries = 0;
  for (;;) {
    try {
      return await requestCompletion(current, options);
    } catch (error) {
      /* «Стоп» человека не повторяем ни при каких условиях. */
      if (options?.signal?.aborted) throw error;
      const raw = String(error?.raw || '');
      if (fixups < 3) {
        if (current.reasoning_effort && error?.status === 400 && /reasoning_effort|unsupported|unknown/i.test(raw)) {
          const { reasoning_effort, ...rest } = current;
          current = rest;
          fixups += 1;
          continue;
        }
        const modelMissing =
          (error?.status === 400 || error?.status === 404) &&
          fallbackModel &&
          current.model !== fallbackModel &&
          /model|not found|does not exist|invalid|unknown/i.test(raw);
        if (modelMissing) {
          current = { ...current, model: fallbackModel, reasoning_effort: ESCALATION.flashEffort };
          fixups += 1;
          continue;
        }
      }
      const retryable =
        error?.streamed !== true && (!error?.status || error?.timedOut === true || RETRYABLE_STATUS.has(Number(error?.status)));
      if (!retryable || tries >= MODEL_RETRIES) throw error;
      tries += 1;
      /* Пауза растёт и слегка разъезжается случайной добавкой: десять задач,
         упавших одновременно, не должны бить в провайдера одним залпом. */
      const waitMs = Math.min(12000, 1200 * 2 ** (tries - 1)) + Math.round(Math.random() * 400);
      const reason = error?.timedOut
        ? `шаг дольше ${Math.round(CAPACITY.modelTimeoutMs / 1000)} с`
        : error?.status
          ? `ответ ${error.status}`
          : 'обрыв связи';
      console.warn(`[model] ${reason} — повтор ${tries}/${MODEL_RETRIES} через ${waitMs} мс`);
      await sleepAbortable(waitMs, options?.signal);
    }
  }
}

/**
 * Короткий запрос без потоковой выдачи: конспект истории, проверка ответа,
 * правка. `onUsage` получает расход, чтобы служебные вызовы попадали в счёт
 * задачи, а не были бесплатными для владельца сервиса.
 */
export async function simpleCompletion(messages, { maxTokens = 500, signal, effort = 'low', onUsage = null, model = '' } = {}) {
  const key = getDeepSeekKey();
  if (!key) return '';
  /* Служебный вызов тоже под часами: конспект или проверка не должны висеть
     наравне с задачей и держать ход. */
  const deadline = CAPACITY.modelTimeoutMs > 0 ? AbortSignal.timeout(CAPACITY.modelTimeoutMs) : null;
  const bounded = deadline && signal ? AbortSignal.any([signal, deadline]) : deadline || signal;
  const call = (withEffort, name) => {
    const body = { model: name || MODEL.name, messages, max_tokens: maxTokens, stream: false };
    if (withEffort) body.reasoning_effort = effort;
    return fetch(`${MODEL.baseURL}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: bounded,
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
  const json = await response.json();
  if (onUsage && json?.usage) {
    onUsage(Number(json.usage.prompt_tokens || 0), Number(json.usage.completion_tokens || 0));
  }
  return String(json?.choices?.[0]?.message?.content || '').trim();
}


/* Переводчик хода рассуждений: модель думает по-английски, а человек просил
   видеть только русский. Сохраняем структуру, числа, имена и код. */
const REASONING_TRANSLATOR =
  'Ты переводишь ход рассуждений ИИ на русский язык. Сохрани структуру, абзацы, ' +
  'числа, имена, пути и код без изменений. Верни только перевод — без пояснений, ' +
  'вступлений и кавычек вокруг текста.';

/** Режем длинные рассуждения по границам предложений, чтобы перевод не обрезался. */
function splitReasoning(text, limit = 3500) {
  const parts = [];
  let rest = String(text || '');
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n\n', limit);
    if (cut < limit * 0.4) cut = rest.lastIndexOf('. ', limit);
    if (cut < limit * 0.4) cut = rest.lastIndexOf(' ', limit);
    if (cut <= 0) cut = limit;
    parts.push(rest.slice(0, cut + 1));
    rest = rest.slice(cut + 1);
  }
  if (rest.trim()) parts.push(rest);
  return parts;
}

async function translateReasoning(text, { signal, onUsage } = {}) {
  const source = String(text || '').trim();
  if (!source || looksRussian(source)) return source;
  const out = [];
  for (const part of splitReasoning(source)) {
    try {
      const translated = await simpleCompletion(
        [
          { role: 'system', content: REASONING_TRANSLATOR },
          { role: 'user', content: part },
        ],
        {
          maxTokens: Math.min(3000, Math.max(600, Math.ceil(part.length / 1.5))),
          signal,
          effort: 'low',
          onUsage,
        },
      );
      if (translated) out.push(translated);
    } catch {
      if (signal?.aborted) break;
      /* Часть не перевелась — остальное всё равно пробуем. */
    }
  }
  return out.join('\n\n').trim();
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
  'create_deck',
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

/**
 * Ответ отдаётся один раз и уже окончательным.
 *
 * Финальный ревью-пасс (src/review.mjs) правит текст уже после того, как он
 * ушёл в ленту, и человек видел это как «ответ пришёл, а через пару секунд сам
 * изменился». Поэтому текст ответа копим здесь и отдаём одним куском в самом
 * конце — после ревью и досборок. Прогресс, подписи инструментов и рассуждения
 * идут в поток как раньше: работа видна, а готовый ответ больше не переписывается
 * у человека на глазах.
 */
export async function runTurn(options = {}) {
  const emitRaw = typeof options.emit === 'function' ? options.emit : () => {};
  const flush = (text) => {
    if (!text) return;
    try {
      emitRaw({ type: 'delta', text });
    } catch {
      /* лента недоступна — текст всё равно сохранён на сервере */
    }
  };
  const held = [];
  const holdEmit = (event) => {
    if (event?.type === 'delta') {
      if (event.text) held.push(String(event.text));
      return;
    }
    emitRaw(event);
  };
  let outcome;
  try {
    outcome = await runTurnInner({ ...options, emit: holdEmit });
  } catch (error) {
    /* Остановка или сбой: показываем то, что модель успела сказать. */
    flush(held.join(''));
    throw error;
  }
  /* Итог важнее накопленных кусков: в нём уже учтены правки ревью и всё, что
     досборки добавили после потока. */
  flush(String(outcome?.text || '') || held.join(''));
  return outcome;
}

async function runTurnInner({
  workspace,
  chat,
  projectName,
  userName,
  /* Владелец разговора: фоновые задания (озвучка) записываются на него, чтобы
     человек видел прогресс и мог остановить синтез. */
  ownerId = null,
  userText,
  /* Выжимка прошлых диалогов проекта: новый чат не начинает с чистого листа. */
  projectContext = '',
  filesBrief = '',
  images = [],
  /* Вложения текущего хода (имя, вид, путь): build_design ищет по ним
     референс и применяет его стиль, даже если модель не передала путь. */
  attachments = [],
  emit,
  signal,
  budget = null,
  /* Постоянная память пользователя: факты уже прочитаны из store вызывающей
     стороной, remember — функция их записи. */
  facts = [],
  remember = null,
  /* Создание проекта и диалога: функция сервера, которая заводит проект в
     аккаунте человека и открывает в нём диалог. Есть только у основной задачи:
     субагент работает внутри уже открытого проекта и новых не создаёт. */
  createProjectChat = null,
  /* Личный слой: свои блок на дашборде и тема в Top news — это тоже строки
     аккаунта человека, а не файлы проекта. Есть только у основной задачи:
     вложенная работа не меняет то, что человек видит на своём экране. */
  createPersonalBlock = null,
  createNewsTopic = null,
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
  /* Разметку вызовов инструментов проверяем до первого запроса к модели:
     осиротевший ответ или незакрытый вызов — это не повод показывать человеку
     «не удалось получить ответ», а повод починить историю. Иначе диалог
     остаётся сломанным навсегда: каждый следующий ход падает так же. */
  if (Array.isArray(chat.history)) {
    const healed = repairHistoryInPlace(chat.history);
    if (healed.changed) {
      console.warn(
        `[history] диалог ${chat.id || '—'}: починил разметку вызовов инструментов — ` +
          `убрал ${healed.removed}, закрыл ${healed.filled}`,
      );
    }
  }
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

  /* Продолжение узнаём до добавления текущей реплики: если в истории уже есть
     ход человека, это не первый вопрос и здороваться заново нельзя. */
  const continuing =
    Boolean(chat.memory) ||
    Boolean(chat.task?.goal) ||
    (Array.isArray(chat.history) && chat.history.some((item) => item?.role === 'user'));
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
  /* Досборка чертежей даётся один раз за ход: повторные шаги не должны
     превращаться в цикл «сделай ещё раз». */
  let repairTried = false;
  /* Досборка результата (файл/выжимка) — до двух раз: первый шаг обычно
     возвращает модель к работе, второй нужен, если она снова ушла в план. */
  const DELIVERABLE_REPAIRS_MAX = 2;
  let deliverableRepairs = 0;
  let incomplete = false;
  let incompleteNote = '';
  const startedMs = Date.now();
  /* Что вернул предыдущий шаг: по этому решается, кто ведёт следующий. Профиль
     хода — только база; внутри хода шаги неравноценны (см. chooseStepRoute). */
  let previousStep = null;
  const stepRoutes = [];

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
        /* createProjectChat, createPersonalBlock и createNewsTopic сюда
           намеренно не передаются: проекты, свои блоки и свои темы заводит
           только основная задача. У воркера depth > 0, и инструменты отказали бы
           сами, но и функций у него быть не должно — право менять аккаунт
           человека не наследуется вложенной работой. */
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

  /* Флаги «в этом ходу уже создан проект / добавлен блок / добавлена тема»
     лежат в отдельных объектах, а не прямо в toolCtx: executeTool вызывает
     ветку с копией контекста ({ ...ctx, signal }), и присваивание
     ctx.createdProject = true терялось бы между шагами — агент создал бы второй
     проект за тот же ход. Объекты копируются по ссылке, поэтому флаг виден
     следующему вызову. Блок и тема считаются отдельно: это разные экраны. */
  const projectGuard = { createdProject: false };
  const personalGuard = { block: false, topic: false };
  const toolCtx = {
    workspace,
    signal,
    remember,
    projectName,
    userName,
    facts,
    depth,
    ownerId,
    attachments,
    spawnAgent: spawnSubagents,
    createProjectChat,
    createPersonalBlock,
    createNewsTopic,
    projectGuard,
    personalGuard,
  };

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
    const system = systemPrompt({ projectName, projectContext, memory: chat.memory, userName, question: userText, facts, skillsText, filesBrief, task: chat.task, modes: { thinking, search }, continuing });
    /* История уходит модели только в допустимом виде: даже если что-то попало
       в неё посреди шага, запрос не будет отвергнут из-за разметки вызовов. */
    const messages = [{ role: 'system', content: system }, ...normalizeHistory(chat.history).messages];

    /* У каждого шага свой буфер начала реплики — см. src/narration.mjs. */
    const narration = createNarrationGate({ emit: (text) => emit({ type: 'delta', text }) });

    /* Рассуждения показываем только по-русски: английский оригинал копим и
       переводим к концу шага — см. src/reasoning.mjs. */
    const reasoningGate = thinking
      ? createReasoningGate({
          emit: (text) => emit({ type: 'reasoning', text }),
          translate: (text) =>
            translateReasoning(text, {
              signal,
              onUsage: (tokensIn, tokensOut) => {
                usage.tokensIn += tokensIn;
                usage.tokensOut += tokensOut;
              },
            }),
        })
      : null;

    /* Кто ведёт ИМЕННО этот шаг: база хода уточняется по результату прошлого
       шага. Переключение видно в логе — иначе поведение выглядит случайным. */
    const stepRoute = chooseStepRoute({ route, step: steps, previous: previousStep, config: ESCALATION, split: SPLIT });
    if (stepRoute.switched) {
      stepRoutes.push({ step: steps, profile: stepRoute.profile, why: stepRoute.why });
      console.log(`[model] ${describeStepRoute(stepRoute)}`);
    }

    const result = await callModel(
      {
        model: stepRoute.model,
        messages,
        tools: toolDefs,
        tool_choice: 'auto',
        max_tokens: CONTEXT.maxOutputTokens,
        reasoning_effort: stepRoute.effort,
      },
      {
        signal,
        /* Начало реплики шага держим в буфере: если шаг вызовет инструменты,
           это был ход мысли («I'll start by…»), и в ленту он не пойдёт. */
        onDelta: (text) => narration.push(text),
        onReasoning: (text) => {
          reasoningGate?.push(text);
        },
      },
      { fallbackModel: ESCALATION.flashModel },
    );

    if (reasoningGate) {
      const shownReasoning = await reasoningGate.finish();
      if (shownReasoning) reasoningText = (reasoningText + shownReasoning).slice(-24000);
    }

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
        return { text: finalText, usage, tools: toolsUsed, steps, memory: chat.memory, budgetHit, trim: trimStats, route: { ...route, steps: stepRoutes }, reasoning: reasoningText };
      }
    }

    if (!result.toolCalls.length) {
      /* «Готово.» при пустой папке — тот самый брак, из-за которого задача
         уходила в работу и возвращалась без файлов. Один адресный шаг досборки
         дешевле пустого проекта: модель получает прямое указание, каким
         инструментом делается чертёж, и не может ответить «сделано» снова. */
      const repairNeeded = needsDrawingRepair({
        userText,
        workspace,
        toolsUsed,
        answer: result.text || '',
        tried: repairTried,
      });
      if (repairNeeded) {
        repairTried = true;
        /* Сказанное «Готово.» не оставляем ни в ответе, ни в истории: модель
           не должна опираться на собственную пустую заявку. */
        finalText = finalText.slice(0, Math.max(0, finalText.length - stepAnswer.length));
        emit({ type: 'progress', step: steps, limit: stepLimit, note: 'файлов нет — досборка чертежей' });
        chat.history.push({ role: 'user', content: DRAWING_REPAIR_PROMPT });
        continue;
      }
      /* Досборка не помогла: модель снова ответила текстом. Пустую заявку
         заменяем честным «почему файлов нет» — иначе человек опять получит
         «Готово.» и пустую панель, то есть ровно тот дефект, что был в отчёте. */
      const emptyAfterRepair =
        repairTried &&
        needsDrawingRepair({
          userText,
          workspace,
          toolsUsed,
          answer: result.text || '',
          tried: false,
        });
      if (emptyAfterRepair) {
        finalText = finalText.slice(0, Math.max(0, finalText.length - stepAnswer.length));
        /* Последний рубеж: модель так и не вызвала сборку. Собираем проект
           детерминированно из самой просьбы — человек получает листы и список
           принятых допущений, а не извинение при пустой панели. */
        const rescued = await rescueDesign({ workspace, userText, attachments });
        if (rescued) {
          finalText = `${finalText}${finalText ? '\n\n' : ''}${rescued}`;
          emit({ type: 'progress', step: steps, limit: stepLimit, note: 'листы собраны запасным путём' });
          chat.history.push({ role: 'assistant', content: rescued });
          finished = true;
          break;
        }
        finalText = `${finalText}${finalText ? '\n\n' : ''}${MISSING_FILES_ANSWER}`;
        emit({ type: 'progress', step: steps, limit: stepLimit, note: 'листы не собрались — сказал прямо' });
        chat.history.push({ role: 'assistant', content: MISSING_FILES_ANSWER });
        finished = true;
        break;
      }
      /* Общий случай: человек просил файл/выжимку, а модель закончила
         обещанием «сейчас соберу». Не отдаём это как готовый ответ — даём
         адресный шаг и только после него показываем итог. */
      const missingDeliverable = needsDeliverableRepair({
        userText,
        workspace,
        toolsUsed,
        answer: result.text || '',
        startedMs,
      });
      if (missingDeliverable) {
        if (deliverableRepairs < DELIVERABLE_REPAIRS_MAX) {
          deliverableRepairs += 1;
          finalText = finalText.slice(0, Math.max(0, finalText.length - stepAnswer.length));
          chat.task = updateTaskState(chat.task, {
            userText,
            tools: toolsUsed,
            steps,
            segments: Math.ceil(steps / segmentSize),
          });
          emit({
            type: 'progress',
            step: steps,
            limit: stepLimit,
            note: deliverableRepairs === 1 ? 'результат ещё не готов — продолжаю сам' : 'файла нет — ещё одна попытка',
          });
          chat.history.push({ role: 'user', content: continuePrompt(chat.task, DELIVERABLE_REPAIR_PROMPT) });
          continue;
        }
        incomplete = true;
        incompleteNote = MISSING_DELIVERABLE_NOTE;
        /* Сказанное уже ушло в ленту — не выдёргиваем его задним числом,
           просто честно помечаем, что результат не доведён. */
        finalText = `${finalText}${finalText ? '\n\n' : ''}${MISSING_DELIVERABLE_NOTE}`;
        emit({ type: 'delta', text: `${finalText === MISSING_DELIVERABLE_NOTE ? '' : '\n\n'}${MISSING_DELIVERABLE_NOTE}` });
        emit({ type: 'progress', step: steps, limit: stepLimit, note: 'результат не готов — нужна кнопка «Продолжить»' });
        chat.history.push({ role: 'assistant', content: finalText });
        finished = true;
        break;
      }
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

    /* Итог шага для выбора следующего: сколько данных пришло и не упал ли он. */
    let stepChars = 0;
    let stepFailed = false;

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
      stepChars += String(content || '').length;
      if (status === 'error') stepFailed = true;
      if (signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    }
    /* Снимок шага для маршрутизации следующего. `mechanicalRun` — сколько
       механических шагов идёт подряд: после второго подряд разбор уже не нужен. */
    const stepTools = assistantMessage.tool_calls.map((call) => call.function.name);
    const stepMechanical = stepTools.length > 0 && stepTools.every(isMechanicalTool);
    previousStep = {
      tools: stepTools,
      chars: stepChars,
      failed: stepFailed,
      mechanicalRun: stepMechanical ? Number(previousStep?.mechanicalRun || 0) + 1 : 0,
    };
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
      const system = systemPrompt({ projectName, projectContext, memory: chat.memory, userName, question: userText, facts, skillsText, filesBrief, task: chat.task, modes: { thinking, search }, continuing });
      /* Карточка задачи в финальном сообщении помогает итогу быть по делу:
         модель называет готовые файлы, а не пересказывает процесс. */
      const card = taskSummaryLine(chat.task);
      const wrapGate = thinking
        ? createReasoningGate({
            emit: (text) => emit({ type: 'reasoning', text }),
            translate: (text) =>
              translateReasoning(text, {
                signal,
                onUsage: (tokensIn, tokensOut) => {
                  usage.tokensIn += tokensIn;
                  usage.tokensOut += tokensOut;
                },
              }),
          })
        : null;
      const result = await callModel(
        {
          model: route.model,
          messages: [
            { role: 'system', content: system },
            ...normalizeHistory(chat.history).messages,
            { role: 'user', content: card ? `${WRAP_UP_PROMPT}\n\n${card}` : WRAP_UP_PROMPT },
          ],
          max_tokens: CONTEXT.maxOutputTokens,
          reasoning_effort: route.effort,
        },
        {
          signal,
          onDelta: (text) => emit({ type: 'delta', text }),
          onReasoning: (text) => {
            wrapGate?.push(text);
          },
        },
        { fallbackModel: ESCALATION.flashModel },
      );
      if (result.usage) {
        usage.tokensIn += result.usage.prompt_tokens || 0;
        usage.tokensOut += result.usage.completion_tokens || 0;
      }
      if (wrapGate) {
        const shownReasoning = await wrapGate.finish();
        if (shownReasoning) reasoningText = (reasoningText + shownReasoning).slice(-24000);
      }
      finalText += result.text || '';
      chat.history.push({ role: 'assistant', content: result.text || '' });
      finished = true;
    } catch {
      /* итог не получился — остаётся всё, что уже сказано в ленте */
    }
  }

  /* Markdown-черновик не должен доживать до «Файлов проекта»: человеку нужен
     один читаемый документ и озвучка, а не .md рядом с .docx. */
  const removedDrafts = cleanupUnrequestedMarkdown({ workspace, userText, startedMs });
  if (removedDrafts.length) {
    console.log(`[agent] убраны md-черновики: ${removedDrafts.join(', ')}`);
  }

  /* Карточка задачи закрывает ход: она же станет началом следующего. */
  chat.task = updateTaskState(chat.task, { userText, tools: toolsUsed, steps });

  /* Последний рубеж: даже если ответ пришёл не через обычную ветку (потолок
     шагов, аварийный итог), не выдаём его за готовый, когда запрошенного
     файла нет. Человек получит честную пометку и кнопку продолжения. */
  if (!incomplete && needsDeliverableRepair({ userText, workspace, toolsUsed, answer: finalText, startedMs })) {
    incomplete = true;
    incompleteNote = MISSING_DELIVERABLE_NOTE;
    let added = '';
    if (!finalText.includes(MISSING_DELIVERABLE_NOTE)) {
      added = `${finalText ? '\n\n' : ''}${MISSING_DELIVERABLE_NOTE}`;
      finalText += added;
    }
    const last = chat.history[chat.history.length - 1];
    if (last?.role === 'assistant') last.content = finalText;
    /* Пометку отдаём в поток: иначе в ленте останется бодрое «готово», а
       после перезагрузки появится другое сообщение. */
    if (added) emit({ type: 'delta', text: added });
  }

  /* Финальный ревью-пасс: сверяем ответ с тем, что вернули инструменты.
     Дорогой вызов делаем только для содержательных ответов с инструментами;
     при находках — одна правка, при сбое — исходный текст. Проверяющий
     получает выдержки готовых файлов и, если настроено, другую модель: одна
     и та же модель повторяет свои слепые зоны. */
  let review = null;
  if (finalText && REVIEW.enabled) {
    /* Проверка идёт вне потока: в ленте её не видно, поэтому без строки в живом
       статусе пауза перед ответом читалась бы как зависание. */
    if (needsReview({ answer: finalText, tools: toolsUsed, depth })) {
      emit({ type: 'progress', step: steps, limit: stepLimit, note: 'сверяю ответ с результатами работы' });
    }
    try {
      const createdFiles = toolsUsed.map((tool) => tool.path).filter(Boolean);
      /* Файлы проекта — чтобы ответ, ссылающийся на документ из прошлого хода,
         не считался обещанием несуществующего файла. Список короткий: только
         имена, без содержимого и без чтения файлов. */
      let projectFiles = [];
      try {
        projectFiles = listTree(workspace, '.', { depth: 3, maxEntries: 300 }).filter((item) => !item.dir).map((item) => item.path);
      } catch {
        projectFiles = [];
      }
      const excerpts = await buildReviewExcerpts(createdFiles, workspace);
      const result = await reviewAnswer({
        userQuestion: userText,
        answer: finalText,
        history: chat.history,
        createdFiles,
        projectFiles,
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
    /* Ревью — скрытый вызов модели: без строки в логе не видно, что проверял
       сильный профиль и за что списались токены. */
    const reviewLine = describeReview(review);
    if (reviewLine) console.log(`[review] ${reviewLine}`);
  }

  return { text: finalText, usage, tools: toolsUsed, steps, memory: chat.memory, trim: trimStats, route: { ...route, steps: stepRoutes }, review, reasoning: reasoningText, incomplete, incompleteNote };
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

