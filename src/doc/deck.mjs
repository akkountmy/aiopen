/* ==========================================================================
   deck.mjs — дизайнерский дек DSH.OPEN.WEB
   Берёт ту же систему слайдов, что навык deck-design (1600×900, палитры
   gold/graphite/cobalt, Montserrat + Oswald), собирает самостоятельный HTML и
   печатает его в PDF тем же браузером, что и остальные документы.
   Почему HTML, а не pptxgenjs: дисплейная типографика, кривые, наслоения и
   виньетка в PowerPoint не переносятся. Кому нужен редактируемый файл —
   create_pptx рядом, это два разных результата и так и надо говорить.
   ========================================================================== */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { printHtml } from '../browser.mjs';

const ASSETS = new URL('../../assets/deck/', import.meta.url);
const THEMES = new Set(['gold', 'graphite', 'cobalt']);
const LAYOUTS = new Set(['cover', 'rows', 'steps', 'list', 'kpi', 'quote', 'section', 'closing']);
const MAX_SLIDES = 40;
/* Вместимость макетов на поле 1600×900 — посчитана по рендеру, а не на глаз:
   пятая строка реестра уезжает под нижнее поле, шестой тезис наезжает на номер
   страницы. Лишнее отбрасываем и говорим об этом в warnings, а не молчим. */
const CAPACITY = { rows: 4, steps: 4, list: 5, kpi: 4 };

/* 1600×900 CSS px → мм для Page.printToPDF: 1 px = 1/96 in = 25.4/96 мм. */
export const PAGE_MM = {
  width: Math.round((1600 * 25.4 / 96) * 1000) / 1000,
  height: Math.round((900 * 25.4 / 96) * 1000) / 1000,
};

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* **акцент** → <em>акцент</em>, перенос строки → <br>. Остальное экранируется. */
function rich(value) {
  return esc(value)
    .replace(/\*\*([^*]+)\*\*/g, '<em>$1</em>')
    .replace(/\r?\n/g, '<br>');
}

function text(value, limit = 400) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function list(value, limit) {
  return Array.isArray(value) ? value.filter((item) => item !== null && item !== undefined).slice(0, limit) : [];
}

/* —— CSS один раз на процесс: 553 КБ шрифтов превращаются в base64 один раз —— */
let cssCache = '';

function deckCss() {
  if (cssCache) return cssCache;
  const fontsDir = new URL('fonts/', ASSETS);
  let fonts = fs.readFileSync(new URL('fonts.css', fontsDir), 'utf8');
  fonts = fonts.replace(/url\(([^)]+\.woff2)\)/g, (all, name) => {
    try {
      const data = fs.readFileSync(fileURLToPath(new URL(path.basename(name.trim()), fontsDir))).toString('base64');
      return `url(data:font/woff2;base64,${data})`;
    } catch {
      return all;
    }
  });
  const base = fs.readFileSync(new URL('deck.css', ASSETS), 'utf8');
  const extra = fs.readFileSync(new URL('deck-extra.css', ASSETS), 'utf8');
  cssCache = `${base}\n${extra}\n${fonts}`;
  return cssCache;
}

function pageNumber(index, total) {
  return `${String(index).padStart(2, '0')} / ${String(total).padStart(2, '0')}`;
}

function footers(slide, index, total, opts, dark = false) {
  const note = text(slide.footnote || opts.footerText || '', 120);
  const number = opts.pageNumbers === false || index === 1 ? '' : pageNumber(index, total);
  const parts = [];
  if (note) parts.push(`<div class="footnote${dark ? ' dark' : ''}">${esc(note)}</div>`);
  if (number) parts.push(`<div class="pageno${dark ? ' dark' : ''}">${esc(number)}</div>`);
  return parts.join('');
}

function bullets(items) {
  const rows = list(items, CAPACITY.list).map((item, i) => {
    const row = item && typeof item === 'object' ? item : { title: item };
    const n = String(i + 1).padStart(2, '0');
    const title = row.title || row.name || '';
    const detail = row.text || row.description || row.detail || '';
    return `<div class="item"><div class="n">${n}</div><div>` +
      (title ? `<div class="t">${rich(title)}</div>` : '') +
      (detail ? `<div class="d">${rich(detail)}</div>` : '') +
      '</div></div>';
  }).join('');
  return rows ? `<div class="items">${rows}</div>` : '';
}

