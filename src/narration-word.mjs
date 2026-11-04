/**
 * Word с текстом книги: один файл рядом с MP3-частями, чтобы можно было
 * прочитать или проверить то, что читает голос. Текст берётся ровно тот же,
 * что ушёл в синтез — иначе непонятно, откуда в озвучке странное слово.
 */

import fs from 'node:fs';
import path from 'node:path';
import { writeZip } from './zip.mjs';
import { trimBase } from './narration-plan.mjs';

const xmlEscape = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

function paragraphXml(text) {
  return `<w:p><w:pPr><w:spacing w:after="120"/></w:pPr><w:r><w:rPr><w:sz w:val="24"/></w:rPr><w:t xml:space="preserve">${xmlEscape(text)}</w:t></w:r></w:p>`;
}

function docxBuffer(title, paragraphs) {
  const body = [];
  if (title) {
    body.push(
      `<w:p><w:pPr><w:spacing w:after="200"/></w:pPr><w:r><w:rPr><w:b/><w:sz w:val="36"/></w:rPr><w:t xml:space="preserve">${xmlEscape(title)}</w:t></w:r></w:p>`,
    );
  }
  for (const text of paragraphs) if (String(text ?? '').trim()) body.push(paragraphXml(text));
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body.join('')}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="850" w:bottom="1134" w:left="1701"/></w:sectPr></w:body></w:document>`;
  const contentTypes =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>';
  const rels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>';
  return writeZip([
    { name: '[Content_Types].xml', data: contentTypes },
    { name: '_rels/.rels', data: rels },
    { name: 'word/document.xml', data: document },
  ]);
}

/** Текст → абзацы Word: пустая строка считается границей абзаца. */
export function paragraphsOf(text) {
  return String(text || '')
    .split(/\n{2,}/)
    .map((block) => block.replace(/\s*\n\s*/g, ' ').trim())
    .filter(Boolean);
}

/**
 * Записывает Word с полным текстом книги. Возвращает сведения о файле.
 * Абзацы ограничены разумным числом: книга-тысячник всё равно не влезет в Word
 * целиком, а обрезать молча нельзя — сообщаем, сколько попало.
 */
export function writeNarrationWord(fullPath, title, text, { maxParagraphs = 6000 } = {}) {
  const all = paragraphsOf(text);
  const paragraphs = all.slice(0, maxParagraphs);
  if (all.length > paragraphs.length) {
    paragraphs.push(`Текст сокращён для Word: показано ${paragraphs.length} абзацев из ${all.length}. Полный текст читает озвучка.`);
  }
  const buffer = docxBuffer(trimBase(title, 80), paragraphs);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, buffer);
  return { name: path.basename(fullPath), size: buffer.length, paragraphs: paragraphs.length };
}
