/**
 * Чертежи и схемы в файлы: принимает SVG или HTML, отдаёт PDF по формату листа
 * и/или PNG. Вёрстка своя и предсказуемая: один лист — один файл, без полей
 * браузера и без разрывов страниц.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { printHtml } from './browser.mjs';

/** Формат листа по ГОСТ 2.301, мм. */
export const SHEETS = {
  A4: { w: 210, h: 297 },
  A3: { w: 297, h: 420 },
  A2: { w: 420, h: 594 },
  A1: { w: 594, h: 841 },
  A0: { w: 841, h: 1189 },
};

/** Пиксели снимка: 150 dpi хватает, чтобы читать размеры на плане. */
function pngSize(sheet, landscape, dpi) {
  const size = SHEETS[String(sheet || 'A3').toUpperCase()] || SHEETS.A3;
  const mmW = landscape ? size.h : size.w;
  const mmH = landscape ? size.w : size.h;
  const k = Math.max(72, Math.min(300, Number(dpi) || 150)) / 25.4;
  return { width: Math.round(mmW * k), height: Math.round(mmH * k) };
}

function wrapHtml(content, { sheet, landscape, title }) {
  const size = SHEETS[String(sheet || 'A3').toUpperCase()] || SHEETS.A3;
  const mmW = landscape ? size.h : size.w;
  const mmH = landscape ? size.w : size.h;
  const body = /<html[\s>]/i.test(content)
    ? content
    : `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>${escapeHtml(title || 'Чертёж')}</title>
<style>
  @page { size: ${mmW}mm ${mmH}mm; margin: 0 }
  html, body { margin: 0; padding: 0; background: #fff }
  /* Лист ровно в размер: SVG тянется по вьюпорту, поэтому снимок и печать совпадают */
  body { width: ${mmW}mm; height: ${mmH}mm; overflow: hidden }
  body > svg, body > .sheet { width: 100vw; height: 100vh; display: block }
  @media print { body { width: 100vw; height: 100vh } }
</style></head><body>${content}</body></html>`;
  return { html: body, mmW, mmH };
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
}

/**
 * Создаёт файлы чертежа внутри проекта.
 * args: { path, svg|html, sheet, landscape, formats: ['pdf','png','svg'], dpi }
 */
export async function createDrawing(args = {}, { root = process.cwd() } = {}) {
  const content = String(args.svg || args.html || '').trim();
  if (!content) throw new Error('Нужен svg или html: чертёж без содержимого не создаётся');
  if (!/<svg[\s>]|<html[\s>]/i.test(content)) throw new Error('Содержимое не похоже на SVG или HTML');

  const rawName = String(args.path || 'чертёж').trim() || 'чертёж';
  const ext = path.extname(rawName).toLowerCase();
  const safeRel = ext && ['.pdf', '.png', '.svg', '.html'].includes(ext) ? rawName : `${rawName}.pdf`;
  const baseRel = safeRel.slice(0, safeRel.length - path.extname(safeRel).length);
  const full = path.resolve(root, safeRel);
  if (full !== path.resolve(root) && !full.startsWith(path.resolve(root) + path.sep)) {
    throw new Error('Чертёж должен лежать внутри проекта');
  }
  fs.mkdirSync(path.dirname(full), { recursive: true });

  const sheet = String(args.sheet || 'A3').toUpperCase();
  const landscape = args.landscape === undefined ? (SHEETS[sheet]?.w || 297) < (SHEETS[sheet]?.h || 420) : Boolean(args.landscape);
  const askedList = Array.isArray(args.formats) && args.formats.length
    ? args.formats.map((f) => String(f).toLowerCase().replace(/^\./, ''))
    : [path.extname(safeRel).slice(1) || 'pdf'];
  const wanted = new Set(askedList.flatMap((f) => (f === 'all' ? ['pdf', 'png', 'svg'] : [f])));
  for (const f of wanted) if (!['pdf', 'png', 'svg'].includes(f)) throw new Error(`Формат «${f}» не поддержан: pdf, png или svg`);

  const { html } = wrapHtml(content, { sheet, landscape, title: args.title || baseRel });
  const files = [];
  const written = {};

  /* SVG отдаём как есть: он же исходник для PDF/PNG, конвертация не нужна. */
  if (wanted.has('svg') && /<svg[\s>]/i.test(content)) {
    const svgFile = path.join(root, `${baseRel}.svg`);
    fs.mkdirSync(path.dirname(svgFile), { recursive: true });
    fs.writeFileSync(svgFile, content, 'utf8');
    written.svg = svgFile;
    files.push(svgFile);
  }

  const needsBrowser = wanted.has('pdf') || wanted.has('png');
  if (!needsBrowser) {
    return { files, written, engine: '', sheet, landscape, note: 'SVG записан без рендера' };
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-drawing-'));
  const htmlFile = path.join(tmpDir, 'drawing.html');
  fs.writeFileSync(htmlFile, html, 'utf8');

  const pdfFile = path.join(root, `${baseRel}.pdf`);
  const pngFile = path.join(root, `${baseRel}.png`);
  const { width, height } = pngSize(sheet, landscape, args.dpi);
  const size = SHEETS[sheet] || SHEETS.A3;

  try {
    const out = await printHtml({
      file: htmlFile,
      pdfPath: wanted.has('pdf') ? pdfFile : '',
      pngPath: wanted.has('png') ? pngFile : '',
      width,
      height,
      format: sheet,
      pageSize: { width: landscape ? size.h : size.w, height: landscape ? size.w : size.h },
      landscape,
    });
    if (out.pdf) {
      const bytes = fs.statSync(out.pdf).size;
      if (bytes < 1200 || fs.readFileSync(out.pdf).subarray(0, 5).toString('latin1') !== '%PDF-') {
        throw new Error('PDF получился пустым — проверьте, что SVG рисуется');
      }
      written.pdf = out.pdf;
      files.push(out.pdf);
    }
    if (out.png) {
      const bytes = fs.statSync(out.png).size;
      if (bytes < 5000) throw new Error('PNG получился пустым — проверьте, что SVG рисуется');
      written.png = out.png;
      files.push(out.png);
    }
    return { files, written, engine: out.engine, sheet, landscape, bytes: { pdf: out.pdfBytes, png: out.pngBytes } };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}
