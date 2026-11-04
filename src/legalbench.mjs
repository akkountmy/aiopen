/**
 * Юридический полигон: Harvey LAB (Legal Agent Benchmark) внутри сервиса.
 *
 * Harvey LAB — открытый бенчмарк юридической работы (harveyai/harvey-labs, MIT):
 * 2010 заданий по 27 практикам. У каждого задания есть инструкция, папка
 * documents/ с материалами дела и рубрика из критериев PASS/FAIL. Оценка
 * «всё-или-ничего»: 1.0, только если пройдены ВСЕ критерии, иначе 0.0.
 *
 * Официальный харнесс (lab-core) требует Python 3.12/3.13, поэтому здесь
 * повторён контракт задания и правило оценки, а не сам Python-движок: задание
 * готовится как рабочая папка для нашего агента, проверяет работу судья-модель
 * по тем же match_criteria.
 *
 * Данные тянем разреженным чекаутом: сначала только каталог заданий
 * (tasks/** /task.json, ~80 МБ), документы конкретного дела — по запросу.
 * Ничего не пишется в общий проект пользователя: подготовка идёт в
 * data/legalbench/runs/<run> либо в папку, которую указал вызывающий.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DATA_DIR, MODEL, ESCALATION } from './config.mjs';
import { CAPACITY } from './capacity.mjs';
import { getDeepSeekKey } from './keys.mjs';
import { extractDocumentText } from './docparse.mjs';
import { readJson, writeJson, formatBytes, escapeHtml } from './util.mjs';

const execFileAsync = promisify(execFile);

/** Корень полигона. Отдельная переменная — чтобы тесты и стенд не трогали рабочие данные. */
export const LAB_DIR = process.env.DSHOW_LEGALBENCH_DIR
  ? path.resolve(process.env.DSHOW_LEGALBENCH_DIR)
  : path.join(DATA_DIR, 'legalbench');
export const LAB_REPO_URL = process.env.DSHOW_LEGALBENCH_REPO || 'https://github.com/harveyai/harvey-labs.git';
export const LAB_REPO_DIR = path.join(LAB_DIR, 'repo');
export const LAB_TASKS_DIR = path.join(LAB_REPO_DIR, 'tasks');
export const LAB_CATALOG_FILE = path.join(LAB_DIR, 'catalog.json');
export const LAB_RUNS_DIR = path.join(LAB_DIR, 'runs');

/** Сколько символов текста работы видит судья на один критерий. */
export const LAB_JUDGE_DOC_CHARS = Number(process.env.DSHOW_LEGALBENCH_DOC_CHARS || 24000);
/** Предохранитель от случайного «оцени всё»: 1114 критериев в самой тяжёлой задаче. */
export const LAB_JUDGE_MAX_CRITERIA = Math.max(
  1,
  Math.min(2000, Number(process.env.DSHOW_LEGALBENCH_MAX_CRITERIA || 200) || 200),
);

const GIT_TIMEOUT_MS = 300000;

/* ─────────────────────────── git: данные бенчмарка ─────────────────────────── */

function gitEnv() {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: 'echo',
    LC_ALL: 'C',
  };
}

async function git(args, { cwd = LAB_REPO_DIR, timeout = GIT_TIMEOUT_MS } = {}) {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      timeout,
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
      env: gitEnv(),
    });
    return String(stdout || '');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error('Не найден git: полигон тянет задания из репозитория Harvey LAB, нужен установленный git.');
    }
    const stderr = String(error?.stderr || error?.message || '').trim().split(/\r?\n/).slice(-3).join(' ');
    throw new Error(`git ${args[0]} не сработал: ${stderr || 'без описания'}`);
  }
}

export function repoReady() {
  return fs.existsSync(path.join(LAB_REPO_DIR, '.git'));
}

function repoCommit() {
  try {
    return fs.readFileSync(path.join(LAB_REPO_DIR, '.git', 'HEAD'), 'utf8').trim();
  } catch {
    return '';
  }
}

/**
 * Скачать/обновить каталог заданий и пересобрать catalog.json.
 * `refresh` подтягивает свежий main (бенчмарк пополняется).
 */
