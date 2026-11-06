// Аудит контура навыков и инструментов DSH open web: числа для базовой линии.
//
//   node scripts/audit-contour.mjs            // краткий отчёт
//   node scripts/audit-contour.mjs --json     // машинный вид
//
// Что считает:
//  - каталог навыков: сколько знаков уходит в системное сообщение на каждый запрос;
//  - описания: влезают ли в каталог целиком, теряются ли слова-триггеры;
//  - тела навыков: самые дорогие (это цена вызова use_skill);
//  - упоминания инструментов: какие названия не существуют в реестре
//    (модель тратит шаги на несуществующее — дефект первого класса);
//  - покрытие: у каждого инструмента есть навык, который его предписывает.
import fs from 'node:fs';
import path from 'node:path';
import { TOOL_DEFS } from '../src/tools.mjs';
import { SKILLS_DIR, listSkills, skillsPromptText, SKILL_BODY_CHARS, catalogLines } from '../src/skills.mjs';

const PROMPT_FILE = path.join(SKILLS_DIR, '..', 'src', 'prompt.mjs');

const tools = new Set(TOOL_DEFS.map((tool) => tool.function?.name).filter(Boolean));
const skills = listSkills();
const catalog = skillsPromptText();

/* Имена, которые модель видит как инструменты: обратные кавычки с подчёркиванием.
   Служебные параметры (max_chars, wait_ms) отсекаем не списком, а по схемам
   инструментов: имя параметра — это не инструмент, и путать их значит считать
   ложные находки. */
const PARAM_NAMES = new Set();
for (const tool of TOOL_DEFS) {
  const walk = (schema) => {
    if (!schema || typeof schema !== 'object') return;
    for (const [key, value] of Object.entries(schema.properties || {})) PARAM_NAMES.add(key);
    for (const value of Object.values(schema.properties || {})) walk(value);
    if (schema.items) walk(schema.items);
  };
  walk(tool.function?.parameters);
}

/* Имена, которые в навыке явно не инструмент: названия полей, идентификаторы
   анти-бот-челленджей и примеры «как называть инструмент» в навыке о сборке
   MCP-серверов. Список короткий и объяснённый: иначе в отчёте остаются находки,
   по которым нечего исправлять, и настоящая поломка теряется среди них. */
const NOT_A_TOOL = new Set([
  'node_modules', // имя каталога в путях, не инструмент
  'fab_chlg', // идентификатор челленджа анти-бота в obscura
  'cf_chl', // то же, Cloudflare
  'search_tickets_by_status', // пример имени в правиле «verb_noun» (mcp-builder)
  'get_user', // пример разделения инструментов (mcp-builder)
  'update_user', // то же
  'match_criteria', // поле рубрики бенчмарка LAB, не инструмент (legal-agent-bench)
]);

function toolMentions(text) {
  const out = new Set();
  /* Код в примерах — не инструкция вызвать инструмент: вырезаем блоки ```. */
  const prose = String(text || '').replace(/```[\s\S]*?```/g, ' ');
  for (const match of prose.matchAll(/`([a-z][a-z0-9]*(?:_[a-z0-9]+)+)`/g)) out.add(match[1]);
  return out;
}

/* Триггеры: то, по чему пользователь просит навык, — в кавычках «…» или после
   «Use when». Если каталог их теряет, навык перестаёт вызываться сам. */
function triggersOf(description) {
  const text = String(description || '');
  const out = [];
  for (const match of text.matchAll(/«([^»]{3,60})»/g)) out.push(match[1].trim());
  return out;
}

const rows = [];
for (const skill of skills) {
  const file = path.join(SKILLS_DIR, skill.id, 'SKILL.md');
  const raw = fs.readFileSync(file, 'utf8');
  const description = String(skill.description || '').replace(/\s+/g, ' ');
  const triggers = triggersOf(description);
  /* Что из описания реально попадает в системное сообщение — считаем по той же
     функции, что и сервер, а не по своей копии правил. */
  const shown = catalogLines().find((line) => line.startsWith(`— ${skill.id}: `)) || '';
  const shownText = shown.replace(`— ${skill.id}: `, '');
  const lostTriggers = triggers.filter((trigger) => !shownText.includes(trigger));
  const mentioned = toolMentions(raw);
  const unknown = [...mentioned].filter((name) => !tools.has(name) && !PARAM_NAMES.has(name) && !NOT_A_TOOL.has(name));
  rows.push({
    id: skill.id,
    bodyChars: skill.chars,
    descChars: description.length,
    shownChars: shownText.length,
    triggers: triggers.length,
    lostTriggers,
    unknownTools: unknown,
    knownTools: [...mentioned].filter((name) => tools.has(name)),
    truncatedBody: skill.chars > SKILL_BODY_CHARS,
  });
}

