import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.mjs';

/* Распознанный текст вложений и раньше лежал целиком в index.json — до 200 000
   знаков на файл. Индекс от этого раздувался: каждый показ списка чатов означал
   разбор десятков мегабайт JSON, а запись — перезапись всего файла.

   Теперь крупный текст живёт отдельным файлом в data/attach/<id>.txt, а в
   индексе остаются первые 2 000 знаков (для списка файлов и подсказки) и путь.
   Мелкий текст остаётся как был: гонять 300 знаков через файл бессмысленно.
   Совместимость полная: старые записи без textFile читаются напрямую. */

const INLINE_LIMIT = 20000;
const PREVIEW_CHARS = 2000;

function textFile(full) {
  return path.join(DATA_DIR, String(full));
}

/** Раскладывает текст вложения по месту хранения. Возвращает патч для записи. */
export function storeAttachText(id, rawText) {
  const body = String(rawText ?? '');
  if (body.length <= INLINE_LIMIT) return { text: body };
  try {
    fs.mkdirSync(path.join(DATA_DIR, 'attach'), { recursive: true });
    const rel = `attach/${String(id).replace(/[^\w.-]/g, '_')}.txt`;
    fs.writeFileSync(textFile(rel), body, 'utf8');
    return { text: body.slice(0, PREVIEW_CHARS), textFile: rel, textChars: body.length };
  } catch {
    /* Диск не дал записать — честнее сохранить текст в индексе, чем потерять
       разбор документа целиком. */
    return { text: body };
  }
}

/** Полный текст вложения (или то, что осталось от него). */
export function attachText(att, limit = 200000) {
  if (!att) return '';
  if (att.textFile) {
    try {
      const body = fs.readFileSync(textFile(att.textFile), 'utf8');
      return body.length > limit ? body.slice(0, limit) : body;
    } catch {
      /* Файл потерян (ручная чистка, перенос) — отдаём хотя бы превью. */
    }
  }
  const inline = String(att.text ?? '');
  return inline.length > limit ? inline.slice(0, limit) : inline;
}

/** Удаляет файл с текстом вместе с записью о вложении. */
export function dropAttachText(att) {
  if (!att?.textFile) return;
  try {
    fs.rmSync(textFile(att.textFile), { force: true });
  } catch {
    /* Файла уже нет — это нормально. */
  }
}