function slideCover(slide, ctx) {
  const action = slide.action || slide.pill || '';
  const lines = String(slide.title || '').split(/\r?\n/).filter(Boolean);
  const first = text(lines[0] || slide.title || 'Презентация', 40);
  const second = text(lines[1] || '', 22);
  const kicker = text(slide.kicker || ctx.kicker || '', 60);
  const lead = text(slide.subtitle || slide.lead || ctx.subtitle || '', 320);
  const tag = text(slide.tag || '', 48);
  const items = list(slide.items, 3);
  const thumbs = items.map((item, i) => {
    const data = item && typeof item === 'object' ? item : { caption: item };
    const label = text(data.label || String(i + 1).padStart(2, '0'), 4);
    const caption = text(data.caption || '', 24);
    return `<div class="thumb${i === 0 ? ' active' : ''}"><div class="box">${esc(label)}</div>` +
      (caption ? `<div class="cap">${esc(caption)}</div>` : '') + '</div>';
  }).join('');

  return `<section class="slide">
  <div class="cover-accent"><div class="sheen"></div></div>
  <svg class="blade" width="1600" height="900" viewBox="0 0 1600 900" preserveAspectRatio="none">
    <defs>
      <linearGradient id="bk" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" style="stop-color:var(--bg-2)"/>
        <stop offset="0.55" style="stop-color:var(--bg)"/>
        <stop offset="1" style="stop-color:var(--bg)"/>
      </linearGradient>
    </defs>
    <path fill="url(#bk)" d="M0,0 L872,0 C 1006,128 1152,236 1104,424 C 1058,606 872,668 906,900 L0,900 Z"/>
  </svg>
  <div class="vignette"></div>
  <div class="cover-copy">
    ${kicker ? `<div class="kicker">${esc(kicker)}</div>` : ''}
    <h1 class="h1" style="margin-top:26px">
      <span class="l1"><span>${esc(first)}</span><em></em></span>
      ${second ? `<span class="l2">${esc(second)}</span>` : ''}
    </h1>
    ${lead ? `<p class="lead">${rich(lead)}</p>` : ''}
    ${action ? `<div class="pill"><b>${esc(action)}</b><span style="font-size:16px">→</span></div>` : ''}
  </div>
  <div class="contact"></div>
  <div class="specimen">
    <span class="big">Aa</span>
    ${tag ? `<span class="tag">${esc(tag)}</span>` : ''}
  </div>
  ${thumbs ? `<div class="thumbs">${thumbs}</div>` : ''}
</section>`;
}

function slideRows(slide, ctx, index, total) {
  const badge = slide.badge && typeof slide.badge === 'object' ? slide.badge : null;
  const rows = list(slide.rows || slide.table, CAPACITY.rows).map((row, i) => {
    const data = row && typeof row === 'object' ? row : { name: row };
    const cells = Array.isArray(data.cells) ? data.cells : null;
    const name = text(cells ? cells[0] : data.name || data.title || '', 60);
    const what = text(cells ? cells.slice(1, -1).join(' ') : data.text || data.what || data.description || '', 260);
    const meta = text(cells ? cells[cells.length - 1] : data.meta || data.tag || '', 26);
    const n = text(data.n || String(i + 1).padStart(2, '0'), 4);
    return `<div class="row"><div class="n">${esc(n)}</div><div class="name">${esc(name)}</div>` +
      `<div class="what">${rich(what)}</div><div class="meta">${esc(meta)}</div></div>`;
  }).join('');

  return `<section class="slide">
  <div class="sheet"></div>
  <div class="vignette"></div>
  <div class="claim">
    ${slide.kicker ? `<div class="kicker">${esc(text(slide.kicker, 60))}</div>` : ''}
    <h2 class="h" style="margin-top:22px">${rich(slide.title || '')}</h2>
    ${slide.lead || slide.subtitle ? `<p class="lead">${rich(text(slide.lead || slide.subtitle, 320))}</p>` : ''}
  </div>
  ${badge ? `<div class="badge"><div class="num">${esc(text(badge.value || badge.num || '', 12))}</div>` +
    `<div class="txt">${esc(text(badge.label || badge.text || '', 120))}</div></div>` : ''}
  ${rows ? `<div class="grid">${rows}</div>` : ''}
  ${footers(slide, index, total, ctx)}
</section>`;
}

