/**
 * Навыки с ограниченным доступом: `access: admin` в SKILL.md.
 *
 * Зачем проверка: каталог навыков попадает в системное сообщение каждому
 * пользователю, а `use_skill` отдаёт тело по id. Ограничение должно работать в
 * обе стороны — админский навык не светится в каталоге обычного пользователя и
 * не открывается прямым id, но у администратора работает как обычный.
 *
 * Запуск: node test/skills-access.mjs
 */
import assert from 'node:assert/strict';
import { executeTool } from '../src/tools.mjs';
import { getSkill, listSkills, skillFiles, skillsPromptText } from '../src/skills.mjs';

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const RESTRICTED = 'pm-senior';

test('админский навык есть в каталоге админа и отсутствует у пользователя', () => {
  assert.ok(listSkills('admin').some((skill) => skill.id === RESTRICTED), 'админ должен видеть навык');
  assert.ok(!listSkills('user').some((skill) => skill.id === RESTRICTED), 'пользователю навык не показывается');
  /* Роль по умолчанию — обычный пользователь: забытая роль не открывает лишнее. */
  assert.ok(!listSkills().some((skill) => skill.id === RESTRICTED), 'без роли навык считается закрытым');
});

test('каталог в промпте: строка навыка только у админа', () => {
  assert.match(skillsPromptText('admin'), new RegExp(RESTRICTED));
  assert.doesNotMatch(skillsPromptText('user'), new RegExp(RESTRICTED));
});

test('getSkill: прямой id не обходит ограничение', () => {
  assert.equal(getSkill(RESTRICTED, 'admin')?.id, RESTRICTED);
  assert.equal(getSkill(RESTRICTED, 'user'), null);
});

test('файлы рядом с навыком закрыты так же, как тело', () => {
  assert.ok(skillFiles(RESTRICTED, 'admin').includes('workflows.md'));
  assert.deepEqual(skillFiles(RESTRICTED, 'user'), []);
});

test('use_skill: пользователю отказ, админу тело и файлы', async () => {
  const denied = await executeTool('use_skill', { id: RESTRICTED }, { workspace: '.', role: 'user' });
  assert.equal(denied.meta.found, false, 'пользователю навык не открывается');
  assert.match(denied.text, /не найден/);

  const allowed = await executeTool('use_skill', { id: RESTRICTED }, { workspace: '.', role: 'admin' });
  assert.equal(allowed.meta.found, true, allowed.text.slice(0, 120));
  assert.match(allowed.text, /PM-SENIOR/);
  assert.ok(allowed.meta.files.includes('workflows.md'), 'админу видно, какие файлы лежат рядом');

  const file = await executeTool('use_skill', { id: RESTRICTED, file: 'workflows.md' }, { workspace: '.', role: 'admin' });
  assert.equal(file.meta.found, true);
  const fileDenied = await executeTool('use_skill', { id: RESTRICTED, file: 'workflows.md' }, { workspace: '.', role: 'user' });
  assert.equal(fileDenied.meta.found, false, 'файл закрытого навыка не отдаётся пользователю');
});

test('обычный навык доступен всем ролям', async () => {
  for (const role of ['admin', 'user']) {
    const answer = await executeTool('use_skill', { id: 'answer-structure' }, { workspace: '.', role });
    assert.equal(answer.meta.found, true, `навык answer-structure должен открываться роли ${role}`);
  }
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
