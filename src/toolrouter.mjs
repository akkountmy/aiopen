/**
 * Инструменты по требованию.
 *
 * В запросе всегда едет только базовый набор схем, а остальные перечислены
 * коротким каталогом внутри tool_search. Модель называет задачу или точные
 * имена — нужные схемы подключаются к следующему шагу. Так десятки описаний не
 * оплачиваются токенами на каждом шаге, но остаются доступны в любой момент.
 *
 * Модуль нарочно ничего не импортирует: его можно проверять отдельно от
 * tools.mjs и не ловить циклическую зависимость.
 */

/** Что видно сразу: чтение и запись файлов, поиск, расчёты, навыки, интернет,
 *  память и субагенты. Этого хватает на обычный шаг; тяжёлые генераторы
 *  документов, телеграм и юридический полигон подключаются по требованию. */
export const CORE_TOOL_NAMES = Object.freeze([
  'list_files',
  'read_file',
  'write_file',
  'append_file',
  'edit_file',
  'find_in_files',
  'read_document',
  'analyze_image',
  'calculate',
  'web_search',
  'fetch_url',
  'use_skill',
  'remember',
  'check_document',
  'spawn_agent',
]);

export const TOOL_SEARCH_NAME = 'tool_search';

/** Больше восьми схем за один поиск подключать незачем: это уже не экономия,
 *  а тот же полный набор, только в два шага. */
export const MAX_REVEAL = 8;

/**
 * Русские слова, которыми люди и модель называют группу инструментов.
 * Синонимы нужны, потому что имена английские, а запрос часто русский:
 * «сделай презентацию» должен находить create_pptx и create_deck.
 */
const ALIAS_GROUPS = [
  ['excel', 'xlsx', 'эксель', 'таблиц', 'table'],
  ['word', 'docx', 'ворд', 'документ', 'document', 'договор', 'contract', 'резюме', 'отчет'],
  ['pptx', 'powerpoint', 'презентац', 'слайд', 'slide'],
  ['pdf', 'пдф'],
  ['narrat', 'озвуч', 'аудио', 'mp3', 'голос'],
  ['tg', 'telegram', 'телеграм', 'канал'],
  ['score_credit', 'скоринг', 'кредит', 'заявк'],
  ['drawing', 'чертеж', 'чертёж', 'схем', 'svg'],
  ['design', 'дизайн', 'интерьер', 'помещен'],
  ['archive', 'zip', 'архив', 'распаков'],
  ['agent', 'субагент', 'агент', 'подзадач'],
  ['scrape', 'парс', 'скрап', 'markdown'],
  ['image', 'картин', 'изображен', 'скриншот', 'фото'],
  ['data', 'данн', 'анализ', 'csv'],
  ['web', 'интернет', 'поиск', 'ссылк'],
  ['page', 'landing', 'лендинг', 'страниц', 'сайт', 'site'],
  ['legal', 'юр', 'право', 'суд', 'договор', 'contract'],
  ['compare', 'сравн', 'diff', 'отличи'],
  ['check', 'провер', 'validate'],
  ['project', 'проект'],
  ['code', 'код', 'скрипт', 'script', 'python', 'питон', 'javascript', 'тест', 'test', 'debug', 'баг'],
];

/** Служебные слова не должны выбирать инструмент: «сделай» есть в половине
 *  описаний и тянет случайные схемы выше нужной. */
const STOP_WORDS = new Set([
  'сделай', 'сделать', 'создай', 'создать', 'нужен', 'нужно', 'надо', 'пожалуйста',
  'мне', 'мой', 'для', 'под', 'про', 'как', 'что', 'чем', 'или', 'это', 'все',
  'make', 'create', 'please', 'with', 'for', 'and', 'the', 'a', 'an', 'of', 'in', 'on',
]);

function normalize(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}_]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function stem(term) {
  /* Короткие слова не режем: «запусти» → «запус» начинает совпадать с
     «запускает» в чужих описаниях и тянет случайный инструмент. */
  if (term.length < 8) return '';
  return term.slice(0, Math.max(6, term.length - 2));
}

