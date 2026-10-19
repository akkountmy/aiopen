/**
 * Структурная проверка готовых документов.
 *
 * Смысл: инструменты create_* пишут файл и раньше молчали, даже если внутри
 * получился пустой документ, таблица без ячеек или блок, уехавший за границу
 * слайда. Теперь после записи файл разбирается обратно (zip/XML для OOXML,
 * разметка для PDF), а модели возвращается короткий отчёт: «Проверка: OK» или
 * «Проверка: замечания — …». Это дешёвая петля самопроверки без браузера.
 */
import fs from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';

/* 16:9 в English Metric Units: 13,333 x 7,5 дюйма. */
const SLIDE_W = 12192000;
const SLIDE_H = 6858000;
const TOLERANCE = 20000;

export function documentKind(file) {
  const ext = path.extname(String(file || '')).toLowerCase();
  if (ext === '.docx') return 'docx';
  if (ext === '.xlsx') return 'xlsx';
  if (ext === '.pptx') return 'pptx';
  if (ext === '.pdf') return 'pdf';
  return '';
}

function countMatches(text, regex) {
  const found = text.match(regex);
  return found ? found.length : 0;
}

async function loadZip(buffer) {
  return JSZip.loadAsync(buffer);
}

function zipNames(zip) {
  return Object.keys(zip.files);
}

async function textOf(zip, name) {
  const entry = zip.file(name);
  if (!entry) return null;
  return entry.async('string');
}

/* ------------------------------- DOCX ------------------------------- */

async function checkDocx(buffer, warnings, errors, stats) {
  const zip = await loadZip(buffer);
  const names = zipNames(zip);
  if (!names.includes('word/document.xml')) {
    errors.push('в архиве нет word/document.xml — Word такой файл не откроет');
    return;
  }
  const xml = await textOf(zip, 'word/document.xml');

  const paragraphs = countMatches(xml, /<w:p[ >]/g);
  const tables = countMatches(xml, /<w:tbl>/g);
  const sections = countMatches(xml, /<w:sectPr/g);
  const textParts = xml.match(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g) || [];
  const textLength = textParts.reduce((sum, part) => sum + part.replace(/<[^>]+>/g, '').length, 0);

  stats.paragraphs = paragraphs;
  stats.tables = tables;
  stats.textChars = textLength;

  if (paragraphs === 0) errors.push('нет ни одного абзаца');
  if (textLength < 20) errors.push('в документе почти нет текста (меньше 20 символов)');
  if (!sections) warnings.push('нет настроек страницы (w:sectPr) — поля будут по умолчанию');

  /* Пустые ячейки таблиц: визуально это «дырки» посреди отчёта. */
  let emptyCells = 0;
  for (const cell of xml.split('<w:tc>').slice(1)) {
    const body = cell.split('</w:tc>')[0] || '';
    if (!/<w:t[^>]*>[\s\S]*?\S[\s\S]*?<\/w:t>/.test(body)) emptyCells++;
  }
  if (emptyCells) {
    stats.emptyCells = emptyCells;
    warnings.push(`пустых ячеек таблиц: ${emptyCells} — заполни или убери столбец`);
  }

  /* Ссылки на части пакета (колонтитулы, картинки, нумерация) должны вести
     на реально существующие файлы, иначе Word ругается «не удаётся открыть». */
  const relsXml = (await textOf(zip, 'word/_rels/document.xml.rels')) || '';
  const broken = [];
  for (const rel of relsXml.matchAll(/Target="([^"]+)"[^>]*?(TargetMode="External")?/g)) {
    const target = rel[1];
    if (rel[2] || /^https?:/i.test(target)) continue;
    const full = path.posix.normalize(`word/${target.replace(/^\.\//, '')}`);
    if (!names.includes(full)) broken.push(target);
  }
  if (broken.length) errors.push(`битые ссылки внутри пакета: ${broken.slice(0, 5).join(', ')}`);

  /* Картинки и диаграммы: проверяем не только наличие частей, но и то,
     что объект реально вставлен в текст, иначе файл выглядит «полным»,
     а на странице пусто. */
  const images = (xml.match(/<a:blip[^>]*>/g) || []).filter((tag) => /r:embed="/.test(tag)).length;
  const chartDrawings = (xml.match(/<c:chart\s[^>]*>/g) || []).length;
  const chartParts = names.filter((name) => /^word\/charts\/chart\d+\.xml$/.test(name));
  if (images) stats.images = images;
  if (images && !names.some((name) => /^word\/media\//.test(name))) {
    errors.push('картинка вставлена, но файла изображения в пакете нет');
  }
  if (chartDrawings || chartParts.length) stats.charts = Math.max(chartDrawings, chartParts.length);
  if (chartParts.length && !chartDrawings) {
    warnings.push('части диаграмм в пакете есть, но в тексте нет ни одной — они не отобразятся');
  }
  for (const part of chartParts) {
    const number = part.match(/chart(\d+)\.xml/)[1];
    const body = (await textOf(zip, part)) || '';
    const dataRels = (await textOf(zip, `word/charts/_rels/chart${number}.xml.rels`)) || '';
    if (!/c:externalData/.test(body) || !dataRels.trim()) {
      warnings.push(`диаграмма ${number} без книги данных: в Word не работает «Изменить данные»`);
      continue;
    }
    for (const rel of dataRels.matchAll(/Target="([^"]+)"/g)) {
      const target = path.posix.normalize(`word/charts/${rel[1]}`);
      if (!names.includes(target)) errors.push(`у диаграммы ${number} нет книги данных (${rel[1]})`);
    }
  }
}

