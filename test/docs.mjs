/**
 * Тесты документов: профессиональные сборщики (docx, exceljs, pptxgenjs, pdfkit)
 * и откат на прежние сборщики, когда библиотеки недоступны.
 * Запуск: node test/docs.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-docs-'));
process.env.DSH_DATA_DIR = tmpRoot;

const { TOOL_DEFS, executeTool } = await import('../src/tools.mjs');
const { docEngines, docIssues } = await import('../src/doc/index.mjs');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const ctx = { workspace: path.join(tmpRoot, 'project') };
fs.mkdirSync(ctx.workspace, { recursive: true });

const read = (rel) => fs.readFileSync(path.join(ctx.workspace, rel));
const zipNames = async (buffer) => new Set(Object.keys((await JSZip.loadAsync(buffer)).files));
const zipText = async (buffer, name) => {
  const entry = (await JSZip.loadAsync(buffer)).file(name);
  if (!entry) throw new Error(`в файле нет части ${name}`);
  return entry.async('string');
};

test('движки документов доступны в этом окружении', async () => {
  const engines = await docEngines();
  assert.equal(engines.docx, 'docx-pro');
  assert.equal(engines.xlsx, 'exceljs-pro');
  assert.equal(engines.pptx, 'pptxgenjs');
  assert.equal(engines.pdf, 'pdfkit-pro');
  assert.deepEqual(docIssues(), []);
});

test('описания инструментов содержат новые поля', () => {
  const find = (name) => TOOL_DEFS.find((tool) => tool.function.name === name);
  const excel = find('create_excel');
  const word = find('create_word');
  const pptx = find('create_pptx');
  assert.ok(excel && word && pptx, 'нужны create_excel, create_word, create_pptx');
  const excelProps = excel.function.parameters.properties.sheets.items.properties;
  for (const key of ['columns', 'chart', 'totalRow', 'conditional', 'numFmt']) assert.ok(excelProps[key] || excelProps.columns.items.properties[key], `нет поля ${key} в create_excel`);
  const wordSection = word.function.parameters.properties.sections.items.properties;
  for (const key of ['kpi', 'table', 'subsections', 'note']) assert.ok(wordSection[key], `нет поля ${key} в create_word`);
  for (const key of ['chart', 'charts', 'image', 'images']) assert.ok(wordSection[key], `нет поля ${key} в create_word`);
  assert.deepEqual(wordSection.chart.properties.type.enum, ['column', 'bar', 'line', 'pie', 'doughnut', 'area']);
  assert.deepEqual(wordSection.image.properties.path.type, 'string');
  assert.ok(word.function.parameters.properties.image, 'нет картинки верхнего уровня в create_word');
  const pdf = find('create_pdf');
  assert.ok(pdf.function.parameters.properties.slides.items.properties.chart, 'в create_pdf нет диаграмм');
  assert.ok(pptx.function.parameters.properties.slides.items.properties.chart, 'в create_pptx нет диаграмм');
});

test('Word: обложка, разделы, KPI, таблица, колонтитулы', async () => {
  const result = await executeTool(
    'create_word',
    {
      path: 'Отчёт.docx',
      title: 'Отчёт за III квартал',
      kicker: 'Финансовый блок',
      subtitle: 'Рост выручки и маржи',
      cover: true,
      toc: true,
      author: 'Финансовый блок',
      date: '12 октября 2026',
      sections: [
        {
          heading: 'Резюме',
          kpi: [
            { value: '184,6 млн ₽', label: 'Выручка' },
            { value: '+18,4%', label: 'К Q3 2025' },
          ],
          paragraphs: ['Выручка выросла на 18,4% год к году.'],
          bullets: ['Пакетные тарифы подняли средний чек на 12%.', 'Онбординг сократился с 9 до 4 дней.'],
          table: { headers: ['Направление', 'Q3 2025', 'Q3 2026', 'Изм.'], rows: [['B2B', '86,4', '104,2', '+20,6%'], ['Итого', '155,9', '184,6', '+18,4%']], totalRow: true },
          note: 'Источник: управленческая отчётность.',
        },
      ],
    },
    ctx,
  );
  assert.equal(result.meta.engine, 'docx-pro');
  const buffer = read('Отчёт.docx');
  assert.ok(buffer.length > 8000, 'файл слишком маленький');
  const parts = await zipNames(buffer);
  assert.ok(parts.has('word/document.xml'));
  assert.ok(parts.has('word/footer1.xml'), 'нет колонтитула с номерами страниц');
  const xml = await zipText(buffer, 'word/document.xml');
  assert.match(xml, /184,6 млн ₽/);
  assert.match(xml, /Резюме/);
  assert.match(xml, /TOC/, 'оглавление не добавлено');
  const footer = await zipText(buffer, 'word/footer1.xml');
  assert.match(footer, /PAGE/, 'в нижнем колонтитуле нет номера страницы');
});

test('Word: настоящая диаграмма и картинка', async () => {
  fs.copyFileSync(new URL('../public/icons/icon-192.png', import.meta.url), path.join(ctx.workspace, 'logo.png'));
  const result = await executeTool(
    'create_word',
    {
      path: 'Медиа.docx',
      title: 'Отчёт с диаграммой',
      sections: [
        {
          heading: 'Динамика',
          paragraphs: ['Выручка растёт третий квартал подряд.'],
          chart: {
            type: 'column',
            title: 'Выручка по кварталам',
            categories: ['Q1', 'Q2', 'Q3'],
            series: [
              { name: '2025', values: [10, 12, 14] },
              { name: '2026', values: [12, 15, 18] },
            ],
          },
          /* Вторая диаграмма идёт массивом: у каждой свой rId и своя часть. */
          charts: [
            {
              type: 'pie',
              title: 'Доли каналов',
              categories: ['B2B', 'Розница', 'Партнёры'],
              series: [{ name: 'Доля', values: [56, 30, 14] }],
            },
          ],
        },
        { heading: 'Схема', images: [{ path: 'logo.png', caption: 'Логотип проекта' }] },
      ],
    },
    ctx,
  );
  assert.equal(result.meta.engine, 'docx-pro');
  assert.equal(result.meta.check.ok, true, `проверка файла не прошла: ${result.text}`);
  const buffer = read('Медиа.docx');
  const parts = await zipNames(buffer);
  assert.ok(parts.has('word/charts/chart1.xml'), 'нет части диаграммы');
  assert.ok(parts.has('word/charts/chart2.xml'), 'вторая диаграмма потерялась');
  assert.ok(parts.has('word/embeddings/chart2.xlsx'), 'у второй диаграммы нет книги данных');
  assert.ok(parts.has('word/charts/_rels/chart1.xml.rels'), 'нет связей диаграммы');
  assert.ok(parts.has('word/embeddings/chart1.xlsx'), 'нет книги данных диаграммы');
  assert.ok([...parts].some((name) => /^word\/media\//.test(name)), 'нет файла картинки');

  const xml = await zipText(buffer, 'word/document.xml');
  assert.ok(!xml.includes('[[CHART:'), 'маркер диаграммы не заменён на объект');
  assert.match(xml, /<c:chart\b/, 'в тексте нет объекта-диаграммы');
  assert.match(xml, /<a:blip r:embed="rId\d+"/, 'в тексте нет картинки');
  assert.match(xml, /Логотип проекта/, 'нет подписи под картинкой');

  const chart = await zipText(buffer, 'word/charts/chart1.xml');
  assert.match(chart, /^<\?xml/);
  assert.match(chart, /c:externalData/, 'диаграмма без ссылки на книгу данных');
  assert.match(chart, /<c:barChart>/, 'тип диаграммы не столбцы');
  const pie = await zipText(buffer, 'word/charts/chart2.xml');
  assert.match(pie, /<c:pieChart>/, 'вторая диаграмма не круговая');

  const types = await zipText(buffer, '[Content_Types].xml');
  assert.match(types, /drawingml\.chart\+xml/, 'нет типа содержимого для диаграммы');
  assert.match(types, /spreadsheetml\.sheet/, 'нет типа содержимого для книги данных');
  const rels = await zipText(buffer, 'word/_rels/document.xml.rels');
  assert.match(rels, /relationships\/chart/, 'нет связи документа с диаграммой');

  assert.match(result.text, /диаграмм: 2/);
  assert.match(result.text, /картинок: 1/);

  /* Книга данных должна читаться офисным движком, иначе «Изменить данные» сломано. */
  const ExcelJS = (await import('exceljs')).default;
  const workbook = new ExcelJS.Workbook();
  const embedded = await (await JSZip.loadAsync(buffer)).file('word/embeddings/chart1.xlsx').async('nodebuffer');
  await workbook.xlsx.load(embedded);
  const sheet = workbook.worksheets[0];
  assert.equal(sheet.getRow(1).getCell(2).value, '2025');
  assert.equal(sheet.getRow(4).getCell(3).value, 18);
});

