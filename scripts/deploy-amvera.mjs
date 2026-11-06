// Развёртывание dsh-open-web в Amvera (регион msk1) — прямым REST, без MCP.
//
//   node scripts/deploy-amvera.mjs status          — карточка проекта, файлы, коммиты
//   node scripts/deploy-amvera.mjs files           — залить весь проект (батчами)
//   node scripts/deploy-amvera.mjs push <путь> …   — залить только указанные файлы
//   node scripts/deploy-amvera.mjs build           — запустить пересборку
//   node scripts/deploy-amvera.mjs wait            — ждать окончания сборки
//   node scripts/deploy-amvera.mjs deploy          — files + build + wait
//   node scripts/deploy-amvera.mjs env             — показать, что нужно переменным (не пишет)
//   node scripts/deploy-amvera.mjs domain          — адрес и статус домена
//
// Секреты берутся из хранилища DSH и в журнал не печатаются. Токен Amvera
// кешируется в %TEMP%\amvera-token.json и обновляется сам.
import fs from 'node:fs';
import path from 'node:path';
import {
  getProject,
  listFiles,
  gitLog,
  uploadFiles,
  rebuildProject,
  restartProject,
} from './amvera-api.mjs';

const SLUG = 'dshopen';
const ROOT = path.resolve(import.meta.dirname, '..');
/* Батч: и крупные vendor-файлы проходят, и запрос не растягивается на минуты. */
const MAX_BATCH_BYTES = 6 * 1024 * 1024;
const MAX_BATCH_FILES = 40;

const mode = process.argv[2] || 'status';

/** Все файлы каталога рекурсивно — в src/public есть подпапки. */
function walk(dir, prefix) {
  const out = [];
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) out.push(...walk(`${dir}/${entry.name}`, rel));
    else out.push(rel);
  }
  return out;
}

/** Что именно выкладываем: код, статика, навыки, тесты и документы. */
function projectFiles() {
  return [
    'server.mjs',
    'amvera.yaml',
    'package.json',
    'package-lock.json',
    'README.md',
    ...walk('src', 'src'),
    ...walk('public', 'public'),
    ...walk('skills', 'skills'),
    ...walk('assets', 'assets'),
    /* Тесты, проверочные скрипты и документы — тоже часть проекта: без них в
       облаке нельзя ни прогнать проверки, ни прочитать, почему предел выставлен
       именно так. */
    ...walk('test', 'test'),
    ...walk('scripts', 'scripts'),
    ...walk('docs', 'docs'),
  ].filter((rel) => fs.statSync(path.join(ROOT, rel)).isFile());
}

/** Режем список на батчи по размеру и количеству файлов. */
function batches(files) {
  const out = [];
  let current = [];
  let size = 0;
  for (const rel of files) {
    const bytes = fs.statSync(path.join(ROOT, rel)).size;
    if (current.length && (size + bytes > MAX_BATCH_BYTES || current.length >= MAX_BATCH_FILES)) {
      out.push(current);
      current = [];
      size = 0;
    }
    current.push({ path: rel, full: path.join(ROOT, rel) });
    size += bytes;
  }
  if (current.length) out.push(current);
  return out;
}

/** Заливка набора файлов батчами с печатью прогресса. */
async function upload(rels, label) {
  const fileList = rels.map((rel) => rel.replace(/\\/g, '/'));
  const totalBytes = fileList.reduce((sum, rel) => sum + fs.statSync(path.join(ROOT, rel)).size, 0);
  console.log(`Файлов: ${fileList.length}, ${(totalBytes / 1024 / 1024).toFixed(1)} МБ, батчей: ${batches(fileList).length}`);

  let done = 0;
  for (const [index, batch] of batches(fileList).entries()) {
    const bytes = batch.reduce((sum, file) => sum + fs.statSync(file.full).size, 0);
    const answer = await uploadFiles(SLUG, batch, {
      commitMessage: `${label} (${index + 1}/${batches(fileList).length}, ${batch.length} файлов)`,
      timeout: 300_000,
    });
    done += bytes;
    const names = batch.map((file) => file.path);
    console.log(
      `  батч ${index + 1}: ${batch.length} файлов, ${(bytes / 1024 / 1024).toFixed(1)} МБ → ${String(answer).slice(0, 120)}`,
    );
    /* Первый и последний файл батча печатаем: видно, что ушло именно то. */
    console.log(`    ${names[0]}${names.length > 1 ? ' … ' + names[names.length - 1] : ''}; всего ${(done / 1024 / 1024).toFixed(1)} МБ`);
  }
}