/** Варианты термина: сам термин, его основа и слова из той же группы. */
function variants(term) {
  const out = new Set([term]);
  const base = stem(term);
  if (base && base !== term) out.add(base);
  for (const group of ALIAS_GROUPS) {
    const hit = group.some((word) => word.length >= 3 && (term.startsWith(word) || word.startsWith(term)));
    if (!hit) continue;
    for (const word of group) {
      if (word.length >= 3) out.add(word);
    }
  }
  return [...out];
}

/** Первая фраза описания без разметки — строка каталога, а не весь абзац. */
export function clipSummary(text, max = 86) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const at = Math.max(cut.lastIndexOf(' '), cut.lastIndexOf(';'), cut.lastIndexOf(','));
  const body = cut.slice(0, at > 36 ? at : max).replace(/[.,;:—–-]+$/, '');
  return `${body}…`;
}

/** Короткая строка каталога для каждого инструмента, кроме самого поиска. */
export function toolCatalog(defs, { exclude = [TOOL_SEARCH_NAME] } = {}) {
  const skip = new Set(exclude);
  return (Array.isArray(defs) ? defs : [])
    .filter((def) => def?.function?.name && !skip.has(def.function.name))
    .map((def) => ({
      name: def.function.name,
      summary: clipSummary(def.function.description),
    }));
}

/** Каталог одной строкой: имя — назначение; имя — назначение; ... */
export function catalogText(defs, { exclude } = {}) {
  return toolCatalog(defs, { exclude })
    .map((row) => `${row.name} — ${row.summary}`)
    .join('; ');
}

/** Подменить описание tool_search на версию с актуальным каталогом.
 *  Каталог строится из доступных сейчас схем, поэтому run_python не рекламируется
 *  там, где Python не установлен. */
export function withToolSearchCatalog(defs) {
  const list = Array.isArray(defs) ? defs : [];
  const search = list.find((def) => def?.function?.name === TOOL_SEARCH_NAME);
  if (!search) return list;
  /* Базовые схемы уже видны — в каталоге им делать нечего: он про то,
     чего в запросе нет. Сам поиск тоже не рекламируем. */
  const core = new Set(CORE_TOOL_NAMES);
  const hidden = list.filter((def) => {
    const name = def?.function?.name;
    return name && name !== TOOL_SEARCH_NAME && !core.has(name);
  });
  const catalog = catalogText(hidden);
  const description = [
    'Подключить инструмент по требованию. В запросе сразу видны только базовые инструменты; остальные не загружены, чтобы не тратить контекст, и перечислены в каталоге ниже.',
    'Передай query словами задачи («Excel с диаграммой», «озвучить книгу», «разобрать телеграм-канал») или names с точными именами из каталога. Вернутся имена подключённых инструментов, а их схемы появятся в СЛЕДУЮЩЕМ шаге — тогда вызывай их как обычно.',
    `За один вызов подключается не больше ${MAX_REVEAL} инструментов. Если нужного имени нет в каталоге, скажи об этом человеку, а не выдумывай инструмент.`,
    `Каталог (${hidden.length}): ${catalog}`,
  ].join('\n\n');
  return list.map((def) => (def === search
    ? { ...def, function: { ...def.function, description } }
    : def));
}

/** Начальный набор: базовые схемы плюс tool_search. Порядок — как в реестре,
 *  поэтому префикс запроса не меняется, когда позже дописываются новые схемы. */
export function buildLazyToolset(defs, { core = CORE_TOOL_NAMES } = {}) {
  const list = Array.isArray(defs) ? defs : [];
  const byName = new Map(list.map((def) => [def?.function?.name, def]).filter(([name]) => Boolean(name)));
  const visible = [];
  const seen = new Set();
  for (const name of core) {
    const def = byName.get(name);
    if (def && !seen.has(name)) {
      visible.push(def);
      seen.add(name);
    }
  }
  const search = byName.get(TOOL_SEARCH_NAME);
  if (search && !seen.has(TOOL_SEARCH_NAME)) {
    visible.push(search);
    seen.add(TOOL_SEARCH_NAME);
  }
  /* Если реестр неожиданно не совпал с базовым списком, лучше отдать всё,
     чем оставить модель без инструментов. */
  if (!visible.length) return { defs: list.slice(), hidden: [], universe: list.slice(), coreNames: [] };
  const hidden = list.filter((def) => !seen.has(def?.function?.name));
  return { defs: visible, hidden, universe: list.slice(), coreNames: [...seen] };
}

