/**
 * Диспетчер документов: сначала профессиональный движок, при его отсутствии —
 * прежний ручной сборщик. Сервис не должен падать из-за необязательной библиотеки,
 * поэтому любая ошибка «про»-движка логируется и приводит к откату на запасной.
 */
import { createDocumentPdf, createPresentationPdf } from '../pdf.mjs';
import { toList } from './theme.mjs';

const CACHE = new Map();
const ISSUES = [];

const moduleFlavour = { docx: 'docx', xlsx: 'exceljs', pptx: 'pptxgenjs', pdf: 'pdfkit' };

/** Есть ли библиотека в образе. Проверка кэшируется после первого вызова. */
export async function hasLibrary(kind) {
  if (CACHE.has(kind)) return CACHE.get(kind);
  // Отладочный тумблер: позволяет проверить запасной путь, не удаляя зависимости.
  if (process.env.DSH_DOC_LEGACY_ONLY === '1') {
    CACHE.set(kind, false);
    return false;
  }
  const name = moduleFlavour[kind];
  let ok = false;
  if (name) {
    try {
      await import(name);
      ok = true;
    } catch (error) {
      ok = false;
      recordIssue(kind, `библиотека ${name} недоступна: ${error?.message || error}`);
    }
  }
  CACHE.set(kind, ok);
  return ok;
}

function recordIssue(kind, message) {
  ISSUES.push({ kind, message: String(message).slice(0, 400), at: new Date().toISOString() });
  if (ISSUES.length > 20) ISSUES.shift();
  if (process.env.DSH_DOC_DEBUG) console.error(`[doc] ${kind}: ${message}`);
}

/** Сводка доступных движков — для /api/health и подсказок модели. */
export async function docEngines() {
  const [docx, xlsx, pptx, pdf] = await Promise.all([hasLibrary('docx'), hasLibrary('xlsx'), hasLibrary('pptx'), hasLibrary('pdf')]);
  return {
    docx: docx ? 'docx-pro' : 'docx-legacy',
    xlsx: xlsx ? 'exceljs-pro' : 'xlsx-legacy',
    pptx: pptx ? 'pptxgenjs' : 'unavailable',
    pdf: pdf ? 'pdfkit-pro' : 'pdf-legacy',
  };
}

export function docIssues() {
  return ISSUES.slice(-5);
}

/* --------------------------------------------------------------- нормализация */

/** Секции «про»-спеки → плоские абзацы и списки для запасного сборщика. */
function flattenSections(spec) {
  const paragraphs = [];
  const bullets = [];
  toList(spec.paragraphs).forEach((item) => paragraphs.push(item));
  toList(spec.bullets).forEach((item) => bullets.push(item));
  for (const section of Array.isArray(spec.sections) ? spec.sections : []) {
    if (section?.heading) paragraphs.push(String(section.heading));
    toList(section?.paragraphs).forEach((item) => paragraphs.push(item));
    toList(section?.bullets).forEach((item) => bullets.push(item));
  }
  return { paragraphs, bullets };
}

function firstTable(spec) {
  if (spec.table?.headers?.length) return spec.table;
  for (const section of Array.isArray(spec.sections) ? spec.sections : []) {
    if (section?.table?.headers?.length) return section.table;
  }
  return null;
}

function legacyDocxSpec(spec) {
  const { paragraphs, bullets } = flattenSections(spec);
  return {
    title: spec.title,
    paragraphs,
    bullets,
    table: firstTable(spec),
  };
}

function legacyPdfDocumentSpec(spec) {
  const sections = Array.isArray(spec.sections) && spec.sections.length
    ? spec.sections
    : [{ heading: spec.title, paragraphs: flattenSections(spec).paragraphs, bullets: flattenSections(spec).bullets }];
  return {
    title: spec.cover === true ? spec.title : spec.title,
    subtitle: spec.subtitle,
    kicker: spec.kicker,
    sections: sections.map((section) => ({
      heading: section?.heading,
      paragraphs: toList(section?.paragraphs),
      bullets: toList(section?.bullets),
    })),
  };
}

