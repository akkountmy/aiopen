#!/usr/bin/env node
/**
 * Визуализация проекта: hero-кадр 1600×1000 для карточки проекта.
 *
 * Основной путь — векторный кадр hero.mjs + resvg: единицы мегабайт памяти,
 * доли секунды, никакого Chromium. Это важно на тарифе 500 МБ, где WebGL-
 * браузер рядом с сервисом стабильно упирается в OOM.
 *
 * Для локальной «фотографичной» проверки можно попросить старый путь:
 *   DSHOW_RENDER_BROWSER=1 node visual.mjs design.json design/render.png
 *
 *   node visual.mjs design.json design/render.png [--width 1600] [--height 1000]
 */
import fs from 'node:fs';
import path from 'node:path';
import { heroSvg } from './hero.mjs';

const [file, outArg] = process.argv.slice(2);
if (!file) {
  console.error('Использование: node visual.mjs spec.json out.png [--width 1600] [--height 1000]');
  process.exit(2);
}

const specPath = path.resolve(file);
const outPng = path.resolve(outArg || path.join('design', 'render.png'));
const spec = JSON.parse(fs.readFileSync(specPath, 'utf8').replace(/^\uFEFF/, ''));

const widthIdx = process.argv.indexOf('--width');
const heightIdx = process.argv.indexOf('--height');
const width = widthIdx > 0 ? Math.max(800, Math.min(2400, Number(process.argv[widthIdx + 1]) || 1600)) : 1600;
const height = heightIdx > 0 ? Math.max(600, Math.min(1600, Number(process.argv[heightIdx + 1]) || 1000)) : 1000;

async function browserFallback(reason) {
  console.error(`Векторный рендер недоступен (${reason}), пробую Chromium…`);
  const { buildScene } = await import('./scene.mjs');
  const { htmlShot } = await import('./shot.mjs');
  const os = await import('node:os');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-render-'));
  const html = path.join(tmp, 'scene.html');
  try {
    buildScene(spec, html);
    const shot = await htmlShot(html, outPng, { width, height, dpi: 1, query: '?shot=1&view=hero' });
    if (!fs.existsSync(outPng) || fs.statSync(outPng).size <= 10_000) throw new Error('кадр пустой или слишком маленький');
    return shot;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

try {
  fs.mkdirSync(path.dirname(outPng), { recursive: true });
  const { svg } = heroSvg(spec);
  let png;
  let engine = 'resvg';
  if (process.env.DSHOW_RENDER_BROWSER === '1') {
    const shot = await browserFallback('DSHOW_RENDER_BROWSER=1');
    engine = shot.engine || 'chromium';
  } else {
    try {
      const { Resvg } = await import('@resvg/resvg-js');
      const renderer = new Resvg(svg, {
        fitTo: { mode: 'width', value: width },
        background: '#141517',
      });
      const rendered = renderer.render();
      png = rendered.asPng();
      fs.writeFileSync(outPng, png);
    } catch (error) {
      /* Не уходим молча в Chromium: на тарифе 500 МБ это тот самый OOM,
         из-за которого лист не собирался. Локально браузер включается явно
         через DSHOW_RENDER_BROWSER=1. */
      throw new Error(`resvg не отрисовал кадр: ${error.message}`);
    }
  }
  const bytes = fs.existsSync(outPng) ? fs.statSync(outPng).size : 0;
  const magic = bytes >= 8 ? fs.readFileSync(outPng).subarray(0, 8).toString('hex') : '';
  if (!bytes || magic !== '89504e470d0a1a0a' || bytes <= 10_000) {
    throw new Error(`PNG не записан (${bytes} Б, magic ${magic || '—'})`);
  }
  console.log(JSON.stringify({ png: outPng, bytes, width, height, engine, svgBytes: Buffer.byteLength(svg) }, null, 2));
} catch (error) {
  console.error('Не удалось собрать визуализацию:', error.message);
  process.exit(1);
}
