/**
 * Хранение реестров задания на сайте.
 *
 * Реестр приходит из харнесса (агент разобрал постановку) или заводится здесь
 * же через API. Лежит отдельным json на задание в data/task-briefs/<id>.json:
 * одно задание — один файл, потому что общий список при слиянии двух правок
 * теряет пункты, а именно пункты здесь и охраняются.
 *
 * Запись атомарная (общий atomicWrite): оборванный запрос не оставит половину
 * реестра. Рядом с json — человеческая копия .md, её можно скачать и открыть
 * глазами.
 */

import fs from 'node:fs';
import path from 'node:path';

import { TASK_BRIEF_DIR } from './config.mjs';
import { atomicWrite } from './util.mjs';
import { coverageOf, renderBriefMarkdown, validateBrief } from './taskbrief.mjs';

/** Идентификатор приходит извне (харнесс/агент), поэтому чистим его как имя файла. */
export function safeBriefId(raw) {
  return String(raw || '').replace(/[^a-zA-Z0-9._-]/g, '');
}

export function briefFile(id) {
  const safe = safeBriefId(id);
  if (!safe) throw new Error('пустой идентификатор задания');
  return path.join(TASK_BRIEF_DIR, `${safe}.json`);
}

export function readBriefRaw(id) {
  try {
    const file = briefFile(id);
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

/**
 * Сохранение: канонический вид задаёт normalizeBrief у вызывающего, здесь только
 * файл, поля владельца и человеческая копия. `source` — откуда пришло
 * (harness / site), чтобы в списке было видно, чей это реестр.
 */
export function writeBrief(brief, { source = 'harness', ownerId = '' } = {}) {
  if (!brief || !brief.id) throw new Error('у реестра нет идентификатора');
  const stored = {
    ...brief,
    source,
    ownerId: ownerId || brief.ownerId || '',
    receivedAt: new Date().toISOString(),
  };
  atomicWrite(briefFile(stored.id), `${JSON.stringify(stored, null, 2)}\n`);
  try {
    atomicWrite(briefFile(stored.id).replace(/\.json$/, '.md'), renderBriefMarkdown(stored));
  } catch {
    /* Копия для человека — удобство; реестр уже сохранён. */
  }
  return stored;
}

/** Список для доски: без тяжёлых полей, только то, что видно в списке. */
export function listBriefs() {
  let names = [];
  try {
    names = fs.readdirSync(TASK_BRIEF_DIR).filter((name) => name.endsWith('.json'));
  } catch {
    return [];
  }
  const items = [];
  names.forEach((name) => {
    try {
      const brief = JSON.parse(fs.readFileSync(path.join(TASK_BRIEF_DIR, name), 'utf8').replace(/^\uFEFF/, ''));
      const report = validateBrief(brief);
      items.push({
        id: brief.id,
        title: brief.title,
        goal: brief.goal,
        workspace: brief.workspace,
        updatedAt: brief.updatedAt,
        receivedAt: brief.receivedAt,
        source: brief.source || 'harness',
        verdict: report.verdict,
        coverage: coverageOf(brief),
      });
    } catch {
      /* Битая запись не должна прятать остальные задания. */
    }
  });
  return items.sort((a, b) => String(b.updatedAt || b.receivedAt || '').localeCompare(String(a.updatedAt || a.receivedAt || '')));
}

/** Полный реестр + вердикт: страница показывает и то, и другое. */
export function briefDetail(id) {
  const brief = readBriefRaw(id);
  if (!brief) return null;
  const report = validateBrief(brief);
  return {
    brief,
    verdict: report.verdict,
    coverage: report.coverage,
    issues: report.issues,
    markdown: renderBriefMarkdown(brief),
  };
}