function legacyPdfSlidesSpec(spec) {
  return {
    title: spec.title,
    subtitle: spec.subtitle,
    kicker: spec.kicker,
    cover: spec.cover !== false,
    slides: (Array.isArray(spec.slides) ? spec.slides : []).map((slide) => ({
      title: slide?.title,
      kicker: slide?.kicker,
      paragraphs: toList(slide?.paragraphs),
      bullets: toList(slide?.bullets),
      note: slide?.note,
    })),
  };
}

/* ------------------------------------------------------------------ сборка */

/**
 * Word.
 * @param {object} spec — про-спека (sections/kpi/toc/cover/table)
 * @param {(spec:object)=>Buffer} legacy — прежний buildDocx
 */
export async function makeWord(spec, legacy) {
  if (await hasLibrary('docx')) {
    try {
      const { buildDocxPro } = await import('./docx.mjs');
      const buffer = await buildDocxPro(spec);
      if (buffer?.length) return { buffer, engine: 'docx-pro' };
      recordIssue('docx', 'про-движок вернул пустой файл');
    } catch (error) {
      recordIssue('docx', error?.message || error);
    }
  }
  if (typeof legacy !== 'function') throw new Error('Word-движок недоступен');
  return { buffer: legacy(legacyDocxSpec(spec)), engine: 'docx-legacy' };
}

/** Excel: про-спека и запасная принимают одинаковый список листов. */
export async function makeWorkbook(sheets, legacy) {
  const list = Array.isArray(sheets) ? sheets.filter((sheet) => sheet && Array.isArray(sheet.rows)) : [];
  if (!list.length) throw new Error('Нужен хотя бы один лист с rows');
  if (await hasLibrary('xlsx')) {
    try {
      const { buildXlsxPro } = await import('./xlsx.mjs');
      const buffer = await buildXlsxPro({ sheets: list });
      if (buffer?.length) return { buffer, engine: 'xlsx-pro' };
      recordIssue('xlsx', 'про-движок вернул пустой файл');
    } catch (error) {
      recordIssue('xlsx', error?.message || error);
    }
  }
  if (typeof legacy !== 'function') throw new Error('Excel-движок недоступен');
  return { buffer: legacy(list.map((sheet) => ({ name: sheet.name, rows: sheet.rows }))), engine: 'xlsx-legacy' };
}

/** PowerPoint: про-движок обязателен, запасного ручного сборщика .pptx нет. */
export async function makePresentation(spec) {
  if (!(await hasLibrary('pptx'))) {
    throw new Error('Создание .pptx недоступно: библиотека pptxgenjs не установлена. Можно выдать PDF-презентацию через create_pdf с layout="slides".');
  }
  const { buildPptxPro } = await import('./pptx.mjs');
  const buffer = await buildPptxPro(spec);
  if (!buffer?.length) throw new Error('Не удалось собрать .pptx: пустой результат');
  return { buffer, engine: 'pptxgenjs' };
}

/**
 * PDF: pdfkit для обоих макетов, иначе прежний движок.
 * @param {object} spec — {layout:'document'|'slides', ...}
 * @param {{document?:Function, slides?:Function}} legacy
 */
export async function makePdf(spec, legacy = {}) {
  const isSlides = String(spec.layout || '').toLowerCase() === 'slides' || (!Array.isArray(spec.sections) && Array.isArray(spec.slides));
  if (await hasLibrary('pdf')) {
    try {
      const { buildPdfPro } = await import('./pdf.mjs');
      const buffer = await buildPdfPro({ ...spec, layout: isSlides ? 'slides' : 'document' });
      if (buffer?.length) return { buffer, engine: 'pdfkit', layout: isSlides ? 'slides' : 'document' };
      recordIssue('pdf', 'про-движок вернул пустой файл');
    } catch (error) {
      recordIssue('pdf', error?.message || error);
    }
  }
  const fallback = isSlides ? legacy.slides ?? createPresentationPdf : legacy.document ?? createDocumentPdf;
  const buffer = isSlides ? fallback(legacyPdfSlidesSpec(spec)) : fallback(legacyPdfDocumentSpec(spec));
  if (!buffer?.length) throw new Error('Не удалось собрать PDF: нет содержимого');
  return { buffer, engine: 'pdf-legacy', layout: isSlides ? 'slides' : 'document' };
}