test('Word: битая картинка даёт понятную ошибку, а не пустой файл', async () => {
  await assert.rejects(
    () => executeTool('create_word', { path: 'Нет.docx', sections: [{ heading: 'Раздел', image: { path: 'нет-такой.png' } }] }, ctx),
    /не найден/,
  );
  fs.writeFileSync(path.join(ctx.workspace, 'note.txt'), 'это не картинка');
  await assert.rejects(
    () => executeTool('create_word', { path: 'Нет2.docx', sections: [{ heading: 'Раздел', image: { path: 'note.txt' } }] }, ctx),
    /PNG, JPEG/,
  );
});

test('Excel: шапка, форматы, формулы, итог, диаграмма', async () => {
  const result = await executeTool(
    'create_excel',
    {
      path: 'Отчёт.xlsx',
      sheets: [
        {
          name: 'Выручка',
          title: 'Выручка по направлениям, млн ₽',
          columns: [
            { header: 'Направление', width: 28 },
            { header: 'Q3 2025', numeric: true, numFmt: '#,##0.0' },
            { header: 'Q3 2026', numeric: true, numFmt: '#,##0.0' },
            { header: 'Изм., %', numeric: true, numFmt: '0,0%' },
          ],
          rows: [['B2B', 86.4, 104.2, '=C2/B2-1'], ['Розница', 52.1, 61.3, '=C3/B3-1'], ['Итого', 155.9, 184.6, '=C4/B4-1']],
          totalRow: true,
          conditional: [{ range: 'D2:D3' }],
          chart: { type: 'column', title: 'Выручка по направлениям', categoriesColumn: 1, valueColumns: [2, 3], position: 'F2' },
        },
      ],
    },
    ctx,
  );
  assert.equal(result.meta.engine, 'xlsx-pro');
  const buffer = read('Отчёт.xlsx');
  assert.ok(buffer.length > 5000);
  const parts = await zipNames(buffer);
  assert.ok(parts.has('xl/charts/chart1.xml'), 'нет части диаграммы');
  assert.ok(parts.has('xl/drawings/drawing1.xml'), 'нет drawing-части');
  const xml = await zipText(buffer, 'xl/worksheets/sheet1.xml');
  assert.match(xml, /<f>C2\/B2-1<\/f>/, 'формула не попала в файл');
  const chartXml = await zipText(buffer, 'xl/charts/chart1.xml');
  assert.match(chartXml, /barChart/, 'диаграмма не столбчатая');
  assert.match(chartXml, /barDir val="col"/, 'столбцы должны идти вертикально');
  assert.doesNotMatch(chartXml, /columnChart/, 'columnChart недопустим в OOXML');
});