rows.sort((a, b) => b.bodyChars - a.bodyChars);

/* Неизвестные имена ищем не только в навыках, но и в правилах системного промпта:
   правило, которое зовёт несуществующий инструмент, — тот же дефект. */
const promptText = fs.readFileSync(PROMPT_FILE, 'utf8');
const promptUnknown = [...toolMentions(promptText)].filter((name) => !tools.has(name)).sort();

const unknownAll = rows.flatMap((row) => row.unknownTools.map((name) => ({ skill: row.id, name })));
const lostTriggerSkills = rows.filter((row) => row.lostTriggers.length);
const coveredTools = new Set(rows.flatMap((row) => row.knownTools));
const uncovered = [...tools].filter((name) => !coveredTools.has(name)).sort();

const report = {
  skills: skills.length,
  catalogChars: catalog.length,
  catalogLines: catalog.split('\n').length,
  bodyTotalChars: rows.reduce((sum, row) => sum + row.bodyChars, 0),
  bodyMaxChars: rows[0]?.bodyChars || 0,
  bodyLimit: SKILL_BODY_CHARS,
  truncatedBodies: rows.filter((row) => row.truncatedBody).length,
  descMaxChars: Math.max(0, ...rows.map((row) => row.descChars)),
  triggersTotal: rows.reduce((sum, row) => sum + row.triggers, 0),
  skillsWithLostTriggers: lostTriggerSkills.length,
  lostTriggersTotal: lostTriggerSkills.reduce((sum, row) => sum + row.lostTriggers.length, 0),
  lostTriggersDetail: lostTriggerSkills.map((row) => ({ id: row.id, lost: row.lostTriggers })),
  tools: tools.size,
  toolsUncoveredInSkills: uncovered.length,
  uncovered,
  unknownToolMentions: unknownAll,
  promptUnknownTools: promptUnknown,
  topBodies: rows.slice(0, 8).map((row) => ({ id: row.id, chars: row.bodyChars, tools: row.knownTools.length })),
};

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`навыков: ${report.skills}, каталог: ${report.catalogChars} знаков (${report.catalogLines} строк)`);
  console.log(`тела навыков: всего ${report.bodyTotalChars}, потолок ${report.bodyLimit}, обрезанных ${report.truncatedBodies}, самый длинный ${report.bodyMaxChars}`);
  console.log(`инструментов в реестре: ${report.tools}, без навыка: ${report.toolsUncoveredInSkills}${uncovered.length ? ' → ' + uncovered.join(', ') : ''}`);
  console.log(
    `\nтриггеров в описаниях: ${report.triggersTotal}; навыков, где каталог теряет триггеры: ${report.skillsWithLostTriggers} (потеряно ${report.lostTriggersTotal})`,
  );
  for (const row of lostTriggerSkills) console.log(`  ${row.id}: ${row.descChars} → ${row.shownChars} знаков, потеряно: ${row.lostTriggers.join('; ')}`);
  console.log(`\nнесуществующие инструменты — в навыках: ${unknownAll.length}, в промпте: ${promptUnknown.length}`);
  for (const item of unknownAll) console.log(`  навык ${item.skill}: ${item.name}`);
  for (const name of promptUnknown) console.log(`  промпт: ${name}`);
  console.log('\nсамые дорогие тела навыков (цена вызова use_skill):');
  for (const row of report.topBodies) console.log(`  ${row.id}: ${row.chars} знаков, инструментов в тексте ${row.tools}`);
}

/* Код возврата — для проверок: 1 только при настоящем дефекте (навык зовёт
   несуществующий инструмент). Потерянные триггеры и непокрытые инструменты —
   предмет разбора, но не поломка. */
process.exit(unknownAll.length || promptUnknown.length ? 1 : 0);