/* ------------------------------- XLSX ------------------------------- */

async function checkXlsx(buffer, warnings, errors, stats) {
  const zip = await loadZip(buffer);
  const names = zipNames(zip);
  const workbook = await textOf(zip, 'xl/workbook.xml');
  if (!workbook) {
    errors.push('в архиве нет xl/workbook.xml — Excel такой файл не откроет');
    return;
  }
  const relsXml = (await textOf(zip, 'xl/_rels/workbook.xml.rels')) || '';
  const relTargets = new Map();
  for (const rel of relsXml.matchAll(/Id="([^"]+)"[\s\S]*?Target="([^"]+)"/g)) {
    relTargets.set(rel[1], rel[2]);
  }

  const sheets = [];
  for (const sheet of workbook.matchAll(/<sheet\s[^>]*name="([^"]*)"[^>]*r:id="([^"]+)"/g)) {
    sheets.push({ name: sheet[1], rid: sheet[2] });
  }
  if (!sheets.length) {
    errors.push('в книге нет ни одного листа');
    return;
  }

  const seen = new Set();
  for (const sheet of sheets) {
    const key = sheet.name.trim().toLowerCase();
    if (seen.has(key)) warnings.push(`два листа с одинаковым именем: «${sheet.name}»`);
    seen.add(key);

    const target = relTargets.get(sheet.rid);
    if (!target) {
      errors.push(`лист «${sheet.name}» без привязки к файлу`);
      continue;
    }
    const file = path.posix.normalize(`xl/${target.replace(/^\.\//, '')}`);
    const xml = await textOf(zip, file);
    if (!xml) {
      errors.push(`файл листа «${sheet.name}» отсутствует в архиве`);
      continue;
    }
    const rows = countMatches(xml, /<row[\s>]/g);
    const cells = countMatches(xml, /<c[\s>]/g);
    const formulas = countMatches(xml, /<f[\s>]/g);
    /* Ячейка без значения и без формулы — пустая, хотя модель её «создала». */
    let emptyCells = 0;
    for (const cell of xml.matchAll(/<c\s[^>]*?(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const body = cell[1] || '';
      if (!/<v[\s>]/.test(body) && !/<f[\s>]/.test(body) && !/t="(?:inlineStr|s)"/.test(cell[0])) emptyCells++;
    }
    stats.sheets = stats.sheets || [];
    stats.sheets.push({ name: sheet.name, rows, cells, formulas, emptyCells });
    if (rows === 0) warnings.push(`лист «${sheet.name}» пустой`);
    if (emptyCells > Math.max(3, cells * 0.2)) {
      warnings.push(`лист «${sheet.name}»: пустых ячеек ${emptyCells} из ${cells}`);
    }
  }
  const charts = names.filter((name) => /^xl\/charts\/chart\d+\.xml$/.test(name)).length;
  if (charts) stats.charts = charts;
  if (stats.sheets.every((sheet) => sheet.rows === 0)) errors.push('все листы книги пустые');
}

/* ------------------------------- PPTX ------------------------------- */

async function checkPptx(buffer, warnings, errors, stats) {
  const zip = await loadZip(buffer);
  const names = zipNames(zip);
  const presentation = await textOf(zip, 'ppt/presentation.xml');
  if (!presentation) {
    errors.push('в архиве нет ppt/presentation.xml — PowerPoint такой файл не откроет');
    return;
  }
  const declared = countMatches(presentation, /<p:sldId[\s>]/g);
  const files = names.filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name));
  stats.slides = Math.max(declared, files.length);
  if (!declared) errors.push('в презентации нет ни одного слайда');
  if (declared !== files.length) {
    errors.push(`слайдов объявлено ${declared}, файлов слайдов ${files.length} — пакет несогласован`);
  }

  const emptySlides = [];
  const overflow = [];
  for (const file of files) {
    const xml = await textOf(zip, file);
    const index = Number((/slide(\d+)\.xml$/.exec(file) || [])[1] || 0);
    const textParts = xml.match(/<a:t>([\s\S]*?)<\/a:t>/g) || [];
    const textLength = textParts.reduce((sum, part) => sum + part.replace(/<[^>]+>/g, '').length, 0);
    if (textLength < 3) emptySlides.push(index);

    for (const shape of xml.split('<p:sp>').slice(1)) {
      const off = /<a:off x="(-?\d+)" y="(-?\d+)"/.exec(shape);
      const ext = /<a:ext cx="(\d+)" cy="(\d+)"/.exec(shape);
      if (!off || !ext) continue;
      const right = Number(off[1]) + Number(ext[1]);
      const bottom = Number(off[2]) + Number(ext[2]);
      if (right > SLIDE_W + TOLERANCE || bottom > SLIDE_H + TOLERANCE || Number(off[1]) < -TOLERANCE) {
        overflow.push(index);
        break;
      }
    }
  }
  if (emptySlides.length) errors.push(`слайды без текста: ${emptySlides.slice(0, 10).join(', ')}`);
  if (overflow.length) {
    stats.overflowSlides = overflow.length;
    warnings.push(`блоки выходят за границы слайда: ${overflow.slice(0, 10).join(', ')}`);
  }
}

