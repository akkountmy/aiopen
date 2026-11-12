/**
 * Слой навыков (skills): файлы skills/<id>/SKILL.md с инструкциями.
 *
 * В локальном харнессе навык — это каталог с SKILL.md: короткое описание в
 * каталоге, полное тело подгружается по требованию. Здесь то же самое:
 * описание каждого навыка попадает в системное сообщение (компактно), а тело
 * модель запрашивает инструментом use_skill.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SKILLS_DIR = path.join(ROOT, 'skills');

/**
 * Сколько символов тела навыка отдаём модели.
 *
 * Порог 14000 был на грани: самый длинный навык уже 13077 знаков, следующий
 * рост обрезался бы молча — вместе с концом инструкции, где проверка и сдача.
 * Держим 24000 как запас, а при обрезке показываем размер, чтобы дефект был
 * виден. Результат use_skill в подсказке не сжимается (skipTools в trim.mjs),
 * поэтому длина тела — это стоимость вызова; платим только при открытии навыка.
 *
 * 34000 (10.11.2026): вместе с PM-навыками пришли длинные: humanizer 32453,
 * company-intel 31143, intelligence-collection-disciplines 25482. Резать их на
 * 24000 значило отрубить хвост с проверкой и сдачей, поэтому подняли потолок под
 * самый длинный. Тест catalog.mjs держит max < потолка, чтобы рост снова не
 * проскочил молча.
 */
export const SKILL_BODY_CHARS = 34000;

let cache = null;

function parseFrontmatter(raw) {
  const text = String(raw || '').replace(/^\uFEFF/, '');
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!match) return { meta: {}, body: text.trim() };
  const meta = {};
  for (const line of match[1].split(/\r?\n/)) {
    const pair = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line.trim());
    if (pair) meta[pair[1]] = pair[2].replace(/^["']|["']$/g, '').trim();
  }
  return { meta, body: text.slice(match[0].length).trim() };
}

function loadAll() {
  const list = [];
  let entries = [];
  try {
    entries = fs.readdirSync(SKILLS_DIR, { withFileTypes: true });
  } catch {
    return list;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const id = entry.name;
    const file = path.join(SKILLS_DIR, id, 'SKILL.md');
    if (!fs.existsSync(file)) continue;
    let raw = '';
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const { meta, body } = parseFrontmatter(raw);
    if (!body) continue;
    list.push({
      id,
      name: meta.name || id,
      description: meta.description || body.split(/\r?\n/).find((line) => line.trim()) || id,
      body,
      chars: body.length,
    });
  }
  list.sort((a, b) => a.id.localeCompare(b.id));
  return list;
}

function skills() {
  if (!cache) cache = loadAll();
  return cache;
}

/** Сбросить кэш: полезно в тестах и после правки файлов навыков на сервере. */
export function reloadSkills() {
  cache = null;
  return skills();
}

export function listSkills() {
  return skills().map(({ id, name, description, chars }) => ({ id, name, description, chars }));
}

export function skillIds() {
  return skills().map((skill) => skill.id);
}

export function getSkill(id) {
  const wanted = String(id || '').trim().toLowerCase();
  if (!wanted) return null;
  const all = skills();
  return all.find((skill) => skill.id.toLowerCase() === wanted) || null;
}

/**
 * Описание навыка одной строкой для каталога.
 *
 * Простое отрезание по 240 знаков срезало ровно то, по чему навык вызывается:
 * слова-триггеры стоят в конце описания («Use when «дизайн интерьера», …»).
 * Было: 34 триггера в 9 навыках не попадали в системное сообщение, и модель
 * просто не знала, что навык просят такими словами. Поэтому хвост не
 * выбрасываем, а сжимаем: основная фраза плюс триггеры в кавычках, пока
 * влезают в предел.
 */