function slideSteps(slide, ctx, index, total) {
  const steps = list(slide.steps || slide.items, CAPACITY.steps).map((step, i) => {
    const data = step && typeof step === 'object' ? step : { title: step };
    const num = text(data.num || String(i + 1).padStart(2, '0'), 4);
    return `<div class="step"><div><div class="num">${esc(num)}</div>` +
      `<div class="t">${rich(text(data.title || data.name || '', 60))}</div>` +
      `<div class="d">${rich(text(data.text || data.description || '', 160))}</div></div>` +
      (data.meta ? `<div class="meta">${esc(text(data.meta, 30))}</div>` : '') +
      '</div>';
  }).join('');
  const metaCount = list(slide.steps || slide.items, CAPACITY.steps).filter((step) => step && typeof step === 'object' && step.meta).length;
  const count = Math.max(1, list(slide.steps || slide.items, CAPACITY.steps).length);
  return `<section class="slide">
  <div class="accent-slide"></div>
  <div class="accent-inner">
    ${slide.kicker ? `<div class="k">${esc(text(slide.kicker, 60))}</div>` : ''}
    <h2>${rich(slide.title || '')}</h2>
    ${steps ? `<div class="steps${metaCount ? '' : ' no-meta'}" style="grid-template-columns:repeat(${count},1fr)">${steps}</div>` : ''}
  </div>
  ${footers(slide, index, total, ctx, true)}
</section>`;
}

function slideList(slide, ctx, index, total) {
  return `<section class="slide">
  <div class="sheet"></div>
  <div class="vignette"></div>
  <div class="list">
    ${slide.kicker ? `<div class="kicker">${esc(text(slide.kicker, 60))}</div>` : ''}
    ${slide.title ? `<h2 class="h" style="margin-top:20px">${rich(slide.title)}</h2>` : ''}
    ${bullets(slide.bullets || slide.items)}
  </div>
  ${footers(slide, index, total, ctx)}
</section>`;
}

function slideKpi(slide, ctx, index, total) {
  const cells = list(slide.kpi, CAPACITY.kpi);
  const grid = cells.length
    ? `<div class="kpi" style="grid-template-columns:repeat(${cells.length},1fr)">` +
      cells.map((cell) => {
        const data = cell && typeof cell === 'object' ? cell : { value: cell };
        return `<div class="cell"><div class="v">${esc(text(data.value, 14))}</div>` +
          `<div class="l">${rich(text(data.label || data.text || '', 160))}</div></div>`;
      }).join('') + '</div>'
    : '';
  return `<section class="slide">
  <div class="sheet"></div>
  <div class="vignette"></div>
  <div class="claim">
    ${slide.kicker ? `<div class="kicker">${esc(text(slide.kicker, 60))}</div>` : ''}
    <h2 class="h" style="margin-top:22px">${rich(slide.title || '')}</h2>
    ${slide.lead || slide.subtitle ? `<p class="lead">${rich(text(slide.lead || slide.subtitle, 320))}</p>` : ''}
  </div>
  ${grid}
  ${footers(slide, index, total, ctx)}
</section>`;
}

function slideQuote(slide, ctx, index, total) {
  const quote = text(slide.quote || slide.text || slide.title || '', 420);
  const who = text(slide.author || slide.who || '', 80);
  return `<section class="slide">
  <div class="sheet"></div>
  <div class="vignette"></div>
  <div class="quote">
    <div class="q">${rich(quote)}</div>
    ${who ? `<div class="who"><i></i><span>${esc(who)}</span></div>` : ''}
  </div>
  ${footers(slide, index, total, ctx)}
</section>`;
}

function slideSection(slide, ctx, index, total) {
  const num = text(slide.num || '', 3);
  return `<section class="slide">
  <div class="section"></div>
  <div class="section-body">
    ${slide.kicker ? `<div class="kicker">${esc(text(slide.kicker, 60))}</div>` : ''}
    ${num ? `<div class="num" style="margin-top:26px">${esc(num)}</div>` : ''}
    <h2>${rich(slide.title || '')}</h2>
    ${slide.lead || slide.subtitle ? `<p class="lead">${rich(text(slide.lead || slide.subtitle, 320))}</p>` : ''}
  </div>
  ${footers(slide, index, total, ctx)}
</section>`;
}

function slideClosing(slide) {
  const action = slide.action || slide.pill || '';
  return `<section class="slide">
  <div class="closing"></div>
  <div class="closing-body">
    ${slide.kicker ? `<div class="k">${esc(text(slide.kicker, 60))}</div>` : ''}
    <h2>${rich(slide.title || '')}</h2>
    ${slide.lead || slide.subtitle ? `<p class="lead">${rich(text(slide.lead || slide.subtitle, 320))}</p>` : ''}
    ${action ? `<div class="pill"><b>${esc(action)}</b><span style="font-size:16px">→</span></div>` : ''}
  </div>
</section>`;
}

