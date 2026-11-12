/* Проверка ранней остановки: задача не должна заканчиваться обещанием
   «сейчас соберу» при пустой папке.

   Что проверяем:
   — просьба озвучить книгу и ответ-обещание включают досборку;
   — готовый файл нужного формата снимает досборку;
   — текст вместо Word/PDF не считается готовым файлом;
   — честное «не могу» не зацикливает досборку;
   — обычный вопрос без файла и без обещания не трогается.

   Запуск: node test/premature-finish.mjs */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { needsDeliverableRepair, requestedFormats } from '../src/agent.mjs';
import { systemPrompt } from '../src/prompt.mjs';

let failures = 0;
function check(ok, title, extra = '') {
  if (!ok) failures += 1;
  console.log(`${ok ? 'OK  ' : 'FAIL'}${title}${extra ? ` — ${extra}` : ''}`);
}

function workspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dshow-premature-'));
}

const TASK =
  'Сделай выжимку книги «Теория игр. 24 лекции» Бена Полака на 40 минут и озвучь её в MP3.';

/* Продолжение не должно начинаться заново с приветствия. */
{
  const prompt = systemPrompt({
    projectName: 'Книги',
    memory: '',
    question: 'Продолжи',
    continuing: true,
    task: { goal: TASK, done: [], next: ['собрать выжимку'], files: [], facts: [], steps: 18, segments: 1 },
  });
  check(!prompt.includes('Привет! ИИ-ассистент готов'), 'в продолжении нет повторного приветствия');
  check(/не заканчивай ход обещанием/i.test(prompt), 'промпт прямо запрещает обрыв на обещании');
}

/* 1. Ровно ответ из живого диалога: обещание вместо работы. */
{
  const dir = workspace();
  const needed = needsDeliverableRepair({
    userText: TASK,
    workspace: dir,
    toolsUsed: [{ name: 'web_search', status: 'ok' }],
    answer: 'Список лекций получен, теперь соберу выжимку.',
    startedMs: Date.now() - 60_000,
  });
  check(needed === true, 'обещание «теперь соберу» при пустой папке включает досборку');
  check(requestedFormats(TASK).some((rule) => rule.id === 'audio'), 'MP3 распознан как обязательный формат');
  fs.rmSync(dir, { recursive: true, force: true });
}

/* 2. Файл уже создан — досборка не нужна. */
{
  const dir = workspace();
  const file = path.join(dir, 'Теория игр — выжимка.docx');
  fs.writeFileSync(file, 'готовый документ');
  const needed = needsDeliverableRepair({
    userText: 'Сделай выжимку книги в Word на 40 минут.',
    workspace: dir,
    toolsUsed: [],
    answer: 'Готово: «Теория игр — выжимка.docx».',
    startedMs: Date.now() - 60_000,
  });
  check(needed === false, 'созданный DOCX снимает досборку');
  fs.rmSync(dir, { recursive: true, force: true });
}

/* 3. Текст в чате не заменяет запрошенный Word. */
{
  const dir = workspace();
  const needed = needsDeliverableRepair({
    userText: 'Оформи отчёт в Word и пришли файлом.',
    workspace: dir,
    toolsUsed: [{ name: 'write_file', status: 'ok', path: 'report.md' }],
    answer: 'Вот весь текст отчёта. Файл Word не создавал.',
    startedMs: Date.now() - 60_000,
  });
  check(needed === true, 'Markdown вместо DOCX не считается готовым Word');
  fs.rmSync(dir, { recursive: true, force: true });
}

/* 4. Инструмент создания документа вызван — результат принят. */
{
  const dir = workspace();
  const needed = needsDeliverableRepair({
    userText: 'Оформи отчёт в Word.',
    workspace: dir,
    toolsUsed: [{ name: 'create_word', status: 'ok', path: 'report.docx' }],
    answer: 'Готово: report.docx.',
    startedMs: Date.now() - 60_000,
  });
  check(needed === false, 'вызов create_word снимает досборку');
  fs.rmSync(dir, { recursive: true, force: true });
}

/* 5. Честное «не могу» — не зависание. */
{
  const dir = workspace();
  const needed = needsDeliverableRepair({
    userText: 'Озвучь книгу в MP3.',
    workspace: dir,
    toolsUsed: [],
    answer: 'Не могу озвучить: синтез речи на сервисе недоступен. Текст выжимки готов, могу сохранить его в Word.',
    startedMs: Date.now() - 60_000,
  });
  check(needed === false, 'честный отказ не зацикливает досборку');
  fs.rmSync(dir, { recursive: true, force: true });
}

/* 6. Обычный вопрос без файла и обещания не трогаем. */
{
  const dir = workspace();
  const needed = needsDeliverableRepair({
    userText: 'Посмотри файлы проекта и скажи, что в них.',
    workspace: dir,
    toolsUsed: [{ name: 'list_files', status: 'ok' }],
    answer: 'В проекте два файла: смета.xlsx и план.docx.',
    startedMs: Date.now() - 60_000,
  });
  check(needed === false, 'вопрос о готовых файлах не считается задачей на файл');
  const readOnly = needsDeliverableRepair({
    userText: 'Прочитай готовый Word-документ и перескажи его.',
    workspace: dir,
    toolsUsed: [{ name: 'read_file', status: 'ok' }],
    answer: 'В документе три раздела: введение, расчёт и выводы.',
    startedMs: Date.now() - 60_000,
  });
  check(readOnly === false, 'чтение готового Word не требует создавать новый');
  const pathAsk = requestedFormats('Создай файл report.docx с выводами.');
  check(pathAsk.some((rule) => rule.id === 'word'), 'имя файла .docx не мешает распознать задачу');
  fs.rmSync(dir, { recursive: true, force: true });
}

/* 7. Короткая отписка вместо выжимки — обрыв, длинный текст — результат. */
{
  const dir = workspace();
  const short = needsDeliverableRepair({
    userText: 'Сделай выжимку этой книги.',
    workspace: dir,
    toolsUsed: [],
    answer: 'Книга интересная, сейчас соберу главное.',
    startedMs: Date.now() - 60_000,
  });
  check(short === true, 'короткая отписка вместо выжимки включает досборку');
  const long = needsDeliverableRepair({
    userText: 'Сделай выжимку этой книги.',
    workspace: dir,
    toolsUsed: [],
    answer: 'Главная мысль книги — равновесие Нэша. '.repeat(40),
    startedMs: Date.now() - 60_000,
  });
  check(long === false, 'содержательный текстовый ответ принимается');
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(failures ? `\nПровалов: ${failures}` : '\nВсё прошло');
process.exit(failures ? 1 : 0);