test('PowerPoint: слайды, диаграмма, таблица, заметки', async () => {
  const result = await executeTool(
    'create_pptx',
    {
      path: 'Презентация.pptx',
      title: 'Рост выручки на 18% за квартал',
      subtitle: 'Итоги III квартала и план на IV',
      kicker: 'Совет директоров',
      footerText: 'Внутренняя презентация',
      slides: [
        { layout: 'section', kicker: 'Итоги', title: 'Выручка растёт третий квартал подряд' },
        {
          layout: 'visual',
          kicker: 'Итоги',
          title: 'Выручка растёт третий квартал подряд',
          bullets: ['Пакетные тарифы подняли средний чек на 12%.'],
          chart: { type: 'column', title: 'Выручка по направлениям, млн ₽', categories: ['B2B', 'Розница', 'Партнёры'], series: [{ name: 'Q3 2025', values: [86.4, 52.1, 17.4] }, { name: 'Q3 2026', values: [104.2, 61.3, 20.1] }] },
          note: 'Акцент на B2B — половина прироста.',
        },
        { title: 'Структура выручки', table: { headers: ['Направление', 'Q3 2025', 'Q3 2026', 'Изм.'], rows: [['B2B', '86,4', '104,2', '+20,6%'], ['Розница', '52,1', '61,3', '+17,7%'], ['Итого', '155,9', '184,6', '+18,4%']] } },
      ],
    },
    ctx,
  );
  assert.equal(result.meta.engine, 'pptxgenjs');
  assert.equal(result.meta.slides, 4);
  const buffer = read('Презентация.pptx');
  const parts = await zipNames(buffer);
  assert.ok(parts.has('ppt/charts/chart1.xml'), 'нет диаграммы PowerPoint');
  const slides = [...parts].filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name));
  assert.equal(slides.length, 4, `ожидалось 4 слайда, получено ${slides.length}`);
  assert.ok(parts.has('ppt/notesSlides/notesSlide1.xml'), 'нет заметок докладчика');
});

