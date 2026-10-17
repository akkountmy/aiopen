// Развёртывание dsh-open-web в Amvera через MCP платформы.
// Секреты берутся из окружения и в журнал не печатаются.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { callTool } from './amvera-mcp.mjs';

const SLUG = 'dshopen';
const ROOT = path.resolve(import.meta.dirname, '..');

function creds() {
  const text = fs.readFileSync(path.join(os.homedir(), '.dsh', '.credentials.yaml'), 'utf8');
  const out = {};
  for (const key of ['DEEPSEEK_API_KEY', 'OPENROUTER_API_KEY']) {
    const m = text.match(new RegExp(`^\\s*${key}\\s*:\\s*(\\S+)\\s*$`, 'm'));
    if (!m) throw new Error(`в ~/.dsh/.credentials.yaml нет ${key}`);
    out[key] = m[1].replace(/^["']|["']$/g, '');
  }
  return out;
}

const mode = process.argv[2] || 'status';

if (mode === 'status') {
  for (const [title, tool, args] of [
    ['Проект', 'getProject', { slug: SLUG }],
    ['Переменные', 'listEnvVars', { slug: SLUG }],
    ['Файлы', 'listFiles', { slug: SLUG, path: '/', branch: 'master' }],
    ['Домены', 'listDomains', { slug: SLUG }],
  ]) {
    console.log(`\n==== ${title} ====`);
    try {
      const r = await callTool(tool, args);
      console.log(r.isError ? 'ОШИБКА: ' + r.text : r.text.slice(0, 3000));
    } catch (error) {
      console.log('не удалось: ' + error.message.slice(0, 300));
    }
  }
} else if (mode === 'files' || mode === 'push') {
  const targets = mode === 'push' ? process.argv.slice(3) : null;
  const files =
    targets && targets.length
      ? targets
      : [
          'server.mjs',
          'amvera.yaml',
          'package.json',
          'README.md',
          ...fs.readdirSync(path.join(ROOT, 'src')).map((f) => `src/${f}`),
          ...fs.readdirSync(path.join(ROOT, 'public')).map((f) => `public/${f}`),
          ...fs.readdirSync(path.join(ROOT, 'assets', 'fonts')).map((f) => `assets/fonts/${f}`),
        ].filter((rel) => fs.statSync(path.join(ROOT, rel)).isFile());

  for (const raw of files) {
    /* аргументы из PowerShell приходят с обратными слэшами — дальше работаем как с posix-путём */
    const rel = raw.replace(/\\/g, '/');
    const full = path.join(ROOT, rel);
    const binary = /\.(ttf|otf|woff2?|png|jpe?g|gif|ico|zip|pdf)$/i.test(rel);
    const dir = path.posix.dirname(rel);
    const r = await callTool('uploadFiles', {
      slug: SLUG,
      filePath: '',
      fileBase64: binary ? fs.readFileSync(full).toString('base64') : '',
      fileText: binary ? '' : fs.readFileSync(full, 'utf8'),
      filename: path.basename(rel),
      path: dir === '.' ? '/' : '/' + dir,
      commitMessage: `dsh-open-web: ${rel}`,
      branch: 'master',
    });
    const size = (fs.statSync(full).size / 1024).toFixed(1);
    console.log(`${rel} (${size} КБ): ${r.isError ? 'ОШИБКА ' + r.text.slice(0, 300) : r.text.slice(0, 160).replace(/\s+/g, ' ')}`);
  }
} else if (mode === 'env') {
  const keys = creds();
  const adminPassword = String(process.env.DSHOW_ADMIN_PASSWORD || '');
  if (!adminPassword) throw new Error('задайте DSHOW_ADMIN_PASSWORD в окружении');
  const vars = [
    { name: 'DSHOW_HOST', value: '0.0.0.0', isSecret: false, type: 'RUN' },
    { name: 'DSHOW_PORT', value: '3123', isSecret: false, type: 'RUN' },
    { name: 'DSHOW_DATA_DIR', value: '/data', isSecret: false, type: 'RUN' },
    { name: 'DSHOW_TRUST_PROXY', value: '1', isSecret: false, type: 'RUN' },
    { name: 'DSHOW_ADMIN_USER', value: 'DSHOPENWEB', isSecret: false, type: 'RUN' },
    { name: 'DSHOW_ADMIN_PASSWORD', value: adminPassword, isSecret: true, type: 'RUN' },
    { name: 'DSHOW_DEEPSEEK_KEY', value: keys.DEEPSEEK_API_KEY, isSecret: true, type: 'RUN' },
    { name: 'OPENROUTER_API_KEY', value: keys.OPENROUTER_API_KEY, isSecret: true, type: 'RUN' },
    { name: 'DSHOW_MAX_ATTACHMENT_MB', value: '64', isSecret: false, type: 'RUN' },
    { name: 'DSHOW_MAX_PARSE_MB', value: '24', isSecret: false, type: 'RUN' },
    { name: 'DSHOW_MIN_FREE_MB', value: '256', isSecret: false, type: 'RUN' },
  ];
  /* Телеграм-уведомления о тяжёлых задачах: значения берём из окружения и не печатаем. */
  if (process.env.DSHOW_TG_TOKEN) {
    vars.push({ name: 'DSHOW_TG_TOKEN', value: process.env.DSHOW_TG_TOKEN, isSecret: true, type: 'RUN' });
  }
  if (process.env.DSHOW_TG_CHAT) {
    vars.push({ name: 'DSHOW_TG_CHAT', value: process.env.DSHOW_TG_CHAT, isSecret: false, type: 'RUN' });
  }
  if (process.env.DSHOW_TASK_LIMIT_USD) {
    vars.push({ name: 'DSHOW_TASK_LIMIT_USD', value: process.env.DSHOW_TASK_LIMIT_USD, isSecret: false, type: 'RUN' });
  }
  if (process.env.DSHOW_TASK_STEP_USD) {
    vars.push({ name: 'DSHOW_TASK_STEP_USD', value: process.env.DSHOW_TASK_STEP_USD, isSecret: false, type: 'RUN' });
  }
  console.log('Отправляю переменные: ' + vars.map((v) => v.name + (v.isSecret ? ' (секрет)' : '')).join(', '));
  const r = await callTool('createEnvVars', { slug: SLUG, envVarsJson: JSON.stringify(vars) });
  console.log(r.isError ? 'ОШИБКА: ' + r.text.slice(0, 800) : r.text.slice(0, 1200));
} else if (mode === 'build') {
  const r = await callTool('rebuildProject', { slug: SLUG });
  console.log(r.isError ? 'ОШИБКА: ' + r.text.slice(0, 800) : r.text.slice(0, 800));
} else if (mode === 'logs') {
  for (const [title, tool, args] of [
    ['Сборка', 'getBuildLogs', { slug: SLUG }],
    ['Запуск', 'getRunLogs', { slug: SLUG }],
  ]) {
    console.log(`\n==== ${title} ====`);
    const r = await callTool(tool, args);
    console.log(r.isError ? 'ОШИБКА: ' + r.text.slice(0, 800) : r.text.slice(-4000));
  }
} else if (mode === 'domain') {
  const r = await callTool('createDomain', { slug: SLUG });
  console.log(r.isError ? 'ОШИБКА: ' + r.text.slice(0, 800) : r.text.slice(0, 800));
}