/** Дописать схемы в конец: уже отправленный префикс tools не меняется, поэтому
 *  кэш провайдера продолжает работать. Возвращает новый массив. */
export function activateToolDefs(current, universe, names) {
  const have = new Set((Array.isArray(current) ? current : []).map((def) => def?.function?.name));
  const byName = new Map((Array.isArray(universe) ? universe : [])
    .map((def) => [def?.function?.name, def])
    .filter(([name]) => Boolean(name)));
  const next = (Array.isArray(current) ? current : []).slice();
  const added = [];
  for (const raw of Array.isArray(names) ? names : []) {
    const name = String(raw || '').trim();
    if (!name || have.has(name)) continue;
    const def = byName.get(name);
    if (!def) continue;
    next.push(def);
    have.add(name);
    added.push(name);
  }
  return { defs: next, added };
}

function scoreTool(def, terms, query, labels, intent = {}) {
  const name = String(def?.function?.name || '');
  const hayName = normalize(name);
  const description = normalize(def?.function?.description);
  const label = normalize(labels?.[name]);
  let score = 0;

  if (query && normalize(query) === hayName) score += 200;
  /* «Сделай лендинг» и «спарси лендинг» — разные задачи. Глагол изготовления
     поднимает сборщики, иначе page_template проигрывает read_page по имени. */
  if (intent.build && intent.project && name === 'create_project') score += 45;
  /* «Сделай резюме» — это Word, а не сравнение документов: общий синоним
     «документ» иначе уравнивает создание с разбором готовых файлов. */
  if (intent.build && intent.document && /^create_(word|pdf)$/.test(name)) score += 25;
  if (intent.page && (name === 'page_template' || name === 'check_page')) score += 45;
  if (intent.design && name === 'build_design') score += 45;
  if (intent.parse && ['scrape_page', 'read_page', 'crawl', 'fetch_url', 'fetch_many', 'check_links'].includes(name)) {
    score += 45;
  }
  for (const term of terms) {
    if (term === name) {
      score += 140;
      continue;
    }
    if (term.includes('_') && name.includes(term)) score += 90;
    else if (hayName.includes(term)) score += 38;
    if (label.includes(term)) score += 20;
    if (description.includes(term)) score += 8;
    for (const alt of variants(term)) {
      if (alt === term) continue;
      if (hayName.includes(alt)) score += 26;
      if (label.includes(alt)) score += 12;
      if (description.includes(alt)) score += 5;
    }
  }
  return score;
}

/** Найти инструменты по словам задачи. Точное имя всегда первым, дальше —
 *  совпадения по имени, русской метке и описанию. */
export function matchToolDefs(defs, query, { labels = {}, limit = 4 } = {}) {
  const text = normalize(query);
  if (!text) return [];
  const terms = [...new Set(text
    .split(' ')
    .filter((term) => (term.length >= 2 || term.includes('_')) && !STOP_WORDS.has(term)))];
  if (!terms.length) return [];
  const allVariants = new Set(terms.flatMap((term) => variants(term)));
  const parse = /(^|\s)(спарс|спарси|соскрап|извлеки|разбери|parse|scrape)(\s|$)/.test(text);
  const intent = {
    build: /(^|\s)(сделай|создай|собери|сверстай|нарисуй|подготовь|make|create|build)(\s|$)/.test(text),
    page: !parse && ['page', 'landing', 'лендинг', 'страниц', 'сайт', 'site'].some((word) => allVariants.has(word)),
    design: ['design', 'дизайн', 'интерьер', 'помещен'].some((word) => allVariants.has(word)),
    project: allVariants.has('проект') || allVariants.has('project'),
    document: ['word', 'docx', 'документ', 'резюме', 'отчет'].some((word) => allVariants.has(word)),
    parse,
  };
  const scored = (Array.isArray(defs) ? defs : [])
    .filter((def) => def?.function?.name && def.function.name !== TOOL_SEARCH_NAME)
    .map((def, index) => ({ def, index, score: scoreTool(def, terms, text, labels, intent) }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index);
  return scored.slice(0, Math.max(1, Number(limit) || 4)).map((row) => row.def);
}