export function compactDescription(description, limit = 240) {
  const text = String(description || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  if (text.length <= limit) return text;
  const triggers = [];
  for (const match of text.matchAll(/«([^»]{2,60})»/g)) {
    const trigger = match[1].trim();
    if (trigger && !triggers.includes(trigger)) triggers.push(trigger);
  }
  /* Тема — до первого тире: «Проектирование интерьера квартиры или комнаты —
     зонирование, …» даёт тему в 46 знаков, остальное место уходит триггерам.
     Нет тире — берём первое предложение. */
  const dash = text.indexOf(' — ');
  let head = dash >= 25 ? text.slice(0, dash) : text.split(/(?<=[.!?])\s/)[0];
  head = head.replace(/[\s;:,—–-]+$/, '').trim();
  const headMax = Math.floor(limit * 0.55);
  if (head.length > headMax) {
    const cut = head.slice(0, headMax).lastIndexOf(' ');
    head = (cut > 60 ? head.slice(0, cut) : head.slice(0, headMax)).trim();
  }
  /* Обрезка по границе слова оставляла хвост из служебного слова: «…, как».
     Такую строку модель читает как незаконченную мысль — убираем. */
  for (let step = 0; step < 4; step++) {
    head = head.replace(/[\s,;:—–-]+$/, '');
    const dangling = head.match(/(?:^|\s)(?:и|или|как|что|для|при|под|над|без|через|про|из|от|до|по|на|в|во|с|со|к|ко|о|об|а|но|это)$/i);
    if (!dangling) break;
    head = head.slice(0, head.length - dangling[0].length);
  }
  head = head.replace(/[\s,;:—–-]+$/, '').trim();
  const extra = [];
  let used = head.length + 3;
  for (const trigger of triggers) {
    if (head.includes(trigger)) continue;
    const piece = `«${trigger}»`;
    if (used + piece.length + 2 > limit) break;
    extra.push(piece);
    used += piece.length + 2;
  }
  if (!extra.length) return head;
  return `${head} — ${extra.join(', ')}`;
}

/** Строки каталога: одна на навык. Отдельно от текста — для тестов и аудита. */
export function catalogLines() {
  return skills().map((skill) => `— ${skill.id}: ${compactDescription(skill.description)}`);
}

/** Каталог навыков для системного сообщения: одна строка на навык. */
export function skillsPromptText() {
  const all = skills();
  if (!all.length) return '';
  const lines = ['Доступные навыки (полную инструкцию открывает инструмент use_skill):', ...catalogLines()];
  lines.push(
    'Перед ответственной работой по теме навыка (документ, таблица, презентация, PDF, сайт, анализ большого файла, аудит финансов, бизнес-план, ресёрч интернета) сначала вызови use_skill с его id и следуй инструкции. Если инструкция называет файл рядом с навыком (template.md, examples/…), открой его тем же use_skill с полем file.',
    'Структуру ответа в диалоге (разбор, сравнение, план, инструкция, риски) открывай по answer-structure, наглядность (таблица, матрица, таймлайн, воронка, чек-лист) — по answer-visuals.',
  );
  return lines.join('\n');
}

/** Тело навыка для выдачи модели. */
export function skillBody(id) {
  const skill = getSkill(id);
  if (!skill) {
    return {
      ok: false,
      text: `Навык «${id}» не найден. Доступны: ${skillIds().join(', ') || 'пока нет'}.`,
    };
  }
  const body =
    skill.body.length > SKILL_BODY_CHARS
      ? `${skill.body.slice(0, SKILL_BODY_CHARS)}\n\n(инструкция обрезана: показано ${SKILL_BODY_CHARS} из ${skill.body.length} знаков, хвост с проверкой и сдачей не показан — недостающее уточни у пользователя или в файлах проекта)`
      : skill.body;
  return { ok: true, id: skill.id, name: skill.name, text: `Навык «${skill.id}» — ${skill.name}\n\n${body}` };
}

/** Сколько знаков файла рядом с навыком отдаём модели. */
export const SKILL_FILE_CHARS = 20000;

/**
 * Файлы рядом с навыком: шаблоны, примеры, скрипты.
 *
 * Часть навыков ссылается на `template.md` и `examples/sample.md`, лежащие в их
 * папке. В отличие от рабочей папки человека, эти файлы не видны обычному
 * чтению проекта, поэтому их отдаёт тот же use_skill — иначе ссылка в
 * инструкции обрывается, и модель придумывает структуру заново.
 */
export function skillFiles(id) {
  const skill = getSkill(id);
  if (!skill) return [];
  const base = path.join(SKILLS_DIR, skill.id);
  const out = [];
  const walk = (dir, prefix) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), rel);
      else if (rel !== 'SKILL.md') out.push(rel);
    }
  };
  walk(base, '');
  return out.sort();
}

/** Текстовый файл из папки навыка: только внутри неё и только чтение. */
export function skillFile(id, relName) {
  const skill = getSkill(id);
  if (!skill) {
    return { ok: false, text: `Навык «${id}» не найден. Доступны: ${skillIds().join(', ') || 'пока нет'}.` };
  }
  const wanted = String(relName || '').replace(/\\/g, '/').replace(/^\.\//, '').trim();
  const files = skillFiles(skill.id);
  if (!wanted) {
    return { ok: false, text: `Укажи файл навыка «${skill.id}». Рядом лежат: ${files.join(', ') || 'файлов нет'}.` };
  }
  const base = path.join(SKILLS_DIR, skill.id);
  const full = path.resolve(base, wanted);
  if (full !== base && !full.startsWith(base + path.sep)) {
    return { ok: false, text: `Файл берётся только из папки навыка «${skill.id}», а не «${wanted}».` };
  }
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) {
    return { ok: false, text: `Файла «${wanted}» у навыка «${skill.id}» нет. Есть: ${files.join(', ') || 'файлов нет'}.` };
  }
  const raw = fs.readFileSync(full, 'utf8');
  const text =
    raw.length > SKILL_FILE_CHARS
      ? `${raw.slice(0, SKILL_FILE_CHARS)}\n\n(файл обрезан: показано ${SKILL_FILE_CHARS} из ${raw.length} знаков)`
      : raw;
  return { ok: true, id: skill.id, file: wanted, text: `Файл ${wanted} навыка «${skill.id}»\n\n${text}` };
}