/* Что именно переполняется в каждом макете: по этому списку считаем потери. */
const CAPACITY_SOURCE = {
  rows: (slide) => slide.rows || slide.table,
  steps: (slide) => slide.steps || slide.items,
  list: (slide) => slide.bullets || slide.items,
  kpi: (slide) => slide.kpi,
};

/** Нормализует слайды: чинит неизвестные layout'ы и не даёт собрать пустой дек. */
export function normalizeDeck(spec = {}) {
  const theme = THEMES.has(String(spec.theme || '')) ? String(spec.theme) : 'gold';
  const slides = list(spec.slides, MAX_SLIDES).map((raw) => {
    const slide = raw && typeof raw === 'object' ? { ...raw } : { title: String(raw ?? '') };
    const layout = LAYOUTS.has(String(slide.layout || '')) ? String(slide.layout) : 'list';
    return { ...slide, layout };
  });
  const warnings = [];
  slides.forEach((slide, i) => {
    const source = CAPACITY_SOURCE[slide.layout];
    const limit = CAPACITY[slide.layout];
    if (!source || !limit) return;
    const items = source(slide);
    const count = Array.isArray(items) ? items.length : 0;
    if (count > limit) warnings.push(`Слайд ${i + 1} (${slide.layout}): помещается ${limit}, не вошло ${count - limit}`);
  });
  if (list(spec.slides, MAX_SLIDES + 1).length > MAX_SLIDES) {
    warnings.push(`В деке больше ${MAX_SLIDES} слайдов — лишние не вошли`);
  }
  const ctx = {
    kicker: text(spec.kicker, 60),
    subtitle: text(spec.subtitle, 320),
    footerText: text(spec.footerText, 120),
    pageNumbers: spec.pageNumbers !== false,
  };
  return { theme, slides, ctx, title: text(spec.title, 160), warnings };
}

