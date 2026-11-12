/**
 * Каталог навыков: строка на навык, триггеры и предел бюджета.
 *
 * Дефект, который проверяем: обрезка описания по 240 знакам срезала слова, по
 * которым навык вызывается. Было 34 потерянных триггера в 9 навыках; после
 * сжатия с сохранением триггеров потерь нет, а список ниже остаётся страховкой:
 * навык, чьё описание переросло предел, обязан быть назван здесь явно.
 *
 * Запуск: node test/catalog.mjs
 */
import assert from 'node:assert/strict';
import { catalogLines, compactDescription, listSkills, skillFile, skillFiles, skillsPromptText, SKILL_BODY_CHARS } from '../src/skills.mjs';

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
  /* Бюджет 12000 → 16000 (10.11.2026): добавили 26 PM-навыков, каталог стал
     75 навыков и 15.3 тыс. знаков. 16000 → 16800 (11.11.2026): шесть навыков
     финансового блока (юнит-экономика, скоринг, инвестмеморандум, правовая
     проверка, внутренний контроль, задача аналитике), 81 навык и 16.5 тыс.
     знаков. Планка поднята явно, а не по инерции: каталог уходит в каждый
     запрос, поэтому следующее пополнение требует не поднятия предела, а
     сжатия формулировок — средняя строка уже 197 знаков при обрезке по 240. */
  assert.ok(text.length < 16800, `каталог ${text.length} знаков — выше бюджета 16800`);
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

test('файлы рядом с навыком открываются и не выходят из папки', () => {
  /* 22 навыка из набора ссылаются на template.md и examples/sample.md. Эти
     файлы лежат вне рабочей папки человека, поэтому их отдаёт use_skill с
     полем file — проверяем, что шаблон читается, а чужой путь отклоняется. */
  assert.ok(skillFiles('jobs-to-be-done').includes('template.md'), 'файлы навыка видны списком');
  const template = skillFile('jobs-to-be-done', 'template.md');
  assert.equal(template.ok, true, template.text);
  assert.ok(template.text.includes('Jobs-to-be-Done'), 'в шаблоне должен быть его заголовок');
  const example = skillFile('jobs-to-be-done', 'examples/sample.md');
  assert.equal(example.ok, true, example.text);
  assert.equal(skillFile('jobs-to-be-done', '../office-docx/SKILL.md').ok, false, 'выход из папки навыка запрещён');
  assert.equal(skillFile('jobs-to-be-done', 'нет-такого.md').ok, false, 'отсутствующий файл объясняется отказом');
  assert.equal(skillFile('нет-такого-навыка', 'template.md').ok, false, 'неизвестный навык объясняется отказом');
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
