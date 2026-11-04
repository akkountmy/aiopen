#!/usr/bin/env node
/**
 * Печать интерьерного листа: SVG (мм) -> PDF в масштабе 1:1 и/или PNG для проверки.
 *
 *   node render.mjs sheet.svg out.pdf [--png out.png] [--dpi 2]
 *   node render.mjs scene.html out.png
 *
 * PDF печатает headless Edge/Chromium: размер страницы берётся из width/height SVG в мм,
 * поэтому 1:50 на листе A3 остаётся 1:50 и в PDF.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const EDGE_CANDIDATES = [
  process.env.EDGE_PATH,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/microsoft-edge',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
];

export function findBrowser() {
  for (const p of EDGE_CANDIDATES) if (p && fs.existsSync(p)) return p;
  return null;
}

const MM_PER_INCH = 25.4;

function readSvgSize(svg) {
  const w = svg.match(/<svg[^>]*\swidth="([\d.]+)mm"/);
  const h = svg.match(/<svg[^>]*\sheight="([\d.]+)mm"/);
  if (!w || !h) throw new Error('в SVG должна быть задана ширина и высота в мм (width="420mm")');
  return { w: Number(w[1]), h: Number(h[1]) };
}

export function sheetHtml(svg) {
  const { w, h } = readSvgSize(svg);
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Лист</title>
<style>
  @page { size: ${w}mm ${h}mm; margin: 0 }
  html, body { margin: 0; padding: 0; background: #fff }
  svg { display: block; width: ${w}mm; height: ${h}mm }
</style></head><body>
${svg.replace(/<\?xml[^>]*\?>/g, '')}
</body></html>`;
}

function browserRun(bin, args, o = {}) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-edge-'));
  const gpu = o.gpu ? [] : ['--disable-gpu'];
  const res = spawnSync(bin, ['--headless=new', ...gpu, '--no-first-run', '--no-default-browser-check', `--user-data-dir=${profile}`, ...args], {
    encoding: 'utf8',
    timeout: 120000,
  });
  fs.rmSync(profile, { recursive: true, force: true });
  return res;
}

/** PDF из готового листа; возвращает путь и размер. */
export function svgToPdf(svgPath, pdfPath, o = {}) {
  const bin = findBrowser();
  if (!bin) throw new Error('не найден Edge/Chrome для печати PDF');
  const svg = fs.readFileSync(svgPath, 'utf8');
  const html = sheetHtml(svg);
  const htmlPath = path.join(os.tmpdir(), `dsh-sheet-${process.pid}.html`);
  fs.writeFileSync(htmlPath, html, 'utf8');
  fs.mkdirSync(path.dirname(path.resolve(pdfPath)), { recursive: true });
  const res = browserRun(bin, ['--no-pdf-header-footer', `--print-to-pdf=${path.resolve(pdfPath)}`, '--print-to-pdf-no-header', `file:///${htmlPath.replace(/\\/g, '/')}`]);
  if (!fs.existsSync(pdfPath) || fs.statSync(pdfPath).size < 1000) {
    throw new Error(`PDF не напечатался: ${(res.stderr || '').slice(-400)}`);
  }
  const head = fs.readFileSync(pdfPath).subarray(0, 5).toString('latin1');
  if (head !== '%PDF-') throw new Error('на выходе не PDF');
  void o;
  return { pdf: path.resolve(pdfPath), bytes: fs.statSync(pdfPath).size };
}

/** PNG-проверка листа: скриншот страницы в 2× разрешении. */
export function svgToPng(svgPath, pngPath, scale = 2) {
  const bin = findBrowser();
  if (!bin) throw new Error('не найден Edge/Chrome для скриншота');
  const svg = fs.readFileSync(svgPath, 'utf8');
  const { w, h } = readSvgSize(svg);
  const html = sheetHtml(svg).replace('</style>', '  svg { width: 100vw !important; height: 100vh !important }\n</style>');
  const htmlPath = path.join(os.tmpdir(), `dsh-sheet-png-${process.pid}.html`);
  fs.writeFileSync(htmlPath, html, 'utf8');
  const pxW = Math.round((w / MM_PER_INCH) * 96);
  const pxH = Math.round((h / MM_PER_INCH) * 96);
  fs.mkdirSync(path.dirname(path.resolve(pngPath)), { recursive: true });
  const res = browserRun(bin, [`--force-device-scale-factor=${scale}`, `--window-size=${pxW},${pxH}`, '--hide-scrollbars', `--screenshot=${path.resolve(pngPath)}`, `file:///${htmlPath.replace(/\\/g, '/')}`]);
  if (!fs.existsSync(pngPath) || fs.statSync(pngPath).size < 2000) {
    throw new Error(`PNG не снялся: ${(res.stderr || '').slice(-400)}`);
  }
  return { png: path.resolve(pngPath), bytes: fs.statSync(pngPath).size };
}

/** PNG из произвольного HTML (3D-сцена, страница визуализации). */
export function htmlToPng(htmlPath, pngPath, o = {}) {
  const bin = findBrowser();
  if (!bin) throw new Error('не найден Edge/Chrome для скриншота');
  const w = o.width || 1600;
  const h = o.height || 1000;
  fs.mkdirSync(path.dirname(path.resolve(pngPath)), { recursive: true });
  const res = browserRun(bin, [
    `--window-size=${w},${h}`,
    '--hide-scrollbars',
    `--virtual-time-budget=${o.waitMs || 5000}`,
    '--run-all-compositor-stages-before-draw',
    '--enable-unsafe-swiftshader',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    `--screenshot=${path.resolve(pngPath)}`,
    `file:///${path.resolve(htmlPath).replace(/\\/g, '/')}${o.query || ''}`,
  ], { gpu: true });
  if (!fs.existsSync(pngPath) || fs.statSync(pngPath).size < 2000) {
    throw new Error(`PNG не снялся: ${(res.stderr || '').slice(-400)}`);
  }
  return { png: path.resolve(pngPath), bytes: fs.statSync(pngPath).size };
}

if (process.argv[1] && process.argv[1].endsWith('render.mjs')) {
  const [input, output] = process.argv.slice(2);
  if (!input) {
    console.error('Использование: node render.mjs sheet.svg out.pdf [--png out.png] [--dpi 2]');
    process.exit(2);
  }
  const pngArg = process.argv.includes('--png') ? process.argv[process.argv.indexOf('--png') + 1] : null;
  const isSvg = /\.svg$/i.test(input);
  const out = output || input.replace(/\.(svg|html)$/i, '.pdf');
  const result = isSvg
    ? /\.png$/i.test(out)
      ? svgToPng(input, out, Number(process.argv.includes('--dpi') ? process.argv[process.argv.indexOf('--dpi') + 1] : 2))
      : svgToPdf(input, out)
    : htmlToPng(input, /\.png$/i.test(out) ? out : out.replace(/\.\w+$/, '.png'), { waitMs: 6000 });
  if (pngArg && isSvg && !/\.png$/i.test(out)) Object.assign(result, svgToPng(input, pngArg));
  console.log(JSON.stringify(result, null, 2));
}
