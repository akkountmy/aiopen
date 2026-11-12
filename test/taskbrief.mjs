/**
 * Реестры задания на сайте: проверка движка и хранения.
 *
 * Две вещи здесь важнее остальных:
 *
 *  1. Копия движка (src/taskbrief.mjs) обязана выдавать тот же вердикт, что ядро
 *     в харнессе (D:\DSHarness-0.1\plugins\dsh-task-brief\lib\brief-core.mjs).
 *     Две реализации одной проверки расходятся молча — и человек видит «на
 *     сайте зелёно», хотя работа не закрыта. Тест сверяет вердикт, покрытие и
 *     коды замечаний на одних и тех же реестрах.
 *  2. Хранилище не выпускает файл за пределы своей папки: идентификатор
 *     приходит извне (харнесс, руками), а он же становится именем файла.
 *
 * Запуск:  node --test test/taskbrief.mjs
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const HARNESS_CORE = 'D:\\DSHarness-0.1\\plugins\\dsh-task-brief\\lib\\brief-core.mjs';

/* Каталог данных уводим в temp ДО импорта config.mjs: он читает переменную на
   загрузке модуля, и позже её менять бессмысленно. */
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshow-taskbrief-'));
process.env.DSHOW_DATA_DIR = dataDir;

const core = await import(pathToFileURL(path.join(ROOT, 'src', 'taskbrief.mjs')).href);
const storeModule = await import(pathToFileURL(path.join(ROOT, 'src', 'taskbrief-store.mjs')).href);
const config = await import(pathToFileURL(path.join(ROOT, 'src', 'config.mjs')).href);

const FIXTURES = [
  {
    id: 'tb-20261110-1010-aaaa',
    title: 'Смета на дом',
    goal: 'Посчитать стоимость дома 84 м²',
    definitionOfDone: ['файл xlsx с итогом'],
    points: [
      { text: 'Посчитать объёмы', acceptance: ['итог сходится с площадью'], status: 'done', evidence: ['out/смета.xlsx'] },
      { text: 'Учесть доставку', acceptance: ['строка доставки в смете'] },
    ],
    variables: [{ name: 'Площадь', value: '84', unit: 'м²', source: 'user' }],
  },
  {
    /* Пустой реестр: тут важны ошибки, а не вердикт. */
    id: 'tb-20261110-1010-bbbb',
    title: '',
    points: [],
  },
  {
    id: 'tb-20261110-1010-cccc',
    title: 'Отчёт',
    goal: 'Собрать отчёт',
    definitionOfDone: ['pdf готов'],
    points: [
      { id: 'P1', text: 'Собрать данные', acceptance: ['таблица заполнена'], status: 'todo' },
      { id: 'P2', text: 'Сверстать', acceptance: ['pdf на 4 страницы'], status: 'dropped' },
    ],
    variables: [{ id: 'V1', name: 'Срок', value: '', status: 'open' }],
    openQuestions: ['Какой шрифт использовать'],
  },
];

test('вердикт копии движка совпадает с ядром харнесса', async (t) => {
  if (!fs.existsSync(HARNESS_CORE)) {
    t.skip('ядро харнесса недоступно на этой машине');
    return;
  }
  const native = await import(pathToFileURL(HARNESS_CORE).href);
  for (const fixture of FIXTURES) {
    const mine = core.normalizeBrief(structuredClone(fixture), { now: new Date('2026-11-10T10:00:00Z') });
    const theirs = native.normalizeBrief(structuredClone(fixture), { now: new Date('2026-11-10T10:00:00Z') });
    assert.deepEqual(mine, theirs, `нормализация разошлась на ${fixture.id}`);
    for (const finalize of [false, true]) {
      const a = core.validateBrief(mine, { finalize });
      const b = native.validateBrief(theirs, { finalize });
      assert.equal(a.verdict, b.verdict, `вердикт разошёлся на ${fixture.id}`);
      assert.deepEqual(a.coverage, b.coverage, `покрытие разошлось на ${fixture.id}`);
      assert.deepEqual(a.issues.map((issue) => issue.code), b.issues.map((issue) => issue.code));
    }
    assert.equal(core.renderBriefMarkdown(mine), native.renderBriefMarkdown(theirs));
  }
});