test('PDF-документ: A4, обложка, KPI, таблица', async () => {
  const result = await executeTool(
    'create_pdf',
    {
      path: 'Отчёт.pdf',
      layout: 'document',
      cover: true,
      title: 'Отчёт за III квартал',
      kicker: 'Совет директоров',
      subtitle: 'Итоги III квартала и план на IV',
      sections: [
        { heading: 'Резюме', kpi: [{ value: '184,6 млн ₽', label: 'Выручка' }, { value: '+18,4%', label: 'К Q3 2025' }], paragraphs: ['Выручка выросла на 18,4% год к году.'], bullets: ['Пакетные тарифы подняли средний чек на 12%.'] },
        { heading: 'Структура выручки', table: { headers: ['Направление', 'Q3 2025', 'Q3 2026', 'Изм.'], rows: [['B2B', '86,4', '104,2', '+20,6%'], ['Итого', '155,9', '184,6', '+18,4%']] } },
      ],
    },
    ctx,
  );
  assert.equal(result.meta.engine, 'pdfkit');
  assert.equal(result.meta.layout, 'document');
  const buffer = read('Отчёт.pdf');
  assert.equal(buffer.subarray(0, 5).toString('latin1'), '%PDF-');
  assert.ok(result.meta.pages >= 2, 'нужна обложка и страница с содержимым');
  assert.match(buffer.toString('latin1'), /\/MediaBox \[0 0 59[0-9]\.?\d* 84[0-9]\.?\d*\]/);
});

test('PDF-презентация: 16:9 и KPI-строка', async () => {
  const result = await executeTool(
    'create_pdf',
    { path: 'Презентация.pdf', layout: 'slides', cover: true, title: 'Рост выручки', slides: [{ kicker: 'Итоги', title: 'Выручка растёт', bullets: ['Средний чек +12%.'], kpi: [{ value: '184,6 млн ₽', label: 'Выручка' }] }] },
    ctx,
  );
  assert.equal(result.meta.layout, 'slides');
  assert.ok(result.meta.pages >= 2);
  const buffer = read('Презентация.pdf');
  assert.match(buffer.toString('latin1'), /\/MediaBox \[0 0 95[0-9.]+ 540\]/);
});