export async function syncCatalog({ refresh = false, log = () => {} } = {}) {
  fs.mkdirSync(LAB_DIR, { recursive: true });
  if (!repoReady()) {
    log('клонирую каталог заданий (без файлов дел)');
    await git(['clone', '--filter=blob:none', '--no-checkout', '--depth', '1', LAB_REPO_URL, 'repo'], {
      cwd: LAB_DIR,
    });
    await git(['sparse-checkout', 'set', '--no-cone', 'tasks/**/task.json']);
    await git(['checkout']);
  } else if (refresh) {
    log('обновляю каталог заданий');
    await git(['fetch', '--depth', '1', 'origin', 'main']);
    await git(['reset', '--hard', 'FETCH_HEAD']);
  }
  const catalog = scanCatalog(log);
  writeJson(LAB_CATALOG_FILE, catalog);
  return {
    tasks: catalog.length,
    areas: new Set(catalog.map((task) => task.area)).size,
    commit: repoCommit(),
    scannedAt: new Date().toISOString(),
  };
}

function scanCatalog(log = () => {}) {
  if (!fs.existsSync(LAB_TASKS_DIR)) {
    throw new Error('Каталога заданий нет: сначала скачай его (sync).');
  }
  const tasks = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name === 'task.json') {
        const id = path.relative(LAB_TASKS_DIR, dir).replace(/\\/g, '/');
        try {
          const task = JSON.parse(fs.readFileSync(full, 'utf8'));
          tasks.push({
            id,
            area: id.split('/')[0],
            title: String(task.title || id),
            workType: String(task.work_type || ''),
            criteria: Array.isArray(task.criteria) ? task.criteria.length : 0,
            deliverables: deliverableNames(task),
            tags: Array.isArray(task.tags) ? task.tags : [],
            instructionsChars: String(task.instructions || '').length,
          });
        } catch (error) {
          log(`пропуск ${id}: ${error.message}`);
        }
      }
    }
  };
  walk(LAB_TASKS_DIR);
  tasks.sort((a, b) => a.id.localeCompare(b.id));
  return tasks;
}

/* ─────────────────────────── каталог и задания ─────────────────────────── */

function deliverableNames(task) {
  const names = [];
  const add = (value) => {
    const name = String(value || '').trim();
    if (name && !names.includes(name)) names.push(name);
  };
  if (Array.isArray(task?.deliverables)) task.deliverables.forEach(add);
  else if (task?.deliverables && typeof task.deliverables === 'object') Object.keys(task.deliverables).forEach(add);
  if (Array.isArray(task?.criteria)) {
    for (const criterion of task.criteria) {
      if (Array.isArray(criterion?.deliverables)) criterion.deliverables.forEach(add);
    }
  }
  return names;
}

export function readCatalog({ strict = true } = {}) {
  const catalog = readJson(LAB_CATALOG_FILE, null);
  if (!Array.isArray(catalog)) {
    if (strict) throw new Error('Каталог заданий не собран: выполни sync (node scripts/legalbench.mjs sync).');
    return [];
  }
  return catalog;
}

/** Фильтры каталога: практика, тип работы, поиск по названию/тегам, размер рубрики. */
export function filterTasks(tasks, { area = '', workType = '', q = '', minCriteria = 0, maxCriteria = 0, limit = 40, offset = 0 } = {}) {
  const needle = String(q || '').trim().toLowerCase();
  const areaNeedle = String(area || '').trim().toLowerCase();
  const workNeedle = String(workType || '').trim().toLowerCase();
  const list = (Array.isArray(tasks) ? tasks : []).filter((task) => {
    if (areaNeedle && String(task.area).toLowerCase() !== areaNeedle) return false;
    if (workNeedle && String(task.workType || '').toLowerCase() !== workNeedle) return false;
    if (minCriteria && Number(task.criteria) < Number(minCriteria)) return false;
    if (maxCriteria && Number(task.criteria) > Number(maxCriteria)) return false;
    if (needle) {
      const haystack = `${task.id} ${task.title} ${(task.tags || []).join(' ')}`.toLowerCase();
      if (!haystack.includes(needle)) return false;
    }
    return true;
  });
  const start = Math.max(0, Number(offset) || 0);
  return {
    total: list.length,
    items: list.slice(start, start + Math.max(1, Number(limit) || 40)),
  };
}

