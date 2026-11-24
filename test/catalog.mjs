/**
 * Каталог навыков: строка на навык, триггеры и предел бюджета.
 *
 * Дефект, который проверяем: обрезка описания по пределу срезала слова, по
 * которым навык вызывается. Было 34 потерянных триггера в 9 навыках; после
 * сжатия с сохранением триггеров потерь нет, а список ниже остаётся страховкой:
 * навык, чьё описание переросло предел, обязан быть назван здесь явно.
 *
 * Запуск: node test/catalog.mjs
 */
import assert from 'node:assert/strict';
import {
  catalogLines,
  catalogSkills,
  compactDescription,
  getSkill,
  listSkills,
  skillBody,
  skillFile,
  skillFiles,
  skillsPromptText,
  SKILL_BODY_CHARS,
} from '../src/skills.mjs';

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const LIMIT = 210;
/* Известный остаток: описание длиннее предела, последние триггеры не влезают.
   На 18.11.2026 пусто: четыре навыка, которые теряли триггеры при переходе с
   240 на 210 (interior-design, obscura, pm-senior, technical-writing), получили
   переписанные описания, и все 318 триггеров попадают в каталог. */
const KNOWN_LOST = [];

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
  /* Только навыки каталога: у скрытых дочерних (catalog: false) своей строки
     нет, их триггеры обязан нести родитель — это проверяет следующий тест. */
  for (const skill of catalogSkills()) {
    const shown = lines.find((line) => line.startsWith(`— ${skill.id}: `)) || '';
    const triggers = [...String(skill.description || '').matchAll(/«([^»]{3,60})»/g)].map((match) => match[1].trim());
    for (const trigger of triggers) if (!shown.includes(trigger)) lost.push(skill.id);
  }
  const extra = [...new Set(lost)].filter((id) => !KNOWN_LOST.includes(id));
  assert.deepEqual(extra, [], `потеряны триггеры навыков: ${extra.join(', ')}`);
  assert.ok(lost.length <= KNOWN_LOST.length, `потеряно триггеров: ${lost.length}`);
});

test('скрытый дочерний навык открывается по id и не теряет маршрут', () => {
  /* Объединение семейства (24.11.2026): 14 навыков про дом убраны из каталога
     и стоят строкой у родителя house-build / house-design. Скрытый навык без
     маршрута — это навык, которого для модели не существует: поэтому у каждого
     скрытого проверяем id в теле родителя и все его триггеры в тексте родителя
     (строка каталога плюс тело). */
  const hidden = listSkills('admin').filter((skill) => skill.catalog === false);
  assert.ok(hidden.length > 0, 'скрытых навыков нет — тест ничего не проверяет');
  const parents = new Map();
  const parentText = (id) => {
    if (!parents.has(id)) {
      const skill = getSkill(id, 'admin');
      assert.ok(skill, `у скрытого навыка нет родителя ${id}: маршрут потерян`);
      const line = catalogLines('admin').find((item) => item.startsWith(`— ${id}: `)) || '';
      parents.set(id, `${line}\n${skill.body}`);
    }
    return parents.get(id);
  };
  const lost = [];
  for (const skill of hidden) {
    assert.equal(skill.access, 'all', `${skill.id}: скрытый навык не должен быть закрытым`);
    assert.equal(skillBody(skill.id, 'admin').ok, true, `${skill.id}: тело не открывается по id`);
    const text = parentText(skill.id.replace(/-[^-]+$/, ''));
    if (!text.includes(skill.id)) lost.push(`${skill.id}: нет id у родителя`);
    const triggers = [...String(skill.description || '').matchAll(/«([^»]{3,60})»/g)].map((match) => match[1].trim());
    for (const trigger of triggers) if (!text.includes(trigger)) lost.push(`${skill.id}: «${trigger}»`);
  }
  assert.deepEqual(lost, [], `скрытые навыки без маршрута: ${lost.join('; ')}`);
});

test('каталог целиком укладывается в бюджет и растёт вместе с навыками', () => {
  const text = skillsPromptText();
  assert.equal(
    text.split('\n').length,
    catalogLines().length + 3,
    'строк каталога: строки навыков плюс заголовок и два правила',
  );
  /* Бюджет 12000 → 16000 (10.11.2026): добавили 26 PM-навыков, каталог стал
     75 навыков и 15.3 тыс. знаков. 16000 → 16800 (11.11.2026): шесть навыков
     финансового блока (юнит-экономика, скоринг, инвестмеморандум, правовая
     проверка, внутренний контроль, задача аналитике), 81 навык и 16.5 тыс.
     знаков. Планка поднята явно, а не по инерции: каталог уходит в каждый
     запрос, поэтому следующее пополнение требует не поднятия предела, а
     сжатия формулировок — средняя строка уже 197 знаков при обрезке по 240. */
  /* Предел сжатия 240 → 210 (18.11.2026): каталог подошёл к планке 16 800
     вплотную (16 614, свободно 186 знаков), и одна новая строка роняла тест.
     После сжатия и переписанных описаний: 15 192 знака, планка 16 000 —
     свободно 808, это четыре новых навыка без правки предела. */
  assert.ok(text.length < 16000, `каталог ${text.length} знаков — выше бюджета 16000`);
  /* Запас под планкой (24.11.2026). Планка держится, а запас под ней — нет:
     каталог дошёл до 15 579 при плане 16 000 (свободно 421), и запас теста
     подсказки (test/docs.mjs, 1 200 знаков) кончился раньше, чем этот тест
     что-то заметил. Поэтому у планки появился собственный резерв 600: пока
     свободно больше 600, новые навыки есть куда добавлять; когда станет
     меньше, падает этот быстрый тест — с запасом 400 знаков, чтобы успеть
     сжать описания или явно поднять планку, а не ловить поломку на проде. */
  const slack = 16000 - text.length;
  assert.ok(slack >= 600, `каталог ${text.length} знаков — под планкой 16000 свободно ${slack}, нужно 600`);
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
  /* Запас обязателен: потолок, подогнанный под самый длинный навык вплотную,
     обрезает его хвост при первом же абзаце. 34 000 против 32 453 давали 4.5 %,
     теперь потолок 38 000, а тест требует не меньше 10 % запаса. */
  const max = Math.max(...listSkills().map((skill) => skill.chars));
  assert.ok(
    max <= SKILL_BODY_CHARS * 0.9,
    `самый длинный навык ${max} при потолке ${SKILL_BODY_CHARS}: запас меньше 10 %, инструкция обрежется молча`,
  );
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