test('ошибки: неверное расширение и выход из проекта', async () => {
  await assert.rejects(() => executeTool('create_word', { path: 'файл.xlsx', paragraphs: ['x'] }, ctx), /\.docx/);
  await assert.rejects(() => executeTool('create_pptx', { path: '../escape.pptx', slides: [{ title: 'x' }] }, ctx), /пределы/);
  await assert.rejects(() => executeTool('create_pdf', { path: 'пусто.pdf', sections: [] }, ctx), /раздел|абзац/);
});

test('стандарты подключаются к просьбе: финансы, данные, аудит, план, ресёрч', async () => {
  const { expertBlocks, systemPrompt } = await import('../src/prompt.mjs');
  const ids = (question) => expertBlocks(question).map((block) => block.id);
  assert.deepEqual(ids('обычный вопрос про погоду'), [], 'для нейтрального вопроса экспертные блоки не нужны');
  assert.deepEqual(ids('построй финмодель на 3 года'), ['finance']);
  assert.deepEqual(ids('напиши PRD для мобильного приложения'), ['product']);
  assert.deepEqual(ids('сделай лендинг для студии дизайна'), ['design']);
  assert.deepEqual(ids('нарисуй блок-схему процесса согласования'), ['diagram']);
  assert.deepEqual(ids('проанализируй выгрузку продаж за год'), ['data']);
  assert.deepEqual(ids('составь бизнес-план кофейни на 3 года'), ['plan']);
  assert.deepEqual(ids('проведи ресёрч рынка лизинга в Казахстане'), ['research']);
  assert.ok(ids('проведи аудит финансовой отчётности').includes('audit'), 'просьба про аудит включает блок аудита');
  assert.ok(!ids('посчитай юнит-экономику').includes('plan'), 'метрики не дублируют блок бизнес-плана');
  assert.ok(ids('финмодель и бэклог продукта').length <= 2, 'не больше двух экспертных блоков');
  const audit = systemPrompt({ projectName: 'П', memory: '', userName: '', question: 'проведи аудит финансовой отчётности' });
  assert.match(audit, /существенност/i, 'блок аудита доехал до системного промпта');

  const plain = systemPrompt({ projectName: 'П', memory: '', userName: '', question: 'привет' });
  assert.match(plain, /Стандарты деловых документов/);
  assert.doesNotMatch(plain, /ФИНАНСОВЫЙ АНАЛИЗ/);
  const finance = systemPrompt({ projectName: 'П', memory: '', userName: '', question: 'посчитай юнит-экономику' });
  assert.match(finance, /ЛИСТ «Допущения»|лист «Допущения»/i);
  assert.ok(finance.length < 12000, `промпт слишком большой: ${finance.length}`);
  assert.ok(finance.length > plain.length);
});

test('откат на прежние сборщики без про-библиотек', async () => {
  process.env.DSH_DOC_LEGACY_ONLY = '1';
  const { makePdf, makeWord } = await import(`../src/doc/index.mjs?legacy=${Date.now()}`);
  const word = await makeWord({ title: 'Т', paragraphs: ['Абзац'], bullets: ['Пункт'] }, () => Buffer.from('legacy-docx'));
  assert.equal(word.engine, 'docx-legacy');
  const pdf = await makePdf({ title: 'Док', sections: [{ heading: 'A', paragraphs: ['b'] }] }, { document: () => Buffer.from('%PDF-legacy') });
  assert.equal(pdf.engine, 'pdf-legacy');
  delete process.env.DSH_DOC_LEGACY_ONLY;
});

let failed = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    console.log(`ok — ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL — ${name}`);
    console.error(`   ${error?.message || error}`);
  }
}
fs.rmSync(tmpRoot, { recursive: true, force: true });
console.log(failed ? `\n${failed} из ${tests.length} тестов не прошли` : `\nвсе ${tests.length} тестов прошли`);
process.exit(failed ? 1 : 0);
