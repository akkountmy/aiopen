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

/** Сколько символов тела навыка отдаём модели: дальше полезность падает. */
export const SKILL_BODY_CHARS = 14000;

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

/** Каталог навыков для системного сообщения: одна строка на навык. */
export function skillsPromptText() {
  const all = skills();
  if (!all.length) return '';
  const lines = ['Доступные навыки (полную инструкцию открывает инструмент use_skill):'];
  for (const skill of all) {
    const description = String(skill.description || '').replace(/\s+/g, ' ').slice(0, 300);
    lines.push(`— ${skill.id}: ${description}`);
  }
  lines.push(
    'Перед ответственной работой по теме навыка (документ, таблица, презентация, PDF, сайт) сначала вызови use_skill с его id и следуй инструкции.',
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
  const body = skill.body.length > SKILL_BODY_CHARS ? `${skill.body.slice(0, SKILL_BODY_CHARS)}\n\n(инструкция обрезана)` : skill.body;
  return { ok: true, id: skill.id, name: skill.name, text: `Навык «${skill.id}» — ${skill.name}\n\n${body}` };
}
