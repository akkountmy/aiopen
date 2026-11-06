/**
 * Каталог навыков: строка на навык, триггеры и предел бюджета.
 *
 * Дефект, который проверяем: обрезка описания по 240 знакам срезала слова, по
 * которым навык вызывается. Было 34 потерянных триггера в 9 навыках; после
 * сжатия с сохранением триггеров осталось 4 в 3 навыках (хвост списка).
 *
 * Запуск: node test/catalog.mjs
 */
import assert from 'node:assert/strict';
import { catalogLines, compactDescription, listSkills, skillsPromptText, SKILL_BODY_CHARS } from '../src/skills.mjs';

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const LIMIT = 240;
/* Известный остаток: описание длиннее предела, последние триггеры не влезают. */
const KNOWN_LOST = ['interior-design', 'obscura', 'ploy-site'];

test('каждая строка каталога не длиннее предела', () => {
  for (const line of catalogLines()) {
    const shown = line.slice(line.indexOf(': ') + 2);
    assert.ok(shown.length <= LIMIT, `${line.slice(0, 40)}…: ${shown.length} > ${LIMIT}`);
  }
});

test('строка каталога не обрывается служебным словом', () => {
  for (const line of catalogLines()) {
    assert.ok(
      !/(?:\s)(?:и|или|как|что|для|при|в|во|с|со|на|по|о|об|а|но|это)\s*—\s*«/i.test(line),
      `обрыв на служебном слове: ${line.slice(0, 120)}`,
    );
  }
});

test('триггеры попадают в каталог (кроме известного остатка)', () => {
  const lines = catalogLines();
  const lost = [];
  for (const skill of listSkills()) {
    const shown = lines.find((line) => line.startsWith(`— ${skill.id}: `)) || '';
    const triggers = [...String(skill.description || '').matchAll(/«([^»]{3,60})»/g)].map((match) => match[1].trim());
    for (const trigger of triggers) if (!shown.includes(trigger)) lost.push(skill.id);
  }
  const extra = [...new Set(lost)].filter((id) => !KNOWN_LOST.includes(id));
  assert.deepEqual(extra, [], `потеряны триггеры навыков: ${extra.join(', ')}`);
  assert.ok(lost.length <= 4, `потеряно триггеров: ${lost.length}`);
});

test('каталог целиком укладывается в бюджет и растёт вместе с навыками', () => {
  const text = skillsPromptText();
  assert.equal(text.split('\n').length, listSkills().length + 3, 'строк каталога: навыки плюс заголовок и два правила');
  assert.ok(text.length < 12000, `каталог ${text.length} знаков — выше бюджета 12000`);
  assert.ok(text.includes('use_skill'), 'в каталоге должно быть указание открывать навык инструментом');
});

test('сжатие описания не теряет смысл на коротком описании', () => {
  const short = 'Короткое описание навыка без триггеров.';
  assert.equal(compactDescription(short), short);
  const long = `Тема навыка о расчётах — подробности, детали, нюансы, ${'ещё слова, '.repeat(40)}Use when «посчитай», «проверь цифры».`;
  const compact = compactDescription(long);
  assert.ok(compact.length <= LIMIT, `сжатие ${compact.length} > ${LIMIT}`);
  assert.ok(compact.includes('«посчитай»'), 'триггер должен сохраниться');
  assert.ok(compact.startsWith('Тема навыка о расчётах'), 'тема должна остаться в начале');
});

test('потолок тела навыка не меньше самого длинного тела', () => {
  const max = Math.max(...listSkills().map((skill) => skill.chars));
  assert.ok(max < SKILL_BODY_CHARS, `самый длинный навык ${max} ≥ потолка ${SKILL_BODY_CHARS}: инструкция обрежется молча`);
});

let failed = 0;
for (const item of tests) {
  try {
    await item.fn();
    console.log(`ok   ${item.name}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL ${item.name}: ${error?.message || error}`);
  }
}
console.log(failed ? `\n${failed} из ${tests.length} не прошли` : `\nвсе ${tests.length} прошли`);
process.exit(failed ? 1 : 0);
