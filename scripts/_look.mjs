import fs from 'node:fs';
import { describeImage } from '../src/vision.mjs';
const buf = fs.readFileSync('C:/Users/33620/.dsh/attachments/v1/objects/40/402a32fa0b6231636a6c0bb6cd8f996b8a9ba221bb02ec323473b13c9e166773');
const out = await describeImage({
  buffer: buf, mime: 'image/png', name: 'screenshot.png',
  instruction: 'Это скриншот веб-интерфейса. Опиши подробно и буквально: 1) что находится в левой колонке (какие панели, их заголовки, что наложено друг на друга, какой рисунок/логотип и где), 2) что в центральной части, 3) что в правой части (нарисованные линии, панель инструментов, что за элемент), 4) какие тексты видны. Не интерпретируй, просто перечисли видимое.',
});
console.log(out);