test('реестр сохраняется, читается и попадает в список', () => {
  const brief = core.normalizeBrief(FIXTURES[0], { now: new Date('2026-11-10T10:05:00Z') });
  const saved = storeModule.writeBrief(brief, { source: 'harness' });
  assert.equal(saved.source, 'harness');

  const file = path.join(config.TASK_BRIEF_DIR, `${brief.id}.json`);
  assert.ok(fs.existsSync(file), 'json реестра не появился');
  assert.ok(fs.existsSync(file.replace(/\.json$/, '.md')), 'человеческая копия .md не появилась');

  const detail = storeModule.briefDetail(brief.id);
  assert.equal(detail.brief.id, brief.id);
  assert.equal(detail.verdict, 'incomplete', 'два пункта, один открыт — вердикт должен быть incomplete');
  assert.deepEqual(detail.coverage, { total: 2, todo: 1, doing: 0, done: 1, blocked: 0, dropped: 0, open: 1, donePercent: 50 });
  assert.ok(detail.issues.some((issue) => issue.code === 'POINT_OPEN'));
  assert.ok(detail.markdown.includes('Покрытие пунктов'), 'в копии для человека нет таблицы покрытия');

  const listed = storeModule.listBriefs().map((item) => item.id);
  assert.ok(listed.includes(brief.id), 'реестра нет в списке');
  assert.equal(storeModule.briefDetail('tb-нет-такого'), null);
});

test('идентификатор не выводит файл за пределы папки', () => {
  const brief = core.normalizeBrief({ id: 'tb-x/../../escape', title: 'Побег', points: [{ text: 'пункт' }] });
  storeModule.writeBrief(brief);
  const files = fs.readdirSync(config.TASK_BRIEF_DIR);
  assert.ok(files.every((name) => !name.includes('..' + path.sep) && !name.includes('/')), 'имя файла с разделителем пути');
  assert.ok(!fs.existsSync(path.join(config.TASK_BRIEF_DIR, '..', 'escape.json')));
});

test('пустая постановка не даёт готового реестра', () => {
  const brief = core.normalizeBrief({ title: 'Только название' });
  const report = core.validateBrief(brief);
  assert.equal(report.verdict, 'blocked');
  assert.ok(report.issues.some((issue) => issue.code === 'NO_POINTS'));
  assert.ok(report.issues.some((issue) => issue.code === 'NO_GOAL'));
  assert.ok(report.issues.some((issue) => issue.code === 'NO_DOD'));
});

test('список сортирован по времени обновления', () => {
  const older = core.normalizeBrief({ id: 'tb-20261110-1000-old', title: 'Старый', points: [{ text: 'пункт' }] }, { now: new Date('2026-11-10T09:00:00Z') });
  const newer = core.normalizeBrief({ id: 'tb-20261110-1100-new', title: 'Новый', points: [{ text: 'пункт' }] }, { now: new Date('2026-11-10T11:00:00Z') });
  storeModule.writeBrief(older);
  storeModule.writeBrief(newer);
  const order = storeModule.listBriefs().map((item) => item.id);
  assert.ok(order.indexOf(newer.id) < order.indexOf(older.id), 'свежий реестр должен быть выше');
});

test('человеческая копия переживает перезапись реестра', () => {
  const brief = core.normalizeBrief({ id: 'tb-20261110-1200-md', title: 'Копия', goal: 'цель', definitionOfDone: ['готово'], points: [{ text: 'пункт', acceptance: ['проверено'] }] });
  storeModule.writeBrief(brief);
  const mdFile = path.join(config.TASK_BRIEF_DIR, `${brief.id}.md`);
  const first = fs.readFileSync(mdFile, 'utf8');
  const updated = core.mergeBrief(brief, { points: [{ id: brief.points[0].id, status: 'done', evidence: ['out/file.txt'] }] });
  storeModule.writeBrief(updated);
  const second = fs.readFileSync(mdFile, 'utf8');
  assert.notEqual(first, second, 'копия .md не обновилась');
  assert.ok(second.includes('out/file.txt'), 'в новой копии нет доказательства');
});
