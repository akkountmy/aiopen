/**
 * Проверка create_pdf: настоящий PDF, кириллица в тексте, безопасные пути,
 * презентация ровно по числу слайдов и документ A4.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TOOL_DEFS, executeTool } from '../src/tools.mjs';

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'dshow-pdf-'));
const ctx = { workspace };

const deckArgs = {
  path: 'Презентация.pdf',
  layout: 'slides',
  title: 'Психологическая сессия',
  subtitle: '60 минут внимания к себе',
  slides: [
    { title: 'Что вы получаете', bullets: ['Час разговора без спешки и оценок.', 'Практические опоры на каждый день.'] },
    { title: 'Сколько стоит', bullets: ['Сессия 60 минут — 5 000 ₽.', 'Пакет из четырёх встреч — 18 000 ₽.'] },
  ],
};

const docArgs = {
  path: 'docs/Описание.pdf',
  layout: 'document',
  title: 'Психологическая сессия',
  subtitle: 'Описание услуги',
  sections: [
    { heading: 'Кому подойдёт', paragraphs: ['Тем, кто хочет разобраться в ситуации.'], bullets: ['Тревога', 'Решение'] },
  ],
};

test('create_pdf объявлен в TOOL_DEFS с нужными параметрами', () => {
  const def = TOOL_DEFS.find((tool) => tool.function.name === 'create_pdf');
  assert.ok(def, 'инструмент create_pdf отсутствует');
  assert.ok(def.function.parameters.properties.slides);
  assert.ok(def.function.parameters.properties.sections);
});

test('презентация: одна страница на слайд, кириллица внутри', async () => {
  const result = await executeTool('create_pdf', deckArgs, ctx);
  const file = path.join(workspace, deckArgs.path);
  const buf = fs.readFileSync(file);
  assert.equal(buf.subarray(0, 5).toString('latin1'), '%PDF-');
  assert.match(buf.toString('latin1'), /\/Type \/Page(?!s)/);
  assert.equal(result.meta.pages, 2, `ожидали 2 страницы, получили ${result.meta.pages}`);
  assert.match(buf.toString('latin1'), /\/Type \/Font/);
  assert.match(result.text, /Презентация\.pdf/);
});

test('документ A4: вложенный путь создаётся', async () => {
  const result = await executeTool('create_pdf', docArgs, ctx);
  const file = path.join(workspace, docArgs.path);
  assert.ok(fs.existsSync(file));
  assert.equal(result.meta.pages, 1);
});

test('обложка добавляет страницу', async () => {
  const result = await executeTool('create_pdf', { ...deckArgs, path: 'С обложкой.pdf', cover: true }, ctx);
  assert.equal(result.meta.pages, 3);
});

test('расширение обязательное и путь не выходит из проекта', async () => {
  await assert.rejects(() => executeTool('create_pdf', { ...deckArgs, path: 'Слайды.txt' }, ctx), /\.pdf/);
  await assert.rejects(() => executeTool('create_pdf', { ...deckArgs, path: '../escape.pdf' }, ctx), /за пределы/);
});

test.after(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});