/** Самостоятельный HTML дека: CSS и шрифты внутри, внешних файлов нет. */
export function deckHtml(spec = {}) {
  const { theme, slides, ctx, title } = normalizeDeck(spec);
  const total = slides.length;
  const body = slides.map((slide, i) => {
    const index = i + 1;
    switch (slide.layout) {
      case 'cover': return slideCover(slide, ctx);
      case 'rows': return slideRows(slide, ctx, index, total);
      case 'steps': return slideSteps(slide, ctx, index, total);
      case 'kpi': return slideKpi(slide, ctx, index, total);
      case 'quote': return slideQuote(slide, ctx, index, total);
      case 'section': return slideSection(slide, ctx, index, total);
      case 'closing': return slideClosing(slide);
      default: return slideList(slide, ctx, index, total);
    }
  }).join('\n');

  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
<title>${esc(title || 'Презентация')}</title>
<meta name="generator" content="dsh-open-web/deck">
<style>${deckCss()}</style>
</head>
<body data-theme="${theme}">
${body}
</body>
</html>`;
}

/**
 * Замер раскладки в браузере до печати: текст за полем, наложение блоков,
 * не подгрузившийся шрифт. Считаем геометрию, а не смотрим на глаз — иначе
 * переполнившийся макет уезжает в PDF молча.
 * Функция исполняется в странице, поэтому не ссылается ни на что снаружи.
 */
function deckLayoutProbe() {
  const issues = [];
  const slides = Array.from(document.querySelectorAll('.slide'));
  const add = (index, kind, text, detail) => issues.push({ slide: index + 1, kind, text, detail });
  const near = (a, b) => Math.abs(a - b) <= 0.5;

  slides.forEach((slide, index) => {
    const box = slide.getBoundingClientRect();
    if (slide.scrollHeight > slide.clientHeight + 1) {
      add(index, 'overflow', '', `содержимое выше поля на ${Math.round(slide.scrollHeight - slide.clientHeight)} px`);
    }

    const blocks = [];
    slide.querySelectorAll('*').forEach((el) => {
      const tag = el.tagName;
      if (tag === 'BR' || tag === 'STYLE' || tag === 'SCRIPT' || tag === 'svg' || tag === 'path') return;
      const ownText = Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.textContent.trim());
      /* Чистый контейнер без своего текста не меряем: его рамка — это рамка детей. */
      if (!ownText && el.children.length) return;
      const label = (el.textContent || '').trim();
      if (!label) return;
      const rect = el.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) return;
      if (near(rect.width, box.width) && near(rect.height, box.height)) return;
      blocks.push({ el, rect, label: label.slice(0, 26) });
    });

    blocks.forEach(({ rect, label }) => {
      const outside =
        rect.left < box.left - 0.5 || rect.top < box.top - 0.5 ||
        rect.right > box.right + 0.5 || rect.bottom > box.bottom + 0.5;
      if (outside) add(index, 'outside', label, 'текст выходит за поле слайда');
    });

    for (let i = 0; i < blocks.length; i += 1) {
      for (let j = i + 1; j < blocks.length; j += 1) {
        const a = blocks[i];
        const b = blocks[j];
        if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
        const ox = Math.min(a.rect.right, b.rect.right) - Math.max(a.rect.left, b.rect.left);
        const oy = Math.min(a.rect.bottom, b.rect.bottom) - Math.max(a.rect.top, b.rect.top);
        if (ox <= 1 || oy <= 1) continue;
        const smaller = Math.min(a.rect.width * a.rect.height, b.rect.width * b.rect.height) || 1;
        if ((ox * oy) / smaller < 0.25) continue;
        add(index, 'overlap', `${a.label} / ${b.label}`, 'блоки наложились друг на друга');
        break;
      }
    }
  });

  const fonts = [];
  try {
    const probe = document.createElement('span');
    probe.style.fontFamily = 'Montserrat';
    probe.style.position = 'absolute';
    probe.style.opacity = '0';
    probe.textContent = 'Aa';
    document.body.appendChild(probe);
    if (!document.fonts || !document.fonts.check('16px Montserrat')) fonts.push('Montserrat');
    if (!document.fonts || !document.fonts.check('16px Oswald')) fonts.push('Oswald');
    probe.remove();
  } catch {
    /* проверка шрифтов необязательна: сам факт отсутствия document.fonts не дефект */
  }

  return { slides: slides.length, issues, missingFonts: fonts };
}

/**
 * Печатает деку в PDF. Возвращает готовый буфер и путь к нему.
 * Браузер — тот же каскад, что у проверки страниц (Chrome → Edge → Chromium),
 * поэтому на Amvera дек печатается без Playwright-браузера.
 */
export async function makeDeckPdf(spec = {}, options = {}) {
  const html = deckHtml(spec);
  const dir = options.dir || fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-deck-'));
  fs.mkdirSync(dir, { recursive: true });
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const htmlPath = path.join(dir, `deck-${stamp}.html`);
  const pdfPath = options.pdfPath || path.join(dir, `deck-${stamp}.pdf`);
  fs.writeFileSync(htmlPath, html, 'utf8');
  try {
    const result = await printHtml({
      file: htmlPath,
      pdfPath,
      width: 1600,
      height: 900,
      pageSize: { width: PAGE_MM.width, height: PAGE_MM.height },
      settleMs: 500,
      timeoutMs: options.timeoutMs,
      probe: ({ page }) => page.evaluate(deckLayoutProbe),
    });
    if (!result.pdf || !fs.existsSync(result.pdf)) throw new Error('браузер не напечатал PDF деки');
    const buffer = fs.readFileSync(result.pdf);
    if (!buffer.length) throw new Error('браузер вернул пустой PDF деки');
    return {
      buffer,
      engine: result.engine,
      pdfPath: result.pdf,
      slideCount: normalizeDeck(spec).slides.length,
      warnings: normalizeDeck(spec).warnings,
      layout: layoutReport(result),
    };
  } finally {
    if (!options.keepHtml) fs.rmSync(htmlPath, { force: true });
  }
}

/** Одна строка на замечание: номер слайда, что именно и где. */
function layoutIssueText(issue) {
  const where = issue.text ? `«${issue.text}»` : '';
  const parts = [issue.detail, where].filter(Boolean).join(': ');
  return `слайд ${issue.slide} — ${parts || 'замечание раскладки'}`;
}

/** Отчёт раскладки из пробы браузера: ok только когда замечаний нет. */
function layoutReport(result) {
  const probe = result && result.probe;
  if (!probe) {
    return { ok: null, issues: [], missingFonts: [], note: (result && result.probeError) || 'замер раскладки не выполнен' };
  }
  const issues = (Array.isArray(probe.issues) ? probe.issues : []).map(layoutIssueText);
  const missingFonts = Array.isArray(probe.missingFonts) ? probe.missingFonts : [];
  return { ok: issues.length === 0 && missingFonts.length === 0, issues, missingFonts, note: '' };
}

export const DECK_LAYOUTS = [...LAYOUTS];
export const DECK_THEMES = [...THEMES];