export function listTasks(options = {}) {
  return filterTasks(readCatalog(), options);
}

/** id задания не должен выводить за пределы tasks/: защита от «../..» из аргументов агента. */
export function resolveTaskId(raw) {
  const normalized = String(raw || '').trim().replace(/\\/g, '/');
  const id = normalized.replace(/^\/+|\/+$/g, '').replace(/^tasks\//, '');
  if (!id) throw new Error('Нужен id задания, например real-estate/extract-psa-key-terms/scenario-01');
  if (/^[A-Za-z]:/.test(normalized) || normalized.startsWith('/')) {
    throw new Error(`Некорректный id задания: ${raw}`);
  }
  const parts = id.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) {
    throw new Error(`Некорректный id задания: ${raw}`);
  }
  return id;
}

function listFiles(dir) {
  const items = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else items.push({ path: full, name: path.relative(dir, full).replace(/\\/g, '/'), size: fs.statSync(full).size });
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return items.sort((a, b) => a.name.localeCompare(b.name));
}

/** Полное задание: рубрика, инструкция, наличие и состав документов. */
export function readTask(rawId) {
  const id = resolveTaskId(rawId);
  const dir = path.join(LAB_TASKS_DIR, id);
  const file = path.join(dir, 'task.json');
  if (!fs.existsSync(file)) {
    throw new Error(`Задания ${id} нет в каталоге. Проверь id в списке (list).`);
  }
  const task = JSON.parse(fs.readFileSync(file, 'utf8'));
  const documents = listFiles(path.join(dir, 'documents'));
  return {
    id,
    dir,
    area: id.split('/')[0],
    title: String(task.title || id),
    workType: String(task.work_type || ''),
    instructions: String(task.instructions || ''),
    tags: Array.isArray(task.tags) ? task.tags : [],
    deliverables: deliverableNames(task),
    criteria: (Array.isArray(task.criteria) ? task.criteria : []).map((criterion) => ({
      id: String(criterion.id || ''),
      title: String(criterion.title || ''),
      match: String(criterion.match_criteria || ''),
      deliverables: Array.isArray(criterion.deliverables) ? criterion.deliverables.map(String) : [],
    })),
    documents: documents.map((item) => ({ name: item.name, size: item.size })),
    documentsReady: documents.length > 0,
  };
}

/** Документы дела качаются разреженным чекаутом: только папка этого задания. */
export async function fetchDocuments(rawId, { log = () => {} } = {}) {
  const id = resolveTaskId(rawId);
  if (!repoReady()) throw new Error('Каталог заданий не скачан: выполни sync.');
  const dir = path.join(LAB_TASKS_DIR, id);
  if (!fs.existsSync(path.join(dir, 'task.json'))) {
    throw new Error(`Задания ${id} нет в каталоге.`);
  }
  const existing = listFiles(path.join(dir, 'documents'));
  if (existing.length) return { id, fetched: false, documents: existing.map((item) => ({ name: item.name, size: item.size })) };
  log(`тяну документы дела ${id}`);
  await git(['sparse-checkout', 'add', `tasks/${id}/**`]);
  await git(['checkout']);
  const documents = listFiles(path.join(dir, 'documents'));
  return { id, fetched: true, documents: documents.map((item) => ({ name: item.name, size: item.size })) };
}

/* ─────────────────────────── рабочая папка задания ─────────────────────────── */

function runIdFor(id) {
  const slug = resolveTaskId(id).split('/').slice(-1)[0] || 'task';
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '');
  return `${stamp}-${slug.replace(/[^\w.-]+/g, '-')}`.slice(0, 80);
}

/**
 * Подготовить задание к работе: папка с копией документов, пустая output/,
 * инструкция, рубрика и task.json — ровно то, что нужно агенту.
 */
