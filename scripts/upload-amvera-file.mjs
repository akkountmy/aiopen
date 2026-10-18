// Загрузка одного файла в Amvera: node scripts/_upload-one.mjs public/app.js
import fs from 'node:fs';
import path from 'node:path';
import { callTool } from './amvera-mcp.mjs';

const rel = process.argv[2];
if (!rel) throw new Error('укажите путь файла');
const ROOT = path.resolve(import.meta.dirname, '..');
const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
const dir = path.posix.dirname(rel);
const r = await callTool('uploadFiles', {
  slug: 'dshopen',
  filePath: '',
  fileBase64: '',
  fileText: text,
  filename: path.basename(rel),
  path: dir === '.' ? '/' : '/' + dir,
  commitMessage: `dsh-open-web: ${rel}`,
  branch: 'master',
});
console.log(r.isError ? 'ОШИБКА: ' + r.text : r.text.slice(0, 300));

