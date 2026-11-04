#!/usr/bin/env node
/**
 * CLI юридического полигона Harvey LAB.
 *
 * Команды:
 *   status                       что уже скачано и сколько заданий в каталоге
 *   sync [--refresh]             скачать/обновить каталог заданий (только task.json)
 *   areas                        практики и число заданий в них
 *   list [фильтры]               список заданий: --area --work --q --min-criteria --max-criteria --limit --json
 *   show <id> [--criteria N]     задание: инструкция, деливераблы, первые критерии рубрики
 *   fetch <id>                   скачать документы дела (разреженный чекаут)
 *   prepare <id> [--out dir]     рабочая папка: documents/ + output/ + instructions.md
 *   grade --task <id> --output dir [--result dir] [--judge pro|flash|модель]
 *                                оценка работы по рубрике (правило «всё-или-ничего»)
 *
 * Пример:
 *   node scripts/legalbench.mjs sync
 *   node scripts/legalbench.mjs list --area real-estate --limit 10
 *   node scripts/legalbench.mjs prepare real-estate/draft-warranty-deed
 *   node scripts/legalbench.mjs grade --task real-estate/draft-warranty-deed \
 *     --output data/legalbench/runs/<run>/output --result data/legalbench/runs/<run>
 */
import path from 'node:path';
import fs from 'node:fs';
import {
  LAB_DIR,
  LAB_JUDGE_MAX_CRITERIA,
  labStatus,
  syncCatalog,
  readCatalog,
  filterTasks,
  readTask,
  fetchDocuments,
  prepareTask,
  gradeRun,
  renderReport,
} from '../src/legalbench.mjs';
import { formatBytes } from '../src/util.mjs';

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (item.startsWith('--')) {
      const [name, inline] = item.slice(2).split('=');
      if (inline !== undefined) flags[name] = inline;
      else if (argv[i + 1] && !argv[i + 1].startsWith('--')) flags[name] = argv[++i];
      else flags[name] = true;
    } else {
      positional.push(item);
    }
  }
  return { positional, flags };
}

const log = (message) => process.stderr.write(`· ${message}\n`);

function printAreas() {
  const catalog = readCatalog();
  const areas = new Map();
  for (const task of catalog) {
    const entry = areas.get(task.area) || { tasks: 0, criteria: 0 };
    entry.tasks += 1;
    entry.criteria += task.criteria;
    areas.set(task.area, entry);
  }
  for (const [area, entry] of [...areas].sort((a, b) => b[1].tasks - a[1].tasks)) {
    const avg = Math.round(entry.criteria / entry.tasks);
    console.log(`${area.padEnd(44)} ${String(entry.tasks).padStart(4)} заданий · ~${avg} критериев`);
  }
  console.log(`\nвсего: ${catalog.length} заданий, ${areas.size} практик`);
}

function printList(flags) {
  const { total, items } = filterTasks(readCatalog(), {
    area: flags.area,
    workType: flags.work,
    q: flags.q,
    minCriteria: flags['min-criteria'],
    maxCriteria: flags['max-criteria'],
    limit: flags.limit || 40,
    offset: flags.offset || 0,
  });
  if (flags.json) {
    console.log(JSON.stringify({ total, items }, null, 2));
    return;
  }
  if (!items.length) {
    console.log('Ничего не нашлось. Проверь фильтры или выполни sync.');
    return;
  }
  for (const task of items) {
    console.log(
      [
        String(task.criteria).padStart(4),
        'крит',
        (task.workType || '—').padEnd(8),
        task.id,
      ].join(' '),
    );
    console.log(`      ${task.title}`);
  }
  console.log(`\nпоказано ${items.length} из ${total}`);
}

function printTask(id, flags) {
  const task = readTask(id);
  if (flags.json) {
    console.log(JSON.stringify(task, null, 2));
    return;
  }
  const limit = Number(flags.criteria || 8);
  console.log(`# ${task.title}`);
  console.log(`id:       ${task.id}`);
  console.log(`практика: ${task.area}`);
  console.log(`тип:      ${task.workType || 'не указан'}`);
  console.log(`рубрика:  ${task.criteria.length} критериев (всё-или-ничего)`);
  console.log(`файлы:    ${task.deliverables.join(', ') || 'не заданы'}`);
  console.log(`материалы: ${task.documentsReady ? `${task.documents.length} документов` : 'не скачаны (fetch)'}`);
  if (task.documents.length) {
    for (const doc of task.documents.slice(0, 20)) console.log(`  · ${doc.name} (${formatBytes(doc.size)})`);
  }
  console.log('\n## Инструкция\n');
  console.log(task.instructions || '(пусто)');
  console.log(`\n## Критерии (показаны ${Math.min(limit, task.criteria.length)} из ${task.criteria.length})\n`);
  for (const criterion of task.criteria.slice(0, limit)) {
    console.log(`${criterion.id} ${criterion.title}`);
    if (criterion.match) console.log(`   ${criterion.match}`);
  }
  if (task.criteria.length > limit) console.log(`\n…ещё ${task.criteria.length - limit} критериев: show ${task.id} --criteria all`);
}