export async function prepareTask(rawId, { dest = '', log = () => {} } = {}) {
  const task = readTask(rawId);
  if (!task.documents.length) await fetchDocuments(task.id, { log });
  const refreshed = readTask(task.id);
  const dir = dest
    ? path.resolve(dest)
    : path.join(LAB_RUNS_DIR, runIdFor(task.id));
  const documentsDir = path.join(dir, 'documents');
  const outputDir = path.join(dir, 'output');
  fs.mkdirSync(outputDir, { recursive: true });
  const sourceDir = path.join(refreshed.dir, 'documents');
  if (fs.existsSync(sourceDir)) {
    fs.cpSync(sourceDir, documentsDir, { recursive: true, force: true });
  }
  fs.copyFileSync(path.join(refreshed.dir, 'task.json'), path.join(dir, 'task.json'));
  writeJson(path.join(dir, 'criteria.json'), refreshed.criteria);
  fs.writeFileSync(
    path.join(dir, 'instructions.md'),
    [
      `# ${refreshed.title}`,
      '',
      `- id: \`${refreshed.id}\``,
      `- практика: ${refreshed.area}`,
      `- тип работы: ${refreshed.workType || 'не указан'}`,
      `- критериев в рубрике: ${refreshed.criteria.length} (оценка «всё-или-ничего»)`,
      '',
      '## Инструкция бенчмарка',
      '',
      refreshed.instructions || '(пусто)',
      '',
      '## Что положить в output/',
      '',
      ...(refreshed.deliverables.length
        ? refreshed.deliverables.map((name) => `- \`${name}\``)
        : ['- имя файла не задано: следуй инструкции']),
      '',
      '## Материалы дела (documents/)',
      '',
      ...(refreshed.documents.length
        ? refreshed.documents.map((item) => `- \`${item.name}\` (${formatBytes(item.size)})`)
        : ['- документов нет']),
      '',
    ].join('\n'),
    'utf8',
  );
  return {
    id: refreshed.id,
    title: refreshed.title,
    dir,
    documentsDir,
    outputDir,
    documents: refreshed.documents,
    deliverables: refreshed.deliverables,
    criteria: refreshed.criteria.length,
  };
}

/* ─────────────────────────── чтение работы ─────────────────────────── */

function readDeliverable(dir, name) {
  const full = path.join(dir, path.basename(String(name || '')));
  if (!name || !fs.existsSync(full)) return { name, found: false, text: '' };
  const size = fs.statSync(full).size;
  let text = '';
  try {
    const parsed = extractDocumentText(fs.readFileSync(full), path.basename(full), '', { maxChars: 120000 });
    text = typeof parsed === 'string' ? parsed : String(parsed?.text || '');
  } catch (error) {
    text = '';
  }
  return { name, found: true, size, text: text.trim(), chars: text.trim().length };
}

/** Текст работы для одного критерия: только его файлы, с обрезкой по бюджету судьи. */
export function collectDeliverableText(outputDir, names, { maxChars = LAB_JUDGE_DOC_CHARS } = {}) {
  const list = (Array.isArray(names) ? names : [names]).filter(Boolean);
  const files = list.map((name) => readDeliverable(outputDir, name));
  const missing = files.filter((file) => !file.found || !file.text).map((file) => file.name);
  const chunks = [];
  for (const file of files) {
    if (!file.text) continue;
    chunks.push(`=== ${file.name} ===\n${file.text}`);
  }
  let text = chunks.join('\n\n');
  if (text.length > maxChars) text = `${text.slice(0, maxChars)}\n\n[…текст обрезан по бюджету проверки]`;
  return { text, files, missing };
}

/* ─────────────────────────── судья ─────────────────────────── */

const JUDGE_SYSTEM =
  'Ты — строгий проверяющий юридической работы (grader). Тебе дают критерий рубрики с эталонным ' +
  'стандартом проверки и текст подготовленного документа. Ты решаешь только один вопрос: выполнен ' +
  'критерий или нет. Никаких поблажек за старание, объём или общие слова: нужен прямой факт, ' +
  'число, ссылка на раздел или формулировка, которые требует стандарт. Если требуемого фрагмента ' +
  'нет, он искажён или подменён общим рассуждением — FAIL. Отвечай только JSON без markdown и без ' +
  'лишних полей: {"verdict":"PASS"|"FAIL","reason":"одно-два предложения по-русски, что именно ' +
  'нашёл или чего нет"}.';

