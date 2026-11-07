#!/usr/bin/env node
/**
 * Визуализация проекта: один кадр 3D-сцены в PNG для карточки проекта.
 *
 * Сцену собирает scene.mjs (тот же спек, тот же three.js), а снимает
 * shot.mjs через Playwright Chromium: headless Edge на сервере без GPU
 * отдаёт пустой WebGL-кадр, поэтому здесь только Chromium + SwiftShader.
 *
 *   node visual.mjs design.json design/render.png [--width 1600] [--height 1000]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildScene } from './scene.mjs';
import { htmlShot } from './shot.mjs';

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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-render-'));
const html = path.join(tmp, 'scene.html');
try {
  fs.mkdirSync(path.dirname(outPng), { recursive: true });
  buildScene(spec, html);
  /* На машине с малым объёмом свободной RAM Chromium с dpi 1.25 падает на
     ожидании шрифтов; 1600×1000 при dpi 1 снимается стабильно. */
  const highDpi = os.freemem() > 2.2 * 1024 * 1024 * 1024;
  const dpiPlan = highDpi ? [1.25, 1] : [1];
  let shot;
  let lastError;
  /* Chromium на маленьком сервере иногда не поднимается с первого раза:
     второй заход после паузы дешевле, чем отдать проект без визуализации. */
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const options = { width, height, dpi: dpiPlan[Math.min(attempt - 1, dpiPlan.length - 1)], query: '?shot=1&view=hero' };
      shot = await htmlShot(html, outPng, options);
      const notReady = (shot.errors || []).some((item) => /готовность|data-ready/.test(String(item)));
      if (!notReady && fs.existsSync(outPng) && fs.statSync(outPng).size > 10_000) break;
      lastError = new Error(notReady ? 'сцена не успела отрисоваться' : 'кадр пустой или слишком маленький');
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 1200));
  }
  if (!shot || !fs.existsSync(outPng) || fs.statSync(outPng).size <= 10_000) {
    throw lastError || new Error('кадр не снят');
  }
  console.log(JSON.stringify({ png: outPng, bytes: fs.statSync(outPng).size, width, height, engine: shot.engine, errors: shot.errors || [] }, null, 2));
  if (!fs.statSync(outPng).size) process.exit(1);
} catch (error) {
  console.error('Не удалось снять визуализацию:', error.message);
  process.exit(1);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