/* -------------------------------- PDF -------------------------------- */

function checkPdf(buffer, warnings, errors, stats) {
  const text = buffer.toString('latin1');
  if (!text.startsWith('%PDF-')) errors.push('файл не начинается с %PDF — это не PDF');
  if (!/%%EOF\s*$/.test(text.trimEnd().slice(-2048))) warnings.push('нет маркера %%EOF в конце файла');
  const pages = countMatches(text, /\/Type\s*\/Page(?![s])/g);
  const fonts = countMatches(text, /\/BaseFont/g);
  /* Содержимое страниц pdfkit сжимает потоком, поэтому искать текстовые
     операторы в теле файла бессмысленно: проверяем страницы и шрифты. */
  const streams = countMatches(text, /\bstream\r?\n/g);
  stats.pages = pages;
  stats.fonts = fonts;
  stats.streams = streams;
  if (!pages) errors.push('в PDF нет страниц');
  if (!fonts) errors.push('в PDF нет встроенных шрифтов — текст не отобразится');
  if (pages && !streams) warnings.push('нет потоков содержимого — страницы могут быть пустыми');
  if (buffer.length < 1200) warnings.push('файл подозрительно маленький');
}

/**
 * Проверить готовый файл.
 * @param {string} fullPath абсолютный путь к файлу
 * @returns {Promise<{kind: string, ok: boolean, errors: string[], warnings: string[], stats: object}>}
 */
export async function checkDocument(fullPath) {
  const kind = documentKind(fullPath);
  const errors = [];
  const warnings = [];
  const stats = {};
  if (!kind) {
    return { kind: '', ok: true, errors: [], warnings: ['проверка структур не поддерживается'], stats };
  }
  if (!fs.existsSync(fullPath)) {
    return { kind, ok: false, errors: ['файл не создан'], warnings: [], stats };
  }
  const buffer = fs.readFileSync(fullPath);
  stats.bytes = buffer.length;
  try {
    if (kind === 'docx') await checkDocx(buffer, warnings, errors, stats);
    else if (kind === 'xlsx') await checkXlsx(buffer, warnings, errors, stats);
    else if (kind === 'pptx') await checkPptx(buffer, warnings, errors, stats);
    else checkPdf(buffer, warnings, errors, stats);
  } catch (error) {
    errors.push(`не удалось разобрать файл: ${error.message}`);
  }
  return { kind, ok: errors.length === 0, errors, warnings, stats };
}

/** Короткий отчёт для модели: что проверили и что исправить. */
export function formatCheckReport(check) {
  if (!check) return '';
  const parts = [];
  if (check.errors.length) {
    parts.push(`Проверка файла: ОШИБКИ — ${check.errors.join('; ')}`);
    parts.push('Файл в таком виде пользователю отдавать нельзя: пересоздай его через соответствующий create_* и проверь снова.');
  } else if (check.warnings.length) {
    parts.push(`Проверка файла: замечания — ${check.warnings.join('; ')}`);
  } else {
    const detail = [];
    if (check.stats.sheets) detail.push(`листов ${check.stats.sheets.length}, строк ${check.stats.sheets.reduce((sum, s) => sum + s.rows, 0)}`);
    if (check.stats.tables) detail.push(`таблиц ${check.stats.tables}`);
    if (check.stats.paragraphs) detail.push(`абзацев ${check.stats.paragraphs}`);
    if (check.stats.slides) detail.push(`слайдов ${check.stats.slides}`);
    if (check.stats.pages) detail.push(`страниц ${check.stats.pages}`);
    if (check.stats.charts) detail.push(`диаграмм ${check.stats.charts}`);
    if (check.stats.images) detail.push(`картинок ${check.stats.images}`);
    parts.push(`Проверка файла: OK${detail.length ? ` (${detail.join(', ')})` : ''}`);
  }
  return parts.join('\n');
}