/** Повторная просьба, когда судья ответил не в формате: формат важнее содержания. */
export const NUDGE = (prompt) =>
  `${prompt}\n\nПРЕДЫДУЩИЙ ОТВЕТ БЫЛ НЕ В ФОРМАТЕ. Верни ровно один JSON-объект с двумя полями: ` +
  '{"verdict":"PASS","reason":"…"} или {"verdict":"FAIL","reason":"…"}. Никаких других полей, ' +
  'никакого текста вокруг.';

export function buildJudgePrompt({ taskTitle, criterion, names, text }) {
  const scope = (names || []).filter(Boolean).join(', ') || '(файл не задан)';
  return [
    `ЗАДАНИЕ: ${taskTitle}`,
    `КРИТЕРИЙ ${criterion.id}: ${criterion.title}`,
    `СТАНДАРТ ПРОВЕРКИ: ${criterion.match || '(не задан)'}`,
    `ФАЙЛЫ В ОБЛАСТИ КРИТЕРИЯ: ${scope}`,
    '',
    'ТЕКСТ РАБОТЫ:',
    '<<<',
    text && text.trim() ? text : '(файл отсутствует или пуст)',
    '>>>',
    '',
    'Проверь только этот критерий и верни JSON.',
  ].join('\n');
}

/* Судьи отвечают по-разному: {"verdict":"PASS"}, {"status":"pass"}, {"result":true},
   {"met": false}. Все эти варианты — вердикт, а не мусор; разбор не должен их терять. */
const VERDICT_KEYS = [
  'verdict', 'result', 'status', 'decision', 'outcome', 'evaluation',
  'answer', 'met', 'meets', 'pass', 'passed', 'satisfied', 'compliant',
];
const REASON_KEYS = ['reason', 'reasoning', 'explanation', 'comment', 'notes', 'justification', 'why'];

const PASS_WORDS = /^(PASS|PASSED|YES|TRUE|OK|MET|SATISFIED|COMPLIANT|ВЫПОЛНЕН\w*|ЗАЧЁТ\w*)$/;
const FAIL_WORDS = /^(FAIL|FAILED|NO|FALSE|NOT[\s_-]*MET|UNMET|NOT[\s_-]*SATISFIED|НЕ[\s_-]*ВЫПОЛНЕН\w*|НЕЗАЧЁТ\w*)$/;

function normalizeVerdict(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value === 1 ? true : value === 0 ? false : null;
  const text = String(value ?? '').trim().toUpperCase();
  if (!text) return null;
  if (PASS_WORDS.test(text)) return true;
  if (FAIL_WORDS.test(text)) return false;
  return null;
}