/** Ждём, пока платформа соберёт и поднимет проект. */
async function waitBuild(limitMinutes = 12) {
  const started = Date.now();
  let previous = '';
  while (Date.now() - started < limitMinutes * 60_000) {
    const project = await getProject(SLUG);
    const line = `${project.status} — ${project.statusMessage || ''}`;
    if (line !== previous) {
      const seconds = Math.round((Date.now() - started) / 1000);
      console.log(`[${String(seconds).padStart(3)} с] ${line}`);
      previous = line;
    }
    if (project.status === 'RUNNING' && /success|deployed|успеш/i.test(project.statusMessage || '') && Date.now() - started > 20_000) {
      return project;
    }
    if (/ERROR|FAILED|BUILD_FAILED/i.test(project.status)) {
      throw new Error('сборка завершилась ошибкой: ' + line);
    }
    await new Promise((resolve) => setTimeout(resolve, 8_000));
  }
  throw new Error('за ' + limitMinutes + ' мин сборка не завершилась');
}

if (mode === 'status') {
  const project = await getProject(SLUG);
  console.log('==== Проект ====');
  for (const key of ['name', 'slug', 'status', 'statusMessage', 'instances', 'namespace']) {
    console.log(`  ${key}: ${project[key]}`);
  }
  console.log('\n==== Файлы в корне ====');
  const root = await listFiles(SLUG, '/');
  console.log('  ' + root.map((entry) => entry.name + (entry.isFolder ? '/' : '')).join(' '));
  console.log('\n==== Последние коммиты ====');
  for (const commit of await gitLog(SLUG, { size: 5 })) {
    console.log(`  ${commit.hash.slice(0, 8)} ${commit.date}: ${commit.message}`);
  }
} else if (mode === 'files' || mode === 'push' || mode === 'deploy') {
  const targets = mode === 'push' ? process.argv.slice(3) : [];
  const files = targets.length ? targets : projectFiles();
  await upload(files, targets.length ? 'dsh-open-web: правка' : 'dsh-open-web: обновление проекта');
  if (mode === 'deploy') {
    console.log('\n==== Пересборка ====');
    console.log(JSON.stringify(await rebuildProject(SLUG)).slice(0, 300));
    await waitBuild();
    console.log('\nГотово: проект собран и запущен.');
  }
} else if (mode === 'build') {
  console.log('Запускаю пересборку: ' + JSON.stringify(await rebuildProject(SLUG)).slice(0, 300));
} else if (mode === 'restart') {
  console.log('Перезапуск без сборки: ' + JSON.stringify(await restartProject(SLUG)).slice(0, 300));
} else if (mode === 'wait') {
  const project = await waitBuild();
  console.log('\nИтог: ' + project.status + ' — ' + project.statusMessage);
} else if (mode === 'env') {
  /* Переменные уже настроены в кабинете; REST-путь для них не подтверждён,
     поэтому режим только напоминает состав и ничего не меняет. */
  console.log('Переменные окружения задаются в кабинете Amvera:');
  console.log('  https://cloud.amvera.ru/projects/applications/vladimir00177/~/vladimir00177/dshopen/env-variables');
  console.log('Ожидаемый состав: DSHOW_HOST, DSHOW_PORT, DSHOW_DATA_DIR, DSHOW_TRUST_PROXY,');
  console.log('  DSHOW_ADMIN_USER, DSHOW_ADMIN_PASSWORD, DSHOW_DEEPSEEK_KEY, OPENROUTER_API_KEY,');
  console.log('  DSHOW_MAX_ATTACHMENT_MB, DSHOW_MAX_PARSE_MB, DSHOW_MIN_FREE_MB, DSHOW_TG_TOKEN, DSHOW_TG_CHAT');
} else if (mode === 'domain') {
  console.log('Домен проекта: https://dshopen-vladimir00177.msk1.amvera.tech');
} else {
  console.log('Неизвестный режим: ' + mode);
  console.log('Режимы: status | files | push <путь…> | build | wait | deploy | restart | env | domain');
  process.exitCode = 1;
}