function printGrade(result) {
  const verdict = result.score === 1 ? 'PASS 1.0' : 'FAIL 0.0';
  console.log(`${verdict} — ${result.title}`);
  console.log(`${result.passedCount} из ${result.total} критериев · судья ${result.model} · ${result.taskId}`);
  if (result.sampled) console.log('проверена часть рубрики (ограничение прогона)');
  for (const item of result.criteria) {
    console.log(`\n${item.pass ? 'PASS' : 'FAIL'} ${item.id} ${item.title}`);
    if (item.reason) console.log(`  ${item.reason}`);
  }
  console.log(`\nотчёт: ${result.reportPath || '(не сохранён)'}`);
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { positional, flags } = parseArgs(rest);

  try {
    switch (command) {
      case 'status': {
        const status = labStatus();
        console.log(`каталог:  ${status.dir}`);
        console.log(`заданий:  ${status.tasks} в ${status.areas} практиках`);
        if (!status.ready) {
          console.log('каталога нет — выполни: node scripts/legalbench.mjs sync');
          return;
        }
        console.log(`рубрики:  от ${status.criteriaMin} до ${status.criteriaMax} критериев`);
        console.log(`каталог собран: ${status.catalogAt}`);
        return;
      }
      case 'sync': {
        const stats = await syncCatalog({ refresh: Boolean(flags.refresh), log });
        console.log(`каталог готов: ${stats.tasks} заданий, ${stats.areas} практик, commit ${stats.commit.slice(0, 12)}`);
        return;
      }
      case 'areas':
        printAreas();
        return;
      case 'list':
        printList(flags);
        return;
      case 'show': {
        if (!positional[0]) throw new Error('Нужен id задания: show <id>');
        printTask(positional[0], { ...flags, criteria: flags.criteria === 'all' ? 100000 : flags.criteria });
        return;
      }
      case 'fetch': {
        if (!positional[0]) throw new Error('Нужен id задания: fetch <id>');
        const result = await fetchDocuments(positional[0], { log });
        console.log(`${result.id}: ${result.documents.length} документов${result.fetched ? ' (скачаны)' : ' (уже были)'}`);
        for (const doc of result.documents) console.log(`  · ${doc.name} (${formatBytes(doc.size)})`);
        return;
      }
      case 'prepare': {
        if (!positional[0]) throw new Error('Нужен id задания: prepare <id>');
        const prepared = await prepareTask(positional[0], { dest: flags.out || '', log });
        console.log(`задание готово: ${prepared.id}`);
        console.log(`папка:     ${prepared.dir}`);
        console.log(`документы: ${prepared.documents.length} в ${prepared.documentsDir}`);
        console.log(`положить файлы: ${prepared.deliverables.join(', ') || 'по инструкции'} → ${prepared.outputDir}`);
        console.log(`критериев: ${prepared.criteria}`);
        return;
      }
      case 'grade': {
        const taskId = positional[0] || flags.task;
        if (!taskId) throw new Error('Нужен id задания: grade --task <id> --output <папка с работой>');
        const output = flags.output || flags.out;
        if (!output) throw new Error('Нужна папка с работой: --output <dir>');
        const result = await gradeRun({
          taskId,
          outputDir: path.resolve(output),
          resultDir: flags.result || '',
          judge: flags.judge || 'pro',
          criteriaIds: flags.criteria ? String(flags.criteria).split(',').map((item) => item.trim()).filter(Boolean) : [],
          maxCriteria: flags['max-criteria'] ? Number(flags['max-criteria']) : LAB_JUDGE_MAX_CRITERIA,
          concurrency: flags.concurrency ? Number(flags.concurrency) : 4,
          log,
        });
        if (flags.json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          printGrade(result);
        }
        if (result.score !== 1) process.exitCode = 2;
        return;
      }
      case 'report': {
        const file = flags.file || positional[0];
        if (!file) throw new Error('Нужен путь к scores.json: report --file data/legalbench/runs/<run>/scores.json');
        const result = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
        const html = path.join(path.dirname(path.resolve(file)), 'report.html');
        fs.writeFileSync(html, renderReport(result), 'utf8');
        console.log(`отчёт пересобран: ${html}`);
        return;
      }
      default:
        console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0].replace(/^\/\*\*?/, '').trim());
        console.log(`\nданные полигона: ${LAB_DIR}`);
        if (command && command !== 'help') process.exitCode = 1;
    }
  } catch (error) {
    console.error(`ошибка: ${error.message}`);
    process.exitCode = 1;
  }
}

main();