function pickReason(data) {
  for (const key of REASON_KEYS) {
    const value = data?.[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

/** Разбор ответа судьи: JSON, а если модель добавила текст вокруг — ищем вердикт по словам. */
export function parseVerdict(raw) {
  const text = String(raw || '').trim();
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const data = JSON.parse(jsonMatch[0]);
      for (const key of VERDICT_KEYS) {
        const pass = normalizeVerdict(data?.[key]);
        if (pass !== null) return { pass, reason: pickReason(data), ok: true };
      }
    } catch {
      /* ниже разберём по словам */
    }
  }
  const first = text.match(/\b(PASS|FAIL)\b/i);
  if (first) {
    return {
      pass: first[1].toUpperCase() === 'PASS',
      reason: text.replace(/\s+/g, ' ').slice(0, 300),
      ok: true,
    };
  }
  return {
    pass: false,
    reason: 'Судья не вернул разборчивый вердикт — считаем критерий невыполненным.',
    ok: false,
  };
}

/** Модель судьи: pro по умолчанию (как две сильные модели в оригинале), flash — дешёвый прогон. */
export function judgeRoute(judge = 'pro') {
  const name = String(judge || 'pro').trim();
  if (name === 'pro') return { key: 'pro', model: ESCALATION.proModel || MODEL.name, effort: ESCALATION.proEffort || 'high' };
  if (name === 'flash') return { key: 'flash', model: ESCALATION.flashModel || MODEL.name, effort: ESCALATION.flashEffort || 'high' };
  return { key: name, model: name, effort: ESCALATION.flashEffort || 'high' };
}

async function callJudge({ model, effort, prompt, signal }) {
  const key = getDeepSeekKey();
  if (!key) throw new Error('Ключ сервиса не настроен: оценка работы недоступна.');
  const usage = { in: 0, out: 0 };
  /* Судья — такой же внешний вызов, как обычный шаг агента: без собственного
     потолка зависшее соединение держало бы целый прогон оценки. */
  const judgeDeadline = CAPACITY.modelTimeoutMs > 0 ? AbortSignal.timeout(CAPACITY.modelTimeoutMs) : null;
  const bounded = judgeDeadline && signal ? AbortSignal.any([signal, judgeDeadline]) : judgeDeadline || signal;
  const send = async (payload) =>
    fetch(`${MODEL.baseURL}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: bounded,
    });
  /* У сильной модели рассуждение съедает лимит вывода: иногда ответ приходит пустым.
     Тогда повторяем без усилия, потом с принудительным JSON — а не считаем критерий
     проваленным из-за формата. */
  const attempts = [
    { effort },
    { effort: '', maxTokens: 2000 },
    { effort: 'low', maxTokens: 8000, json: true },
  ];
  let lastText = '';
  let lastError = '';
  for (const attempt of attempts) {
    const body = {
      model,
      messages: [
        { role: 'system', content: JUDGE_SYSTEM },
        { role: 'user', content: prompt },
      ],
      temperature: 0,
      max_tokens: attempt.maxTokens || 1200,
      stream: false,
    };
    if (attempt.effort) body.reasoning_effort = attempt.effort;
    if (attempt.json) body.response_format = { type: 'json_object' };
    let response = await send(body);
    if (response.status === 400 && (body.reasoning_effort || body.response_format)) {
      const { reasoning_effort, response_format, ...rest } = body;
      response = await send(rest);
    }
    if (!response.ok) {
      const raw = await response.text().catch(() => '');
      lastError = `судья ответил ${response.status}: ${raw.slice(0, 200)}`;
      continue;
    }
    const json = await response.json();
    usage.in += Number(json?.usage?.prompt_tokens || 0);
    usage.out += Number(json?.usage?.completion_tokens || 0);
    const message = json?.choices?.[0]?.message || {};
    lastText = String(message.content || '');
    if (!lastText.trim()) {
      /* Рассуждение модели иногда содержит готовый вердикт — берём его, чтобы пустой
         content не превращался в FAIL. Ищем только явный JSON, а не слово в тексте. */
      const reasoning = String(message.reasoning_content || '');
      const jsonVerdict = reasoning.match(/\{[^{}]*"(?:verdict|result|status)"[^{}]*\}/i);
      if (jsonVerdict) lastText = jsonVerdict[0];
    }
    if (lastText.trim()) return { text: lastText, usage };
  }
  if (lastError) throw new Error(lastError);
  return { text: lastText, usage };
}

/**
 * Правило бенчмарка: 1.0 только если пройдены все критерии, иначе 0.0.
 * Отдельной функцией — чтобы правило было одно на прогон, отчёт и тесты.
 */
export function scoreRun(criteria) {
  const list = Array.isArray(criteria) ? criteria : [];
  const passedCount = list.filter((item) => item.pass).length;
  return {
    passedCount,
    total: list.length,
    score: list.length && passedCount === list.length ? 1 : 0,
  };
}

async function mapLimited(items, limit, worker) {
  const results = new Array(items.length);
  let index = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (index < items.length) {
      const current = index++;
      results[current] = await worker(items[current], current);
    }
  });
  await Promise.all(runners);
  return results;
}

/**
 * Оценить работу: по каждому критерию отдельный вызов судьи, затем правило
 * «всё-или-ничего». Пишет scores.json и report.html рядом с результатом.
 */
export async function gradeRun({
  taskId,
  outputDir,
  resultDir = '',
  judge = 'pro',
  criteriaIds = [],
  maxCriteria = 0,
  concurrency = 4,
  log = () => {},
  write = true,
} = {}) {
  const task = readTask(taskId);
  if (!fs.existsSync(outputDir)) throw new Error(`Папки с работой нет: ${outputDir}`);
  let criteria = task.criteria;
  if (Array.isArray(criteriaIds) && criteriaIds.length) {
    const wanted = new Set(criteriaIds.map((id) => String(id).trim()));
    criteria = criteria.filter((criterion) => wanted.has(criterion.id));
  }
  const cap = Math.min(LAB_JUDGE_MAX_CRITERIA, Number(maxCriteria) || LAB_JUDGE_MAX_CRITERIA);
  const sampled = criteria.length > cap;
  if (sampled) criteria = criteria.slice(0, cap);
  const route = judgeRoute(judge);
  const startedAt = new Date().toISOString();
  const usage = { in: 0, out: 0 };

  const scored = await mapLimited(criteria, Math.max(1, Math.min(8, Number(concurrency) || 4)), async (criterion) => {
    const names = criterion.deliverables.length ? criterion.deliverables : task.deliverables;
    const { text, missing } = collectDeliverableText(outputDir, names);
    const prompt = buildJudgePrompt({
      taskTitle: task.title,
      criterion,
      names,
      text,
    });
    let verdict;
    try {
      let answer = await callJudge({ model: route.model, effort: route.effort, prompt });
      usage.in += answer.usage.in;
      usage.out += answer.usage.out;
      let parsed = parseVerdict(answer.text);
      if (!parsed.ok) {
        /* Один повтор: судья иногда уходит в рассуждение и теряет формат. */
        answer = await callJudge({ model: route.model, effort: route.effort, prompt: NUDGE(prompt) });
        usage.in += answer.usage.in;
        usage.out += answer.usage.out;
        parsed = parseVerdict(answer.text);
      }
      verdict = { pass: parsed.pass, reason: parsed.reason, error: '' };
      if (!parsed.ok) verdict.raw = String(answer.text || '').replace(/\s+/g, ' ').slice(0, 400);
    } catch (error) {
      verdict = { pass: false, reason: `Ошибка проверки: ${error.message}`, error: String(error.message || error) };
    }
    log(`${criterion.id} ${verdict.pass ? 'PASS' : 'FAIL'} — ${criterion.title.slice(0, 60)}`);
    return {
      id: criterion.id,
      title: criterion.title,
      standard: criterion.match,
      deliverables: names,
      missing,
      chars: text.length,
      pass: verdict.pass,
      reason: verdict.reason,
      error: verdict.error,
      raw: verdict.raw || '',
    };
  });

  const passedCount = scored.filter((item) => item.pass).length;
  const totals = scoreRun(scored);
  const result = {
    taskId: task.id,
    title: task.title,
    area: task.area,
    judge: route.key,
    model: route.model,
    effort: route.effort,
    rule: 'all-pass',
    score: totals.score,
    passedCount,
    total: scored.length,
    sampled,
    rubricTotal: task.criteria.length,
    startedAt,
    finishedAt: new Date().toISOString(),
    usage,
    criteria: scored,
  };
  if (write) {
    const dir = resultDir ? path.resolve(resultDir) : path.resolve(outputDir);
    fs.mkdirSync(dir, { recursive: true });
    writeJson(path.join(dir, 'scores.json'), result);
    fs.writeFileSync(path.join(dir, 'report.html'), renderReport(result), 'utf8');
    result.reportPath = path.join(dir, 'report.html');
    result.scoresPath = path.join(dir, 'scores.json');
  }
  return result;
}

/* ─────────────────────────── отчёт ─────────────────────────── */

export function renderReport(result) {
  const r = result || {};
  const criteria = Array.isArray(r.criteria) ? r.criteria : [];
  const rows = criteria
    .map(
      (item) => `<tr class="${item.pass ? 'pass' : 'fail'}">
      <td class="id">${escapeHtml(item.id || '')}</td>
      <td class="title">${escapeHtml(item.title || '')}</td>
      <td class="verdict">${item.pass ? 'PASS' : 'FAIL'}</td>
      <td class="reason">${escapeHtml(item.reason || '')}</td>
    </tr>`,
    )
    .join('\n');
  const score = Number(r.score) === 1 ? '1.0' : '0.0';
  const rate = r.total ? Math.round((Number(r.passedCount || 0) / Number(r.total)) * 100) : 0;
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Harvey LAB — ${escapeHtml(r.title || r.taskId || '')}</title>
<style>
  :root { color-scheme: light; }
  body { margin: 0; padding: 32px 24px; font: 15px/1.5 -apple-system, "Segoe UI", Roboto, sans-serif; color: #14181f; background: #f6f7f9; }
  main { max-width: 1040px; margin: 0 auto; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  .muted { color: #5e6773; font-size: 13px; }
  .score { display: flex; gap: 24px; align-items: baseline; margin: 20px 0 8px; }
  .score b { font-size: 40px; line-height: 1; }
  .score .ok { color: #0f7b3f; }
  .score .no { color: #b42318; }
  .cards { display: flex; flex-wrap: wrap; gap: 12px; margin: 16px 0 24px; }
  .card { background: #fff; border: 1px solid #e3e6ea; border-radius: 10px; padding: 12px 16px; min-width: 150px; }
  .card span { display: block; color: #5e6773; font-size: 12px; text-transform: uppercase; letter-spacing: .04em; }
  .card b { font-size: 20px; }
  table { width: 100%; border-collapse: collapse; background: #fff; border: 1px solid #e3e6ea; border-radius: 10px; overflow: hidden; }
  th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid #eef0f3; vertical-align: top; }
  th { background: #f2f4f7; font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: #5e6773; }
  tr:last-child td { border-bottom: none; }
  td.id { white-space: nowrap; color: #5e6773; font-variant-numeric: tabular-nums; }
  td.verdict { font-weight: 600; white-space: nowrap; }
  tr.pass td.verdict { color: #0f7b3f; }
  tr.fail td.verdict { color: #b42318; }
  td.reason { color: #333a44; }
  footer { margin-top: 20px; font-size: 12px; color: #5e6773; }
</style>
</head>
<body>
<main>
  <h1>${escapeHtml(r.title || r.taskId || 'Проверка работы')}</h1>
  <p class="muted">${escapeHtml(r.taskId || '')} · Harvey LAB (Legal Agent Benchmark) · правило «всё-или-ничего»</p>
  <div class="score">
    <b class="${Number(r.score) === 1 ? 'ok' : 'no'}">${score}</b>
    <span class="muted">пройдено ${Number(r.passedCount || 0)} из ${Number(r.total || 0)} критериев (${rate}%)</span>
  </div>
  <div class="cards">
    <div class="card"><span>Судья</span><b>${escapeHtml(r.model || '')}</b></div>
    <div class="card"><span>Критериев в рубрике</span><b>${Number(r.rubricTotal || 0)}</b></div>
    <div class="card"><span>Токены</span><b>${Number(r.usage?.in || 0)} / ${Number(r.usage?.out || 0)}</b></div>
    <div class="card"><span>Проверено</span><b>${escapeHtml(r.finishedAt || '')}</b></div>
  </div>
  ${r.sampled ? '<p class="muted">Проверена часть рубрики (ограничение прогона) — итог «всё-или-ничего» относится к проверенному набору.</p>' : ''}
  <table>
    <thead><tr><th>Критерий</th><th>Что проверяли</th><th>Вердикт</th><th>Комментарий судьи</th></tr></thead>
    <tbody>
${rows}
    </tbody>
  </table>
  <footer>Источник рубрики: harveyai/harvey-labs (MIT). Оценка вынесена нашей моделью-судьёй по тексту работы; инструментальные проверки (pandoc, python) в этом прогоне не участвовали.</footer>
</main>
</body>
</html>`;
}

/* ─────────────────────────── состояние ─────────────────────────── */

export function labStatus() {
  const catalog = readJson(LAB_CATALOG_FILE, null);
  const tasks = Array.isArray(catalog) ? catalog : [];
  return {
    ready: tasks.length > 0,
    repo: repoReady(),
    dir: LAB_DIR,
    tasks: tasks.length,
    areas: new Set(tasks.map((task) => task.area)).size,
    criteriaMin: tasks.length ? Math.min(...tasks.map((task) => task.criteria)) : 0,
    criteriaMax: tasks.length ? Math.max(...tasks.map((task) => task.criteria)) : 0,
    commit: repoCommit(),
    catalogAt: fs.existsSync(LAB_CATALOG_FILE) ? fs.statSync(LAB_CATALOG_FILE).mtime.toISOString() : '',
  };
}
