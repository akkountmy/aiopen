/**
 * Проверка структурированного просмотра документов (src/docpreview.mjs).
 *
 * Раньше все документы показывались одним плоским текстом: заголовки, списки и
 * таблицы сливались в кашу, и читать было нельзя. Теперь сервер отдаёт модель
 * документа (блоки, листы, слайды), а окно просмотра рисует её разметкой.
 * Тест держит контракт этой модели: типы блоков, ширину таблиц, порядок листов
 * и пределы, за которыми просмотр честно предупреждает о сокращении.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, AlignmentType } from 'docx';
import ExcelJS from 'exceljs';
import PptxGenJS from 'pptxgenjs';
import { previewDocument } from '../src/docpreview.mjs';

function runsText(runs) {
  return (runs || []).map((run) => run.text).join('');
}

test('DOCX: заголовки, абзацы, списки и таблица приходят блоками', async () => {
  const doc = new Document({
    numbering: { config: [{ reference: 'num1', levels: [{ level: 0, format: 'decimal', text: '%1.' }] }] },
    sections: [
      {
        children: [
          new Paragraph({ text: 'Отчёт о продаже', heading: HeadingLevel.HEADING_1 }),
          new Paragraph({
            alignment: AlignmentType.JUSTIFIED,
            children: [
              new TextRun({ text: 'Продано ' }),
              new TextRun({ text: '12 автомобилей', bold: true }),
              new TextRun({ text: ' за март.', italics: true }),
            ],
          }),
          new Paragraph({ text: 'Итоги по моделям', heading: HeadingLevel.HEADING_2 }),
          new Paragraph({ text: 'Первая позиция', numbering: { reference: 'num1', level: 0 } }),
          new Paragraph({ text: 'Вторая позиция', numbering: { reference: 'num1', level: 0 } }),
          new Table({
            rows: [
              new TableRow({ children: [new TableCell({ children: [new Paragraph('Модель')] }), new TableCell({ children: [new Paragraph('Штук')] })] }),
              new TableRow({ children: [new TableCell({ children: [new Paragraph('Solaris')] }), new TableCell({ children: [new Paragraph('7')] })] }),
            ],
          }),
        ],
      },
    ],
  });
  const model = previewDocument(await Packer.toBuffer(doc), 'Отчёт.docx');
  assert.equal(model.format, 'docx');
  assert.deepEqual(model.blocks.map((block) => block.type), ['heading', 'para', 'heading', 'list', 'table']);

  const [title, paragraph, subtitle, list, table] = model.blocks;
  assert.equal(title.level, 1);
  assert.equal(runsText(title.runs), 'Отчёт о продаже');
  assert.equal(paragraph.align, 'justify');
  const bold = paragraph.runs.find((run) => run.text === '12 автомобилей');
  assert.ok(bold && bold.bold, 'жирный фрагмент не сохранился');
  const italics = paragraph.runs.find((run) => run.text === ' за март.');
  assert.ok(italics && italics.italic, 'курсив не сохранился');
  assert.equal(subtitle.level, 2);
  assert.equal(list.ordered, true);
  assert.deepEqual(list.items.map((item) => runsText(item.runs)), ['Первая позиция', 'Вторая позиция']);
  assert.equal(table.header, true);
  assert.equal(table.rows.length, 2);
  assert.deepEqual(title.runs[0].text, 'Отчёт о продаже');
});

test('XLSX: каждый лист отдельно, с именем, шириной и числами как текстом', async () => {
  const book = new ExcelJS.Workbook();
  const march = book.addWorksheet('Март');
  march.addRow(['Модель', 'Штук', 'Сумма']);
  march.addRow(['Solaris', 7, 1245000]);
  const april = book.addWorksheet('Апрель');
  april.addRow(['Модель', 'Штук']);
  april.addRow(['Rio', 3]);
  const model = previewDocument(Buffer.from(await book.xlsx.writeBuffer()), 'Продажи.xlsx');

  assert.equal(model.format, 'xlsx');
  assert.deepEqual(model.sheets.map((sheet) => sheet.name), ['Март', 'Апрель']);
  assert.deepEqual(model.sheets.map((sheet) => sheet.width), [3, 2]);
  assert.deepEqual(model.sheets[0].rows[1], ['Solaris', '7', '1245000']);
  assert.deepEqual(model.warnings, []);
});

test('PPTX: слайды идут по порядку, заголовок отделён от текста', async () => {
  const deck = new PptxGenJS();
  const slide = deck.addSlide();
  slide.addText('Продажи 2026', { x: 0.5, y: 0.5, w: 8, h: 1, fontSize: 28 });
  slide.addText(
    ['Первый пункт', 'Второй пункт'].map((text) => ({ text, options: { bullet: true } })),
    { x: 0.5, y: 1.8, w: 8, h: 3 },
  );
  const model = previewDocument(Buffer.from(await deck.write({ outputType: 'nodebuffer' })), 'Презентация.pptx');

  assert.equal(model.format, 'pptx');
  assert.equal(model.slides.length, 1);
  assert.equal(model.slides[0].number, 1);
  assert.equal(model.slides[0].title, 'Продажи 2026');
  assert.ok(model.slides[0].lines.some((line) => line.includes('Первый пункт')));
});

test('CSV: кавычки и запятые внутри значения не ломают строки', () => {
  const model = previewDocument(Buffer.from('Модель,Штук\nSolaris,7\n"Rio, хэтчбек",5\n'), 'Данные.csv');
  assert.equal(model.format, 'table');
  assert.equal(model.width, 2);
  assert.deepEqual(model.rows[1], ['Solaris', '7']);
  assert.deepEqual(model.rows[2], ['Rio, хэтчбек', '5']);
});

test('текстовые файлы: markdown, json, код и обычный текст', () => {
  assert.equal(previewDocument(Buffer.from('# Заголовок\n\nАбзац.\n'), 'readme.md').format, 'markdown');
  assert.equal(previewDocument(Buffer.from('{"a":1}'), 'data.json').format, 'json');
  assert.equal(previewDocument(Buffer.from('const a = 1;\n'), 'script.js').format, 'code');
  const text = previewDocument(Buffer.from('\uFEFFпросто текст'), 'notes.txt');
  assert.equal(text.format, 'text');
  assert.equal(text.text, 'просто текст');
});

test('HTML помечается как страница, а не как текст', () => {
  const model = previewDocument(Buffer.from('<!doctype html><h1>Привет</h1>'), 'лендинг.html');
  assert.equal(model.format, 'html');
  assert.equal(model.text, undefined);
});

test('незнакомый двоичный формат не выдаётся за документ', () => {
  assert.equal(previewDocument(Buffer.from('PK\u0003\u0004'), 'старый.doc'), null);
});

test('длинный файл обрезается с понятным предупреждением', () => {
  const model = previewDocument(Buffer.from('строка\n'.repeat(5000)), 'большой.txt', { maxChars: 100 });
  assert.ok(model.text.length <= 100);
  assert.match(model.warnings.join(' '), /длиннее окна просмотра/);
});
