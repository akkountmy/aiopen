/**
 * Дизайн-проект и 3D-сцена проекта — из одного правленого спека.
 *
 * Человек просит «сделай дизайн студии 40 квадратов» и ждёт не текст, а листы:
 * план мебели, план полов, план потолка со светильниками, аксонометрию и
 * объёмную сцену, которую можно покрутить. Всё это уже умеет навык
 * `interior-drawings`, но его скрипты запускаются оболочкой, а у агента сервиса
 * оболочки нет: инструменты — только файлы, расчёт и песочница JavaScript.
 * Поэтому модель честно не могла ничего начертить и отвечала «Готово.» без
 * единого файла (живой случай 06.11.2026, проект «Дизайн студии»).
 *
 * Здесь эта дырка закрыта с другой стороны: сервер сам запускает генераторы
 * навыка из спека `design.json`, лежащего в корне проекта. Спек — единственный
 * источник правды: правишь его в окне проекта или просишь агента, и все листы
 * пересобираются. Правка не стоит токенов и не ждёт модель.
 *
 * Решение сознательно детерминированное: ни одна буква на листах не приходит от
 * языковой модели, поэтому «Готово.» с пустой папкой здесь невозможно — либо
 * файлы есть и у них ненулевой размер, либо в ответе стоит причина.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SCRIPTS = path.join(ROOT, 'skills', 'interior-drawings', 'scripts');

/** Спек лежит в корне проекта: его видно в «Файлах проекта» и можно прислать файлом. */
export const SPEC_FILE = 'design.json';
/** Все листы — в папку `design/`, чтобы корень проекта оставался про дело. */
export const OUT_DIR = 'design';

/**
 * Что собираем из спека. `file` — путь внутри проекта, `title` — подпись в окне
 * проекта. Порядок — порядок вкладок: сверху то, что человек ждёт увидеть первым.
 */
export const ARTIFACTS = [
  { key: 'render', title: 'Визуализация', file: `${OUT_DIR}/render.png`, script: 'visual.mjs', args: [], kind: 'png' },
  { key: 'style', title: 'Палитра и материалы', file: `${OUT_DIR}/style.svg`, script: 'style.mjs', args: [], kind: 'svg' },
  { key: 'scene', title: '3D-сцена', file: `${OUT_DIR}/3d.html`, script: 'scene.mjs', args: [], kind: 'html' },
  { key: 'plan', title: 'План мебели', file: `${OUT_DIR}/plan.svg`, script: 'plan.mjs', args: ['--mode=plan'], kind: 'svg' },
  { key: 'floor', title: 'План полов', file: `${OUT_DIR}/floor.svg`, script: 'plan.mjs', args: ['--mode=floor'], kind: 'svg' },
  { key: 'ceiling', title: 'План потолка', file: `${OUT_DIR}/ceiling.svg`, script: 'plan.mjs', args: ['--mode=ceiling'], kind: 'svg' },
  { key: 'axo', title: 'Аксонометрия', file: `${OUT_DIR}/axo.svg`, script: 'axo.mjs', args: [], kind: 'svg' },
];

/**
 * Палитра — не украшение, а контракт между референсом, листами и 3D. Ключи
 * короткие: их видят и модель, и скрипты. Если референс не разобран, остаётся
 * спокойная нейтральная база, а поле `source` честно говорит, откуда цвета.
 */
export const STYLE_DEFAULTS = {
  name: 'Современный нейтральный',
  palette: {
    wall: '#E8E1D5',
    ceiling: '#F7F4EE',
    floor: '#C9A87C',
    accent: '#B5654A',
    textile: '#8C8577',
    wood: '#B98A5A',
    metal: '#9A9A96',
    stone: '#D8D2C6',
  },
  materials: {
    floor: 'инженерная доска, матовый лак',
    walls: 'матовая краска, микроцемент',
    ceiling: 'натяжной, сатин',
    fronts: 'шпон дуба, брашированный',
    textile: 'рогожка, лён',
    metal: 'брашированная сталь, чёрный металл',
  },
  lighting: { mood: 'тёплый вечерний свет, 2700 K', kelvin: 2700 },
  decor: [],
};

const PALETTE_KEYS = Object.keys(STYLE_DEFAULTS.palette);
const MATERIAL_KEYS = Object.keys(STYLE_DEFAULTS.materials);

function hexColor(value) {
  const match = String(value ?? '').trim().match(/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (!match) return '';
  let hex = match[1];
  if (hex.length === 3) hex = hex.split('').map((ch) => ch + ch).join('');
  return `#${hex.toUpperCase()}`;
}

function colorList(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  for (const key of PALETTE_KEYS) {
    const value = hexColor(raw[key] || raw[`${key}Color`] || raw[`${key}_color`]);
    if (value) out[key] = value;
  }
  return out;
}

/**
 * Приводит блок `style` к предсказуемому виду. Модель может прислать строку
 * вместо имени, `colors` вместо `palette`, материалы списком — всё это
 * принимаем, но наружу отдаём одну форму, на которую опираются генераторы.
 */
export function normalizeStyle(raw, fixes = []) {
  if (!raw) return null;
  if (typeof raw === 'string') return { ...STYLE_DEFAULTS, palette: { ...STYLE_DEFAULTS.palette }, materials: { ...STYLE_DEFAULTS.materials }, lighting: { ...STYLE_DEFAULTS.lighting }, decor: [], name: text(raw, 80) };
  if (typeof raw !== 'object' || Array.isArray(raw)) return null;

  const style = {
    name: text(raw.name || raw.style || raw.title, 80) || STYLE_DEFAULTS.name,
    palette: { ...STYLE_DEFAULTS.palette },
    materials: { ...STYLE_DEFAULTS.materials },
    lighting: { ...STYLE_DEFAULTS.lighting },
    decor: [],
  };

  const palette = colorList(raw.palette || raw.colors || raw.palette_hex || raw);
  for (const [key, value] of Object.entries(palette)) style.palette[key] = value;
  if (raw.palette && typeof raw.palette === 'object') {
    for (const key of PALETTE_KEYS) {
      if (raw.palette[key] && !palette[key]) fixes.push(`цвет «${key}» не распознан: нужен HEX`);
    }
  }

  const materials = raw.materials || raw.finishes || {};
  if (typeof materials === 'string') {
    style.materials.floor = text(materials, 120);
  } else if (materials && typeof materials === 'object') {
    for (const key of MATERIAL_KEYS) {
      const value = text(materials[key], 120);
      if (value) style.materials[key] = value;
    }
  }

  const lighting = raw.lighting || raw.light || {};
  if (typeof lighting === 'string') {
    style.lighting.mood = text(lighting, 160);
  } else if (lighting && typeof lighting === 'object') {
    if (text(lighting.mood || lighting.summary, 160)) style.lighting.mood = text(lighting.mood || lighting.summary, 160);
    const kelvin = optNumber(lighting.kelvin || lighting.temperature);
    if (kelvin && kelvin >= 1800 && kelvin <= 6500) style.lighting.kelvin = Math.round(kelvin);
    const layers = Array.isArray(lighting.layers) ? lighting.layers : [];
    if (layers.length) style.lighting.layers = layers.map((item) => text(item, 100)).filter(Boolean).slice(0, 6);
  }

  const decor = Array.isArray(raw.decor) ? raw.decor : Array.isArray(raw.decoration) ? raw.decoration : [];
  style.decor = decor.map((item) => text(item, 100)).filter(Boolean).slice(0, 12);
  if (text(raw.summary || raw.concept, 300)) style.summary = text(raw.summary || raw.concept, 300);
  if (text(raw.reference || raw.source, 300)) style.reference = text(raw.reference || raw.source, 300);
  if (text(raw.referenceName || raw.sourceName, 120)) style.referenceName = text(raw.referenceName || raw.sourceName, 120);
  const decisions = Array.isArray(raw.decisions) ? raw.decisions : [];
  if (decisions.length) style.decisions = decisions.map((item) => text(item, 160)).filter(Boolean).slice(0, 8);
  const avoid = Array.isArray(raw.avoid) ? raw.avoid : [];
  if (avoid.length) style.avoid = avoid.map((item) => text(item, 100)).filter(Boolean).slice(0, 8);
  if (text(raw.source, 40)) style.source = text(raw.source, 40);
  return style;
}

/**
 * Разбор ответа vision-модели. Основной путь — JSON, но модель иногда
 * заворачивает его в пояснения или присылает список «стены — #hex». Тогда
 * вытаскиваем цвета по ключевым словам, чтобы референс всё равно дошёл до
 * листов, а не остался красивым описанием в чате.
 */
export function styleFromVision(text) {
  const source = String(text || '');
  const start = source.indexOf('{');
  const end = source.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      const parsed = JSON.parse(source.slice(start, end + 1));
      const style = normalizeStyle({ ...parsed, source: 'reference' });
      const colors = Object.values(style?.palette || {}).filter(Boolean).length;
      if (style && colors >= 4) return style;
    } catch {
      /* ниже — разбор по строкам */
    }
  }
  const aliases = {
    wall: ['wall', 'стен', 'walls'],
    ceiling: ['ceiling', 'потол'],
    floor: ['floor', 'пол'],
    accent: ['accent', 'акцент'],
    textile: ['textile', 'текстил', 'ткан'],
    wood: ['wood', 'дерев', 'дуб'],
    metal: ['metal', 'металл'],
    stone: ['stone', 'камен', 'мрамор'],
  };
  const palette = {};
  for (const [key, words] of Object.entries(aliases)) {
    for (const word of words) {
      const regex = new RegExp(`${word}[^#\\n]{0,60}(#[0-9a-f]{3,6})`, 'iu');
      const match = source.match(regex);
      if (match) {
        palette[key] = hexColor(match[1]);
        break;
      }
    }
  }
  if (Object.keys(palette).length < 3) return null;
  const line = source.split('\n').map((item) => item.replace(/^[\s#>*\-–—]+/, '').trim()).find((item) => item && !/#[0-9a-f]{3,6}/i.test(item));
  return normalizeStyle({
    name: line ? line.slice(0, 60) : 'Стиль по референсу',
    palette,
    source: 'reference',
  });
}

/** Слияние: явные поля нового блока важнее, недостающее берём из старого. */
export function mergeStyle(base, patch) {
  if (!patch) return base || null;
  if (!base) return normalizeStyle(patch);
  const merged = normalizeStyle({
    ...base,
    ...patch,
    palette: { ...(base.palette || {}), ...(patch.palette || {}) },
    materials: { ...(base.materials || {}), ...(patch.materials || {}) },
    lighting: { ...(base.lighting || {}), ...(patch.lighting || {}) },
    decor: patch.decor && patch.decor.length ? patch.decor : base.decor,
  });
  return merged;
}

/* Потолки по количеству объектов: спек приходит от модели и от человека, а
   генератор рисует всё, что ему дали. Больше — не проект комнаты, а свалка,
   которая съест память контейнера (500 МБ на весь сервис). */
const LIMITS = {
  rooms: 40,
  walls: 200,
  openings: 300,
  furniture: 800,
  lighting: 600,
  notes: 40,
  points: 600,
  scriptMs: 90_000,
  totalMs: 240_000,
  specBytes: 1_500_000,
};

const PAPER = new Set(['A4', 'A3', 'A2', 'A1', 'A0']);

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function optNumber(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const number = Number(String(value).replace(',', '.'));
  return Number.isFinite(number) ? number : undefined;
}

function text(value, limit = 160) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit);
}

/** Площадь полигона комнаты по формуле шнуровки, м². */
function polyArea(poly) {
  let sum = 0;
  for (let i = 0; i < poly.length; i += 1) {
    const [x1, y1] = poly[i];
    const [x2, y2] = poly[(i + 1) % poly.length];
    sum += x1 * y2 - x2 * y1;
  }
  return Math.abs(sum) / 2 / 1_000_000;
}

/**
 * Привести спек к тому виду, который понимают генераторы, и заодно объяснить
 * модели, что именно было не так: тихая «починка» без списка правок научила бы
 * её присылать мусор и дальше.
 */
export function normalizeSpec(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Спек дизайна — это JSON-объект: комнаты, стены, проёмы, мебель, высоты.');
  }
  const fixes = [];

  const walls = [];
  for (const wall of Array.isArray(raw.walls) ? raw.walls.slice(0, LIMITS.walls) : []) {
    if (!wall || typeof wall !== 'object') continue;
    const x1 = optNumber(wall.x1);
    const y1 = optNumber(wall.y1);
    const x2 = optNumber(wall.x2);
    const y2 = optNumber(wall.y2);
    if (x1 === undefined || y1 === undefined || x2 === undefined || y2 === undefined) continue;
    if (x1 === x2 && y1 === y2) continue;
    walls.push({ x1, y1, x2, y2, t: Math.max(10, optNumber(wall.t) ?? 100) });
  }

  const points = (poly) => {
    if (!Array.isArray(poly)) return [];
    const out = [];
    for (const point of poly.slice(0, LIMITS.points)) {
      if (Array.isArray(point) && point.length >= 2) {
        const x = optNumber(point[0]);
        const y = optNumber(point[1]);
        if (x !== undefined && y !== undefined) out.push([x, y]);
      } else if (point && typeof point === 'object') {
        const x = optNumber(point.x);
        const y = optNumber(point.y);
        if (x !== undefined && y !== undefined) out.push([x, y]);
      }
    }
    return out;
  };

  const rooms = [];
  for (const room of Array.isArray(raw.rooms) ? raw.rooms.slice(0, LIMITS.rooms) : []) {
    if (!room || typeof room !== 'object') continue;
    const poly = points(room.poly || room.points || room.polygon);
    if (poly.length < 3) {
      fixes.push(`комната «${text(room.name) || '?'}» пропущена: полигон меньше трёх точек`);
      continue;
    }
    const item = {
      name: text(room.name) || `Комната ${rooms.length + 1}`,
      poly,
      floor: text(room.floor) || 'ламинат 33 кл.',
    };
    const tile = optNumber(room.tile);
    if (tile && tile > 0) item.tile = tile;
    if (text(room.ceiling)) item.ceiling = text(room.ceiling);
    rooms.push(item);
  }

  const openings = [];
  for (const opening of Array.isArray(raw.openings) ? raw.openings.slice(0, LIMITS.openings) : []) {
    if (!opening || typeof opening !== 'object') continue;
    const x = optNumber(opening.x);
    const y = optNumber(opening.y);
    const w = optNumber(opening.w);
    if (x === undefined || y === undefined || !w || w <= 0) continue;
    const kind = /door|двер/i.test(String(opening.kind)) ? 'door' : 'window';
    const dir = String(opening.dir || '').toLowerCase().startsWith('v') ? 'v' : 'h';
    const item = { kind, x, y, w, dir };
    const sill = optNumber(opening.sill);
    const height = optNumber(opening.h);
    if (kind === 'window') {
      item.sill = sill ?? 900;
      item.h = height ?? 1500;
    } else {
      item.h = height ?? 2100;
      item.hinge = String(opening.hinge || '').toLowerCase() === 'right' ? 'right' : 'left';
      item.swing = String(opening.swing || '').toLowerCase() === 'out' ? 'out' : 'in';
    }
    openings.push(item);
  }

  const furniture = [];
  for (const piece of Array.isArray(raw.furniture) ? raw.furniture.slice(0, LIMITS.furniture) : []) {
    if (!piece || typeof piece !== 'object') continue;
    const kind = text(piece.kind, 40);
    const x = optNumber(piece.x);
    const y = optNumber(piece.y);
    if (!kind || x === undefined || y === undefined) continue;
    const item = { kind, x, y };
    for (const field of ['w', 'd', 'h', 'rot']) {
      const value = optNumber(piece[field]);
      if (value !== undefined) item[field] = value;
    }
    if (text(piece.name)) item.name = text(piece.name);
    furniture.push(item);
  }

  /* Светильники приходят под тремя именами: в схеме навыка — `fixtures`, в
     примерах — `lighting`. Модель выбирает то, что видела, поэтому принимаем все. */
  const rawLighting = Array.isArray(raw.lighting) ? raw.lighting : Array.isArray(raw.fixtures) ? raw.fixtures : Array.isArray(raw.lights) ? raw.lights : [];
  const lighting = [];
  for (const light of rawLighting.slice(0, LIMITS.lighting)) {
    if (!light || typeof light !== 'object') continue;
    const x = optNumber(light.x);
    const y = optNumber(light.y);
    if (x === undefined || y === undefined) continue;
    const kind = /люстр|chandel/i.test(String(light.kind)) ? 'chandelier' : /лент|led|strip/i.test(String(light.kind)) ? 'led' : 'spot';
    const item = { kind, x, y };
    const w = optNumber(light.w);
    if (w) item.w = w;
    lighting.push(item);
  }

  const heightsIn = raw.heights && typeof raw.heights === 'object' ? raw.heights : {};
  const heights = {
    wall: Math.max(2000, Math.min(6000, optNumber(heightsIn.wall) ?? optNumber(raw.wallHeight) ?? 2700)),
    ceiling: Math.max(1900, Math.min(6000, optNumber(heightsIn.ceiling) ?? optNumber(raw.ceilingHeight) ?? 2650)),
  };

  const paper = String(raw.paper || raw.sheet || 'A3').toUpperCase().replace(/[^A0-9]/g, '');
  const orientation = String(raw.orientation || '').toLowerCase().startsWith('port') ? 'portrait' : 'landscape';
  const scale = optNumber(raw.scale);
  const cut = optNumber(raw.cut);

  const spec = {
    project: text(raw.project, 120) || 'Дизайн-проект',
    object: text(raw.object, 160),
    paper: PAPER.has(paper) ? paper : 'A3',
    orientation,
    heights,
  };
  if (scale && scale >= 10 && scale <= 200) spec.scale = Math.round(scale);
  if (cut && cut > 0) spec.cut = Math.round(cut);
  spec.rooms = rooms;
  spec.walls = walls;
  spec.openings = openings;
  spec.furniture = furniture;
  spec.lighting = lighting;
  const notes = (Array.isArray(raw.notes) ? raw.notes : []).map((note) => text(note, 200)).filter(Boolean).slice(0, LIMITS.notes);
  if (notes.length) spec.notes = notes;
  /* Стиль есть всегда: даже без референса лист «Палитра и материалы» и 3D
     должны получить цельные цвета, а не случайные серые заглушки. */
  spec.style = normalizeStyle(raw.style || raw.moodboard, fixes) || normalizeStyle({ source: 'brief' });

  if (!walls.length) {
    fixes.push('стен нет: нужны контуры помещения (x1,y1 → x2,y2 и толщина t)');
  }
  if (!rooms.length) {
    fixes.push('комнат нет: нужны полигоны комнат — без них не считается площадь и не рисуется пол');
  }
  return { spec, fixes };
}

export function specPath(workspace) {
  return path.join(path.resolve(workspace), SPEC_FILE);
}

/** Спек проекта или null, если дизайна в проекте ещё нет. */
export function readSpec(workspace) {
  const file = specPath(workspace);
  if (!fs.existsSync(file)) return null;
  const raw = fs.readFileSync(file, 'utf8');
  if (raw.length > LIMITS.specBytes) throw new Error('design.json больше 1,5 МБ — это уже не спек, а свалка данных');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`design.json не читается как JSON: ${String(error.message).slice(0, 120)}. Поправьте файл или попросите агента пересобрать спек.`);
  }
  const { spec, fixes } = normalizeSpec(parsed);
  return { spec, fixes, at: fs.statSync(file).mtime.toISOString() };
}

export function writeSpec(workspace, raw) {
  const { spec, fixes } = normalizeSpec(raw);
  if (!spec.walls.length || !spec.rooms.length) {
    throw new Error(`Спек не собран: ${fixes.join('; ')}`);
  }
  const file = specPath(workspace);
  fs.writeFileSync(file, JSON.stringify(spec, null, 2) + '\n', 'utf8');
  return { spec, fixes, bytes: fs.statSync(file).size };
}

/* Один генератор навыка. Запускаем без оболочки (массив аргументов), поэтому
   имена с кириллицей и пробелами не ломаются, а выход за пределы проекта
   невозможен: пути передаёт только этот модуль.

   Вывод генератора забираем файлами, а не трубой: в узком окружении труба
   между процессами запрещена и запуск падает с EPERM — а чертёж нужен и там. */
let scriptSeq = 0;

function runScript(workspace, script, args, timeout) {
  const started = Date.now();
  const base = path.join(os.tmpdir(), `dsh-design-${process.pid}-${process.hrtime.bigint().toString(36)}-${(scriptSeq += 1)}`);
  const outFile = `${base}.out`;
  const errFile = `${base}.err`;
  let outFd = 0;
  let errFd = 0;
  try {
    outFd = fs.openSync(outFile, 'w');
    errFd = fs.openSync(errFile, 'w');
  } catch {
    /* Временного каталога нет — тогда хотя бы не теряем сам запуск. */
    outFd = 'ignore';
    errFd = 'ignore';
  }
  const readOut = (limit) => {
    try {
      const text = fs.existsSync(base + (limit === 'err' ? '.err' : '.out')) ? fs.readFileSync(base + (limit === 'err' ? '.err' : '.out'), 'utf8') : '';
      return text;
    } catch {
      return '';
    }
  };
  const clean = () => {
    for (const fd of [outFd, errFd]) {
      if (typeof fd === 'number') {
        try {
          fs.closeSync(fd);
        } catch {
          /* уже закрыт — не мешает */
        }
      }
    }
    for (const file of [outFile, errFile]) {
      try {
        fs.rmSync(file, { force: true });
      } catch {
        /* временный файл переживёт сборку — не повод падать */
      }
    }
  };
  return new Promise((resolve) => {
    let settled = false;
    let child = null;
    const done = (result) => {
      if (settled) return;
      settled = true;
      const stdout = readOut('out');
      const stderr = readOut('err');
      clean();
      resolve({
        ...result,
        ms: Date.now() - started,
        stdout: stdout.slice(-200_000),
        stderr: stderr.slice(-2000),
      });
    };
    try {
      child = spawn(process.execPath, [path.join(SCRIPTS, script), ...args], {
        cwd: workspace,
        env: { ...process.env, DSH_DESIGN: '1' },
        windowsHide: true,
        stdio: ['ignore', outFd, errFd],
      });
    } catch (error) {
      done({ ok: false, error: `генератор не запустился: ${String(error.message).slice(0, 160)}` });
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* процесс уже умер */
      }
      done({ ok: false, error: `генератор не успел за ${Math.round(timeout / 1000)} с` });
    }, timeout);
    child.on('error', (error) => {
      clearTimeout(timer);
      done({ ok: false, error: `генератор не запустился: ${String(error.message).slice(0, 160)}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        const reason = String(readOut('err')).trim().split('\n').filter(Boolean).slice(-2).join(' ') || `код ${code}`;
        done({ ok: false, error: reason.slice(0, 300) });
        return;
      }
      done({ ok: true });
    });
  });
}

/**
 * Пересобрать листы из спека. Возвращает по каждому листу честный результат:
 * `ok`, размер файла в байтах и время. Нулевой размер считается ошибкой —
 * «файл создан» и «файл пустой» это разные вещи.
 */
export async function buildArtifacts(workspace, { only = null, timeout = LIMITS.scriptMs } = {}) {
  workspace = path.resolve(workspace);
  const specFile = specPath(workspace);
  if (!fs.existsSync(specFile)) {
    throw new Error(`Спека нет: ${SPEC_FILE} должен лежать в корне проекта. Сначала соберите спек (комнаты, стены, проёмы, мебель).`);
  }
  const outDir = path.join(workspace, OUT_DIR);
  fs.mkdirSync(outDir, { recursive: true });
  const wanted = Array.isArray(only) && only.length ? new Set(only.map((key) => String(key))) : null;
  const started = Date.now();
  const results = [];

  for (const artifact of ARTIFACTS) {
    if (wanted && !wanted.has(artifact.key)) continue;
    if (Date.now() - started > LIMITS.totalMs) {
      results.push({ ...artifact, ok: false, error: 'общий предел времени на сборку листов исчерпан' });
      continue;
    }
    const target = path.join(workspace, artifact.file);
    /* Старый лист перед пересборкой убираем: иначе упавший генератор оставил бы
       вчерашний чертёж и человек считал бы, что правка применилась. */
    if (fs.existsSync(target)) fs.rmSync(target, { force: true });
    const run = await runScript(workspace, artifact.script, [specFile, target, ...artifact.args], timeout);
    const bytes = fs.existsSync(target) ? fs.statSync(target).size : 0;
    results.push({
      key: artifact.key,
      title: artifact.title,
      file: artifact.file,
      kind: artifact.kind,
      ok: run.ok && bytes > 0,
      bytes,
      ms: run.ms,
      error: run.ok ? (bytes > 0 ? '' : 'генератор отчитался, но файл пустой') : run.error,
    });
  }
  return results;
}

/** Что уже есть в проекте: спек и листы — для окна проекта и для агента. */
export function designView(workspace) {
  const specFile = specPath(workspace);
  const hasSpec = fs.existsSync(specFile);
  let spec = null;
  let fixes = [];
  let error = '';
  if (hasSpec) {
    try {
      const read = readSpec(workspace);
      spec = read.spec;
      fixes = read.fixes;
    } catch (errorRead) {
      error = String(errorRead.message);
    }
  }
  const artifacts = ARTIFACTS.map((artifact) => {
    const full = path.join(workspace, artifact.file);
    const exists = fs.existsSync(full);
    const stat = exists ? fs.statSync(full) : null;
    return {
      key: artifact.key,
      title: artifact.title,
      file: artifact.file,
      kind: artifact.kind,
      exists: Boolean(stat && stat.size > 0),
      bytes: stat ? stat.size : 0,
      at: stat ? stat.mtime.toISOString() : '',
    };
  });
  return {
    hasSpec,
    specFile: SPEC_FILE,
    spec,
    fixes,
    error,
    artifacts,
    /* «Комнаты» в ответе — жилые, а не все помещения: иначе 4-комнатная
       квартира с кухней-гостиной, коридором и санузлом называлась
       «7 комнат». Отдельно отдаём число помещений для подписи в панели. */
    livingRooms: spec ? livingRoomCount(spec.rooms) : 0,
    spaces: spec ? spec.rooms.length : 0,
    area: spec ? Math.round(spec.rooms.reduce((sum, room) => sum + polyArea(room.poly), 0) * 100) / 100 : 0,
  };
}

/* Жилые комнаты: спальни, детские, кабинеты, гостиные, кухни-гостиные.
   Коридор, прихожая, санузел, балкон и отдельная кухня — помещения, но не
   комнаты в смысле «двухкомнатная квартира». */
const SERVICE_ROOM =
  /^(коридор|прихожая|санузел|ванная|туалет|балкон|лоджия|кладовая|кладовка|гардеробная|техпомещение|котельная|постирочная)/iu;
const KITCHEN_ONLY = /^кухня(?:\s|$|,)/iu;

export function livingRoomCount(rooms = []) {
  return (Array.isArray(rooms) ? rooms : []).filter((room) => {
    const name = String(room?.name || '').trim();
    return name && !SERVICE_ROOM.test(name) && !KITCHEN_ONLY.test(name);
  }).length;
}

/* --------------------- спек из текста задачи (запасной) ---------------------
   Модель может дважды ответить текстом и не вызвать сборку — тогда человек
   остаётся с пустой папкой. Чтобы такого не было никогда, проект собирается
   здесь без модели: из просьбы вытаскиваются площадь, тип помещения, мебель,
   окна и материалы, и по ним раскладывается план. Это запасной путь, а не
   основной: размеры и состав берутся по типовым правилам, поэтому в ответе
   перечисляются принятые допущения. */

/** Площадь из текста: «40 квадратов», «40 м2», «36,5 кв. м». */
function areaFromText(source) {
  const match = String(source).match(/(\d{1,3}(?:[.,]\d)?)\s*(?:м\s*2|м²|м\^2|кв\.?\s*м|квадрат\p{L}*)/iu);
  if (!match) return null;
  const area = Number(match[1].replace(',', '.'));
  return area >= 8 && area <= 300 ? area : null;
}

/**
 * Деталь в координатах комнаты: `(x0,y0)` — левый верхний угол габарита,
 * `fw × fh` — габарит в плане, `rot` — поворот содержимого. Генератор плана
 * ждёт «сырой» прямоугольник до поворота, поэтому пересчитываем размеры и угол.
 */
function piece(kind, x0, y0, fw, fh, rot, name) {
  const cx = x0 + fw / 2;
  const cy = y0 + fh / 2;
  const turned = rot === 90 || rot === 270;
  const w = turned ? fh : fw;
  const d = turned ? fw : fh;
  const item = {
    kind,
    x: Math.round(cx - w / 2),
    y: Math.round(cy - d / 2),
    w: Math.round(w),
    d: Math.round(d),
    rot,
  };
  if (name) item.name = name;
  return item;
}

/**
 * Палитра для запасного спека. Это не «дизайн по шаблону»: если модель не
 * ответила, лучше тёплая цельная база, чем серые заглушки. Выбор читается из
 * брифа, поэтому два разных запроса не получают одинаковую картинку.
 */
function styleFromBrief(source) {
  const s = String(source || '');
  const presets = {
    scandi: {
      name: 'Скандинавский',
      palette: { wall: '#F1EFE9', ceiling: '#FAF9F5', floor: '#D9C3A0', accent: '#7E8C7A', textile: '#C4BEB2', wood: '#C9A97C', metal: '#A8AAA8', stone: '#E1DDD4' },
      materials: { floor: 'светлый дуб, матовое масло', walls: 'матовая краска, тёплый белый', ceiling: 'окрашенный гипсокартон', fronts: 'дуб, шпон', textile: 'лён, рогожка', metal: 'матовый чёрный металл' },
      lighting: { mood: 'дневной рассеянный свет, 3000 K', kelvin: 3000 },
    },
    japandi: {
      name: 'Джапанди',
      palette: { wall: '#E5DFD2', ceiling: '#F4F0E7', floor: '#B98D62', accent: '#5F6657', textile: '#A9A08E', wood: '#A97B4F', metal: '#6E6C65', stone: '#CFC7B8' },
      materials: { floor: 'дуб, брашированный', walls: 'известь, матовая', ceiling: 'штукатурка', fronts: 'дуб, рейка', textile: 'лён, хлопок', metal: 'чернёная сталь' },
      lighting: { mood: 'мягкий тёплый свет, 2700 K', kelvin: 2700 },
    },
    loft: {
      name: 'Современный лофт',
      palette: { wall: '#D8D2C7', ceiling: '#E9E4DA', floor: '#A9825C', accent: '#3F4A45', textile: '#6E6A62', wood: '#8B5E3C', metal: '#4A4A48', stone: '#BEB7AA' },
      materials: { floor: 'инженерная доска, тёмный дуб', walls: 'микроцемент, бетон', ceiling: 'бетон, открытые коммуникации', fronts: 'шпон ореха, металл', textile: 'плотный лён, кожа', metal: 'чернёная сталь' },
      lighting: { mood: 'тёплый акцентный свет, 2700 K', kelvin: 2700 },
    },
    pastel: {
      name: 'Тёплый пастельный',
      palette: { wall: '#EFE1D8', ceiling: '#FBF5EF', floor: '#D6B894', accent: '#C98C7A', textile: '#B9A79C', wood: '#C7A47D', metal: '#AFA7A1', stone: '#E6D8CC' },
      materials: { floor: 'дуб, натуральное масло', walls: 'матовая краска, пудровый', ceiling: 'натяжной, сатин', fronts: 'шпон дуба, лак', textile: 'рогожка, букле', metal: 'латунь, матовый' },
      lighting: { mood: 'тёплый камерный свет, 2700 K', kelvin: 2700 },
    },
    graphite: {
      name: 'Графитовый минимализм',
      palette: { wall: '#D6D3CC', ceiling: '#F0EDE7', floor: '#B79A78', accent: '#3E4548', textile: '#7D7F7C', wood: '#9C7451', metal: '#55585A', stone: '#C9C4BA' },
      materials: { floor: 'инженерная доска, дымчатый дуб', walls: 'микроцемент, графит', ceiling: 'натяжной, матовый', fronts: 'шпон, графит', textile: 'шерсть, лён', metal: 'брашированная сталь' },
      lighting: { mood: 'сдержанный свет, 3000 K', kelvin: 3000 },
    },
    warm: {
      name: 'Тёплый минимализм',
      palette: { wall: '#EDE6DB', ceiling: '#F7F4EE', floor: '#C9A173', accent: '#B5654A', textile: '#8C8275', wood: '#B9895B', metal: '#9C9A94', stone: '#D9D2C6' },
      materials: { floor: 'инженерная доска, дуб', walls: 'матовая краска, тёплый беж', ceiling: 'натяжной, сатин', fronts: 'шпон дуба, рейка', textile: 'рогожка, лён', metal: 'латунь, чёрный металл' },
      lighting: { mood: 'тёплый вечерний свет, 2700 K', kelvin: 2700 },
    },
  };
  const key = /скандинав|нордич|hygge/iu.test(s)
    ? 'scandi'
    : /япон|джапанди|japandi|ваби/iu.test(s)
      ? 'japandi'
      : /лофт|loft|бетон|кирпич/iu.test(s)
        ? 'loft'
        : /пастель|пудр|нежн|букле|терракот/iu.test(s)
          ? 'pastel'
          : /графит|тёмн|темн|монохром/iu.test(s)
            ? 'graphite'
            : 'warm';
  const preset = presets[key];
  return {
    name: preset.name,
    palette: { ...preset.palette },
    materials: { ...preset.materials },
    lighting: { ...preset.lighting },
    decor: key === 'japandi'
      ? ['ветка в керамической вазе', 'льняные шторы', 'бумажный абажур', 'циновка']
      : key === 'loft'
        ? ['кожаное кресло', 'постер в чёрной раме', 'металлические полки', 'ковёр с графикой']
        : key === 'pastel'
          ? ['букле-подушки', 'округлое зеркало', 'ваза с сухоцветами', 'мягкий плед']
          : ['льняные шторы', 'постеры в тонких рамах', 'керамика', 'плед'],
    source: 'brief',
    decisions: [
      'палитра и материалы выведены из брифа',
      'свет трёхслойный: общий, рабочий, акцентный',
    ],
  };
}

/**
 * Собрать спек из просьбы человека. Возвращает `{ raw, assumptions }`:
 * `raw` — обычный спек для `writeSpec`, `assumptions` — что пришлось принять
 * за человека, чтобы ответ не выдавал догадки за исходные данные.
 */
export function specFromText(prompt) {
  const source = String(prompt || '');
  const assumptions = [];

  const given = areaFromText(source);
  const area = given || 36;
  assumptions.push(
    given
      ? `площадь взята из задачи: ${String(area).replace('.', ',')} м²`
      : 'площадь в задаче не названа — принял 36 м²',
  );

  /* Габарит близок к 1,35:1 — так у стены помещается кухонный фронт, а середина
     остаётся проходом. */
  const width = Math.round((Math.sqrt(area * 1.35) * 1000) / 50) * 50;
  const depth = Math.round((area * 1_000_000) / width / 50) * 50;
  assumptions.push(`габарит помещения ${width} × ${depth} мм`);

  const fullHeightWindows = /окн\p{L}*\s+в\s+пол|панорамн|французск|витраж/iu.test(source);
  const wallHeight = fullHeightWindows ? 3000 : 2800;
  const ceilingHeight = wallHeight - 50;
  assumptions.push(`высота потолка ${ceilingHeight} мм`);

  const isBedroom = /спальн/iu.test(source);
  const isLiving = /гостин/iu.test(source);
  const isKitchen = /кухн/iu.test(source) && !/студи/iu.test(source);
  const isKids = /детск/iu.test(source);
  const isOffice = /кабинет/iu.test(source);
  const isStudio = /студи/iu.test(source) || (!isBedroom && !isLiving && !isKitchen && !isOffice);

  const roomName = isBedroom ? 'Спальня' : isLiving ? 'Гостиная' : isKitchen ? 'Кухня' : isKids ? 'Детская' : isOffice ? 'Кабинет' : 'Студия';
  const wood = /дерев|древес|дуб|ясен|шпон|рейк/iu.test(source);
  const pastel = /постельн|беж|нюд|пудр|пудров|терракот|пудрово|приглуш|тёпл\p{L}*\s+сер/iu.test(source);
  const style = styleFromBrief(source);

  /* Если просят квартиру с несколькими комнатами, одна прямоугольная комната
     с кухней у стены — заведомо не тот проект. Собираем честный многочастный
     план: коридор, мокрую зону, спальни и кухню-гостиную. */
  const roomsWanted = roomsFromText(source, area);
  if (roomsWanted >= 2) {
    return apartmentFromText(source, area, style, {
      assumptions,
      wallHeight,
      ceilingHeight,
      fullHeightWindows,
      wood,
      pastel,
      isKids,
      isOffice,
      combinedKitchen: /кухн\p{L}*[-\s]*гостин|гостин\p{L}*[-\s]*кухн/iu.test(source),
      roomsWanted,
    });
  }

  const poly = [
    [0, 0],
    [width, 0],
    [width, depth],
    [0, depth],
  ];
  const t = 150;
  /* Осевые линии стен вынесены наружу на полтолщины: тело стены не съедает
     площадь комнаты, и метраж на плане совпадает с заявленным. */
  const walls = [
    { x1: -t / 2, y1: -t / 2, x2: width + t / 2, y2: -t / 2, t },
    { x1: width + t / 2, y1: -t / 2, x2: width + t / 2, y2: depth + t / 2, t },
    { x1: -t / 2, y1: depth + t / 2, x2: width + t / 2, y2: depth + t / 2, t },
    { x1: -t / 2, y1: -t / 2, x2: -t / 2, y2: depth + t / 2, t },
  ];

  const openings = [];
  if (fullHeightWindows) {
    /* Окна в пол занимают правые две трети стены: левая треть остаётся глухой —
       туда встаёт ТВ-зона, а не телевизор перед стеклом. */
    const span = Math.round(width * 0.28);
    openings.push({ kind: 'window', x: Math.round(width * 0.52), y: -t / 2, w: span, dir: 'h', sill: 100, h: wallHeight - 150 });
    openings.push({ kind: 'window', x: Math.round(width * 0.82), y: -t / 2, w: span, dir: 'h', sill: 100, h: wallHeight - 150 });
    assumptions.push(`окна в пол: два проёма по ${span} мм от пола (подоконник 100 мм) в правой части стены`);
  } else {
    const span = Math.round(width * 0.3);
    openings.push({ kind: 'window', x: Math.round(width * 0.35), y: -t / 2, w: span, dir: 'h', sill: 900, h: 1500 });
    openings.push({ kind: 'window', x: Math.round(width * 0.72), y: -t / 2, w: span, dir: 'h', sill: 900, h: 1500 });
    assumptions.push(`два окна по ${span} мм, подоконник 900 мм`);
  }
  openings.push({ kind: 'door', x: width - 1300, y: depth + t / 2, w: 900, dir: 'h', hinge: 'right', swing: 'in' });
  assumptions.push('входная дверь 900 мм — в правой части нижней стены');

  const m = 100;
  const furniture = [];
  const lighting = [];

  /* ------------------------------- раскладка -------------------------------
     Деталь ставится «спиной» к стене: у каждой стены своя свободная полоса,
     углы, занятые соседней стеной, из полосы вычитаются. Так мебель не
     наезжает друг на друга по построению, а не «на глаз». Мойка, варочная
     панель, ковёр и радиатор — накладки: они лежат поверх и в габаритах не
     участвуют, иначе столешница считалась бы занятой собственной мойкой. */

  const boxes = [];
  function overlaps(x0, y0, fw, fh, gap = 20) {
    return boxes.some((box) => x0 + fw > box.x0 + gap && x0 < box.x1 - gap && y0 + fh > box.y0 + gap && y0 < box.y1 - gap);
  }
  function remember(name, kind, x0, y0, fw, fh, rot, { overlay = false } = {}) {
    furniture.push(piece(kind, x0, y0, fw, fh, rot, name));
    const box = { name, kind, x0, y0, x1: x0 + fw, y1: y0 + fh };
    if (!overlay) boxes.push(box);
    return box;
  }

  const runs = {
    left: [[m, depth - m]],
    right: [[m, depth - m]],
    top: [[m, width - m]],
    bottom: [[m, width - m]],
  };
  function cut(wall, from, to) {
    const next = [];
    for (const [start, end] of runs[wall]) {
      if (to <= start || from >= end) next.push([start, end]);
      else {
        if (from > start) next.push([start, from]);
        if (end > to) next.push([to, end]);
      }
    }
    runs[wall] = next;
  }
  /* Деталь одной стены занимает ещё и полосу у перпендикулярных стен — иначе
     угол комнаты достаётся двум предметам сразу. */
  function cutCorners(wall, deep) {
    if (wall === 'left' || wall === 'right') {
      const from = wall === 'left' ? m : width - m - deep;
      cut('top', from, from + deep);
      cut('bottom', from, from + deep);
    } else {
      const from = wall === 'top' ? m : depth - m - deep;
      cut('left', from, from + deep);
      cut('right', from, from + deep);
    }
  }
  /** Поставить к стене: `length` — вдоль стены, `deep` — от стены. */
  function along(wall, name, kind, length, deep) {
    let start = null;
    for (const [from, to] of runs[wall]) {
      if (to - from >= length) {
        start = from;
        cut(wall, from, from + length);
        break;
      }
    }
    if (start === null) return null;
    cutCorners(wall, deep);
    if (wall === 'left' || wall === 'right') {
      const x0 = wall === 'left' ? m : width - m - deep;
      return remember(name, kind, x0, start, deep, length, wall === 'left' ? 270 : 90);
    }
    const y0 = wall === 'top' ? m : depth - m - deep;
    return remember(name, kind, start, y0, length, deep, wall === 'top' ? 0 : 180);
  }
  /** Свободно стоящая деталь: первый вариант из списка, где не мешает. */
  function free(name, kind, fw, fh, rot, candidates) {
    for (const [x0, y0] of candidates) {
      if (x0 < 0 || y0 < 0 || x0 + fw > width || y0 + fh > depth) continue;
      if (overlaps(x0, y0, fw, fh)) continue;
      return remember(name, kind, x0, y0, fw, fh, rot);
    }
    return null;
  }

  /* Входная дверь: её место на нижней стене занято заранее. */
  cut('bottom', width - 1750, width - 850);

  const kitchenZone = !isBedroom && !isOffice && !isKids;
  if (kitchenZone) {
    const counterLength = Math.min(3000, Math.round((depth - 2 * m - 800) / 50) * 50);
    const counter = along('left', 'Кухонный фронт', 'kitchen_counter', counterLength, 600);
    if (counter) {
      remember('Мойка', 'sink', m, counter.y0 + 300, 600, 800, 270, { overlay: true });
      remember('Варочная панель', 'hob', m, counter.y0 + 1500, 600, 600, 270, { overlay: true });
      along('left', 'Холодильник', 'fridge', 700, 700);
      assumptions.push(`кухонный фронт ${counterLength} мм с мойкой и варочной панелью, холодильник рядом`);
    }
  }

  if (isBedroom || (isStudio && area >= 30)) {
    const bed = along('right', 'Кровать 160×200', 'bed_double', 2000, 1600);
    if (bed) {
      along('right', 'Тумба прикроватная', 'nightstand', 450, 400);
      assumptions.push('спальное место 1600 × 2000 у правой стены с прикроватной тумбой');
    }
  }
  if (isKids) {
    along('right', 'Кровать 90×200', 'bed_single', 2000, 900);
    along('right', 'Стол детский', 'desk_small', 1100, 600);
  }
  if (isBedroom) {
    along('bottom', 'Комод', 'dresser', 1000, 450) || along('left', 'Комод', 'dresser', 1000, 450);
  }

  let sofa = null;
  if (!isBedroom && !isOffice && !isKids) {
    const sofaLength = width >= 5200 ? 2200 : 1600;
    sofa = along('bottom', 'Диван', sofaLength >= 2200 ? 'sofa' : 'sofa_small', sofaLength, 900);
    if (sofa) along('top', 'ТВ-тумба', 'tv_stand', 1600, 400);
  }
  if (isOffice) {
    const desk = along('bottom', 'Стол письменный', 'desk', 1400, 700);
    if (desk) along('bottom', 'Кресло офисное', 'office_chair', 600, 600);
  }

  const wardrobe =
    along('right', 'Шкаф-купе', 'wardrobe_slide', 1800, 650) ||
    along('bottom', 'Шкаф-купе', 'wardrobe_slide', 1800, 650) ||
    along('left', 'Шкаф-купе', 'wardrobe_slide', 1800, 650);
  if (!wardrobe) along('top', 'Шкаф', 'wardrobe', Math.min(1200, width - 2 * m), 600);

  /* Центр комнаты: стол перед диваном, обеденная группа — где осталось место. */
  if (sofa) {
    const tableWidth = Math.min(1100, sofa.x1 - sofa.x0 - 300);
    const table = free('Журнальный стол', 'coffee_table', tableWidth, 600, 0, [
      [Math.round(sofa.x0 + (sofa.x1 - sofa.x0 - tableWidth) / 2), Math.round(sofa.y0 - 1300)],
      [Math.round(sofa.x0 + (sofa.x1 - sofa.x0 - tableWidth) / 2), Math.round(sofa.y0 - 1900)],
    ]);
    if (table) {
      remember('Ковёр', 'rug', Math.max(m, table.x0 - 450), Math.max(m, table.y0 - 450), Math.min(2000, width - 2 * m), Math.min(1500, depth - 2 * m), 0, { overlay: true });
    }
  }
  if (area >= 34 && !isBedroom && !isOffice) {
    const candidates = [];
    for (const y of [depth - 900, Math.round(depth * 0.55), m + 700]) {
      for (const x of [0.55, 0.42, 0.3, 0.68]) candidates.push([Math.round(width * x), y]);
    }
    const dining = free('Стол обеденный', 'dining_table', 1400, 800, 0, candidates);
    if (dining) {
      free('Стул', 'chair', 450, 450, 0, [
        [dining.x0 + 200, dining.y0 - 550],
        [dining.x0 + 200, dining.y0 + 850],
      ]);
      free('Стул', 'chair', 450, 450, 0, [
        [dining.x0 + 850, dining.y0 - 550],
        [dining.x0 + 850, dining.y0 + 850],
      ]);
      assumptions.push('обеденная группа на два места');
    }
  }
  free('Растение', 'plant', 500, 500, 0, [
    [m, depth - 700],
    [width - m - 500, depth - 700],
    [width - m - 500, m],
    [m, m],
  ]);
  remember('Радиатор', 'radiator', Math.round(width * 0.5 - 400), 0, 800, 120, 0, { overlay: true });

  lighting.push({ kind: 'chandelier', x: Math.round(width * 0.45), y: Math.round(depth * 0.5) });
  for (const [gx, gy] of [
    [0.2, 0.25],
    [0.5, 0.25],
    [0.8, 0.25],
    [0.2, 0.7],
    [0.5, 0.7],
    [0.8, 0.7],
  ]) {
    lighting.push({ kind: 'spot', x: Math.round(width * gx), y: Math.round(depth * gy) });
  }
  lighting.push({ kind: 'led', x: Math.round(width * 0.5), y: 300, w: Math.round(width * 0.6) });
  assumptions.push('свет: люстра по центру, 6 точечных светильников, светодиодная лента у окна');

  const floor = wood ? 'инженерная доска, дуб натуральный' : style.materials.floor;
  const notes = [
    pastel
      ? 'Палитра постельная: тёплый беж на стенах, пудрово-розовый акцент, тёплый серый в текстиле.'
      : `Палитра «${style.name}»: стены ${style.palette.wall}, акцент ${style.palette.accent}, текстиль ${style.palette.textile}.`,
    wood
      ? 'Деревянные элементы: дубовые подоконники, рейка-панель за ТВ, деревянные ножки мебели.'
      : `Дерево в отделке: ${style.materials.fronts}; подоконники и ножки — в тон.`,
    fullHeightWindows
      ? 'Окна в пол: алюминиевый профиль, плотные шторы в пол по всей высоте проёма.'
      : 'Окна обычные: подоконник 900 мм, шторы до пола.',
    `Площадь пола: ${String(Math.round(((width * depth) / 1_000_000) * 100) / 100).replace('.', ',')} м² (без стен).`,
  ];

  const raw = {
    project: `Дизайн-проект: ${roomName.toLowerCase()}${given ? ` ${String(area).replace('.', ',')} м²` : ''}`,
    object: `${roomName}, ${String(Math.round(((width * depth) / 1_000_000) * 100) / 100).replace('.', ',')} м²`,
    paper: 'A3',
    heights: { wall: wallHeight, ceiling: ceilingHeight },
    rooms: [{ name: roomName, poly, floor }],
    walls,
    openings,
    furniture,
    lighting,
    style,
    notes,
  };
  return { raw, assumptions };
}

/**
 * Сколько комнат просят. «Студия» — всегда одна: иначе слово «квартира»
 * превращало бы её в двушку. Число берём из «4 комнаты», «двухкомнатной»,
 * «2 спален»; если его нет — из перечисленных зон и площади.
 */
function roomsFromText(source, area) {
  const s = String(source || '');
  if (/студи/iu.test(s)) return 1;
  const digit = s.match(/(\d+)\s*[-\s]?\s*комн/iu);
  const word = s.match(/(одно|двух|трёх|трех|четырёх|четырех|пяти|шести)[-\s]*комн/iu);
  const words = { одно: 1, двух: 2, трёх: 3, трех: 3, четырёх: 4, четырех: 4, пяти: 5, шести: 6 };
  let rooms = digit ? Number(digit[1]) : word ? words[word[1].toLowerCase()] || 0 : 0;
  if (!rooms) {
    const bedrooms = (s.match(/спальн/giu) || []).length;
    const kids = /детск/iu.test(s) ? 1 : 0;
    const office = /кабинет/iu.test(s) ? 1 : 0;
    const living = /гостин/iu.test(s) ? 1 : 0;
    const kitchen = /кухн/iu.test(s) && !/кухн\p{L}*[-\s]*гостин/iu.test(s) ? 1 : 0;
    rooms = bedrooms + kids + office + living + kitchen;
    if (!rooms && /квартир/iu.test(s)) rooms = area >= 65 ? 3 : area >= 45 ? 2 : 1;
  }
  return Math.max(1, Math.min(5, Math.round(rooms) || 1));
}

/** Прямоугольник комнаты по внутренним границам, против часовой стрелки. */
function rectPoly(x1, y1, x2, y2) {
  return [[x1, y1], [x2, y1], [x2, y2], [x1, y2]];
}

/**
 * Многочастная квартира из брифа: коридор, мокрая зона, кухня, гостиная и
 * спальни. Это запасной путь, когда модель не прислала свой спек, но он
 * обязан давать разные планы на разные просьбы и быть пригодным для жизни:
 * у каждой комнаты дверь, окно и своя мебель.
 */
function apartmentFromText(source, area, style, opts) {
  const assumptions = opts.assumptions.filter((line) => !/^габарит помещения/iu.test(line));
  const t = 150;
  const pt = 100;
  const W = Math.max(4200, Math.round((Math.sqrt(area * 1.52) * 1000) / 50) * 50);
  const D = Math.max(3600, Math.round((area * 1_000_000) / W / 50) * 50);
  const hallH = Math.max(1300, Math.min(1900, Math.round((D * 0.23) / 50) * 50));
  const northBottom = D - hallH;
  const corrW = 1000;
  const corrX = Math.round((W * 0.44) / 50) * 50;
  const leftEdge = corrX - pt / 2;
  const rightEdge = corrX + corrW + pt / 2;
  const bathW = Math.max(1600, Math.min(2300, Math.round((W * 0.25) / 50) * 50));
  const bathEdge = bathW - pt / 2;
  const hallEdge = northBottom + pt / 2;
  const roomsWanted = opts.roomsWanted;
  /* «Кухня-гостиная» — одна комната, а не две. Отдельная кухня — помещение,
     но не комната: жилых комнат всё равно roomsWanted (гостиная + спальни),
     поэтому rightCount = roomsWanted − 1. Раньше для 4 комнат с отдельной
     кухней терялась спальня, а проект назывался 4-комнатным. */
  const wantsSeparateKitchen =
    /кухн\p{L}*[^.!;]{0,24}(отдельн|самостоятельн)|отдельн\p{L}*\s+кухн/iu.test(source);
  const separateKitchen =
    opts.combinedKitchen !== true && (wantsSeparateKitchen || roomsWanted >= 3);
  const splitY = separateKitchen ? Math.round((northBottom * 0.54) / 50) * 50 : northBottom;
  const rightCount = Math.max(1, roomsWanted - 1);
  const rightBounds = [0];
  for (let i = 1; i < rightCount; i += 1) rightBounds.push(Math.round((northBottom * i) / rightCount / 50) * 50);
  rightBounds.push(northBottom);

  assumptions.push(`габарит квартиры ${W} × ${D} мм`);
  assumptions.push(`коридор ${corrW} мм ведёт от прихожей к комнатам, санузел ${bathW} мм у входа`);
  assumptions.push(`окна: ${opts.fullHeightWindows ? 'в пол' : 'с подоконником 900 мм'} на север, запад и восток`);

  const rooms = [];
  const walls = [
    { x1: -t / 2, y1: -t / 2, x2: W + t / 2, y2: -t / 2, t },
    { x1: W + t / 2, y1: -t / 2, x2: W + t / 2, y2: D + t / 2, t },
    { x1: -t / 2, y1: D + t / 2, x2: W + t / 2, y2: D + t / 2, t },
    { x1: -t / 2, y1: -t / 2, x2: -t / 2, y2: D + t / 2, t },
    { x1: corrX, y1: 0, x2: corrX, y2: northBottom, t: pt },
    { x1: corrX + corrW, y1: 0, x2: corrX + corrW, y2: northBottom, t: pt },
    { x1: 0, y1: northBottom, x2: W, y2: northBottom, t: pt },
    { x1: bathW, y1: northBottom, x2: bathW, y2: D, t: pt },
  ];
  if (separateKitchen) walls.push({ x1: 0, y1: splitY, x2: corrX, y2: splitY, t: pt });
  for (const at of rightBounds.slice(1, -1)) walls.push({ x1: corrX + corrW, y1: at, x2: W, y2: at, t: pt });

  const floorWood = opts.wood ? 'инженерная доска, дуб натуральный' : style.materials.floor;
  rooms.push({ name: 'Коридор', poly: rectPoly(corrX + pt / 2, 0, corrX + corrW - pt / 2, northBottom - pt / 2), floor: 'керамогранит' });
  rooms.push({ name: 'Прихожая', poly: rectPoly(bathW + pt / 2, hallEdge, W, D), floor: 'керамогранит' });
  rooms.push({ name: 'Санузел', poly: rectPoly(0, hallEdge, bathEdge, D), floor: 'керамогранит' });
  rooms.push({
    name: separateKitchen ? 'Гостиная' : 'Кухня-гостиная',
    poly: rectPoly(0, 0, leftEdge, separateKitchen ? splitY - pt / 2 : northBottom - pt / 2),
    floor: floorWood,
  });
  if (separateKitchen) {
    rooms.push({ name: 'Кухня', poly: rectPoly(0, splitY + pt / 2, leftEdge, northBottom - pt / 2), floor: 'керамогранит' });
  }

  const rightNames = [];
  for (let i = 0; i < rightCount; i += 1) {
    const isLast = i === rightCount - 1;
    const name = opts.isKids && isLast && !rightNames.includes('Детская')
      ? 'Детская'
      : opts.isOffice && isLast && !rightNames.includes('Кабинет')
        ? 'Кабинет'
        : rightCount === 1 ? 'Спальня' : `Спальня ${i + 1}`;
    rightNames.push(name);
    const from = rightBounds[i] + (i ? pt / 2 : 0);
    const to = rightBounds[i + 1] - (i < rightCount - 1 ? pt / 2 : 0);
    rooms.push({ name, poly: rectPoly(rightEdge, from, W, to), floor: floorWood });
  }

  const openings = [];
  const sill = opts.fullHeightWindows ? 100 : 900;
  const winH = opts.fullHeightWindows ? opts.wallHeight - 150 : 1500;
  openings.push({ kind: 'window', x: 350, y: -t / 2, w: Math.min(1800, Math.max(900, leftEdge - 700)), dir: 'h', sill, h: winH });
  openings.push({ kind: 'window', x: rightEdge + 250, y: -t / 2, w: Math.min(1700, Math.max(900, W - rightEdge - 500)), dir: 'h', sill, h: winH });
  openings.push({ kind: 'window', x: -t / 2, y: 500, w: Math.min(1600, Math.max(900, northBottom - 1000)), dir: 'v', sill, h: winH });
  for (let i = 0; i < rightCount; i += 1) {
    const from = rightBounds[i] + (i ? pt / 2 : 0);
    const to = rightBounds[i + 1] - (i < rightCount - 1 ? pt / 2 : 0);
    openings.push({ kind: 'window', x: W + t / 2, y: Math.round(from + (to - from) * 0.2), w: Math.min(1500, Math.max(800, Math.round((to - from) * 0.55))), dir: 'v', sill, h: winH });
  }

  const door = (x, y, w, dir, extra = {}) => openings.push({ kind: 'door', x, y, w, dir, h: 2100, hinge: 'left', swing: 'in', ...extra });
  door(W - 1100, D + t / 2, 900, 'h');
  door(corrX, northBottom, corrW, 'h'); // проём из прихожей в коридор
  door(bathW, D - 800, 800, 'v');
  door(corrX, separateKitchen ? splitY + 350 : Math.max(350, northBottom - 950), 850, 'v');
  if (separateKitchen) door(corrX, Math.min(northBottom - 500, splitY + 1100), 850, 'v');
  for (let i = 0; i < rightCount; i += 1) {
    const from = rightBounds[i] + (i ? pt / 2 : 0);
    const to = rightBounds[i + 1] - (i < rightCount - 1 ? pt / 2 : 0);
    door(corrX + corrW, Math.round((from + to) / 2 - 400), 800, 'v');
  }

  const furniture = [];
  const add = (kind, x, y, w, d, rot, name) => furniture.push(piece(kind, x, y, w, d, rot || 0, name));
  const livingDepth = separateKitchen ? splitY : northBottom;
  const sofaW = Math.min(2200, Math.max(1400, leftEdge - 700));
  add('sofa', Math.round((leftEdge - sofaW) / 2), Math.max(150, livingDepth - 1050), sofaW, 850, 180, 'Диван');
  add('tv_stand', Math.round((leftEdge - Math.min(1600, leftEdge - 600)) / 2), 100, Math.min(1600, leftEdge - 600), 400, 0, 'ТВ-тумба');
  add('coffee_table', Math.round((leftEdge - 1000) / 2), Math.max(500, Math.round(livingDepth * 0.6)), 1000, 600, 0, 'Журнальный стол');
  add('rug', Math.max(100, Math.round(leftEdge * 0.15)), Math.max(350, Math.round(livingDepth * 0.48)), Math.min(2200, leftEdge - 300), 1500, 0, 'Ковёр');
  add('plant', Math.max(150, leftEdge - 650), Math.max(150, livingDepth - 700), 500, 500, 0, 'Растение');

  if (separateKitchen) {
    const ky = splitY + pt / 2 + 100;
    const kh = northBottom - ky - 100;
    add('kitchen_counter', 100, ky, 600, Math.max(900, Math.min(2600, kh)), 270, 'Кухонный фронт');
    add('fridge', 100, northBottom - 800, 700, 700, 0, 'Холодильник');
    if (leftEdge > 2500 && kh > 1500) add('dining_table', Math.round(leftEdge * 0.45), ky + 250, 1100, 700, 0, 'Обеденный стол');
    add('sink', 120, ky + 250, 560, 700, 270, 'Мойка');
    add('hob', 120, ky + Math.min(1300, Math.max(800, kh - 800)), 560, 600, 270, 'Варочная панель');
  } else {
    const ky = Math.max(900, northBottom - 2500);
    add('kitchen_counter', 100, ky, 600, 1800, 270, 'Кухонный фронт');
    add('fridge', 100, ky + 1850, 700, 700, 0, 'Холодильник');
    add('sink', 120, ky + 200, 560, 700, 270, 'Мойка');
    add('hob', 120, ky + 900, 560, 600, 270, 'Варочная панель');
  }

  for (let i = 0; i < rightCount; i += 1) {
    const from = rightBounds[i] + (i ? pt / 2 : 0);
    const to = rightBounds[i + 1] - (i < rightCount - 1 ? pt / 2 : 0);
    const rh = to - from;
    const rw = W - rightEdge;
    const bedW = Math.max(1200, Math.min(1600, rw - 900));
    const bedD = Math.max(1800, Math.min(2000, rh - 350));
    const bx = W - 100 - bedD;
    const by = Math.round(from + Math.max(100, (rh - bedW) / 2));
    add('bed_double', bx, by, bedW, bedD, 90, 'Кровать 160×200');
    add('nightstand', W - 550, by, 450, 450, 0, 'Тумба');
    /* В маленькой спальне шкаф у западной стены всё равно перекрывает кадр
       и кровать. Хранение выносим в прихожую: спальни остаются читаемыми. */
  }

  add('bath', 100, hallEdge + 100, 750, Math.max(1500, Math.min(1800, hallH - 300)), 270, 'Ванна');
  add('wc', 100, D - 750, 420, 650, 0, 'Унитаз');
  add('bath_sink', Math.min(bathEdge - 650, 1100), hallEdge + 100, 600, 450, 0, 'Раковина');
  add('mirror', Math.min(bathEdge - 800, 1000), hallEdge + 100, 500, 60, 0, 'Зеркало');
  add('wardrobe', W - 800, hallEdge + 150, 1200, 600, 90, 'Шкаф в прихожей');

  const lighting = [];
  const lamp = (kind, x, y, w) => {
    const item = { kind, x, y };
    if (w) item.w = w;
    lighting.push(item);
  };
  lamp('chandelier', Math.round(leftEdge / 2), Math.round(livingDepth * 0.45));
  if (separateKitchen) lamp('chandelier', Math.round(leftEdge / 2), Math.round((splitY + northBottom) / 2));
  for (const room of rooms.slice(rooms.length - rightCount)) {
    const poly = room.poly;
    lamp('chandelier', Math.round((poly[0][0] + poly[1][0]) / 2), Math.round((poly[0][1] + poly[2][1]) / 2));
  }
  for (const [x, y] of [[corrX + 500, 900], [corrX + 500, northBottom - 900], [W - 1200, D - 600], [bathEdge / 2, D - 600]]) lamp('spot', x, y);
  lamp('led', corrX + 500, 250, 700);

  assumptions.push(`комнат по брифу: ${roomsWanted}; кухня ${separateKitchen ? 'отдельная' : 'в гостиной'}, санузел у входа`);
  assumptions.push(`в каждой комнате окно и дверь из коридора; мебель расставлена по зонам, а не одним рядом`);

  const total = Math.round((W * D / 1_000_000) * 100) / 100;
  const raw = {
    project: `Дизайн-проект: квартира ${String(area).replace('.', ',')} м², ${roomsWanted} ${roomsWanted === 1 ? 'комната' : roomsWanted < 5 ? 'комнаты' : 'комнат'}`,
    object: `Квартира, ${String(total).replace('.', ',')} м² по полу`,
    paper: 'A3',
    heights: { wall: opts.wallHeight, ceiling: opts.ceilingHeight },
    rooms,
    walls,
    openings,
    furniture,
    lighting,
    style,
    notes: [
      `Планировка из брифа: ${roomsWanted} ${roomsWanted === 1 ? 'комната' : 'комнаты'}, коридор, прихожая и санузел.`,
      `Палитра «${style.name}»: стены ${style.palette.wall}, акцент ${style.palette.accent}, текстиль ${style.palette.textile}.`,
      opts.fullHeightWindows ? 'Окна в пол с плотными шторами по высоте проёма.' : 'Окна с подоконником 900 мм, шторы до пола.',
      `Площадь пола: ${String(total).replace('.', ',')} м².`,
    ],
  };
  return { raw, assumptions };
}

/** Русское склонение после числа: 1 комнатА, 2 комнатЫ, 5 комнат. */
function plural(count, one, few, many) {
  const tail = count % 100;
  if (tail >= 11 && tail <= 14) return many;
  const last = count % 10;
  if (last === 1) return one;
  if (last >= 2 && last <= 4) return few;
  return many;
}

/** Краткая строка для ответа агента: площади, количество мебели, что получилось. */
export function describeDesign(view, results = null) {
  if (!view.hasSpec) {
    return `Дизайн-проекта в проекте нет. Спек — ${SPEC_FILE} в корне проекта: комнаты (полигоны в мм), стены, проёмы, мебель, светильники, высоты.`;
  }
  if (view.error) return `Спек есть, но не читается: ${view.error}`;
  const spec = view.spec;
  const rooms = livingRoomCount(spec.rooms);
  const spaces = spec.rooms.length;
  const furniture = spec.furniture.length;
  const openings = spec.openings.length;
  const lamps = spec.lighting.length;
  const area = String(view.area).replace('.', ',');
  const parts = [
    `«${spec.project}»: ${area} м², ${rooms} ${plural(rooms, 'комната', 'комнаты', 'комнат')}` +
      `${spaces !== rooms ? ` (${spaces} ${plural(spaces, 'помещение', 'помещения', 'помещений')})` : ''}, ` +
      `${furniture} ${plural(furniture, 'предмет', 'предмета', 'предметов')} мебели, ` +
      `${openings} ${plural(openings, 'проём', 'проёма', 'проёмов')}, ` +
      `${lamps} ${plural(lamps, 'светильник', 'светильника', 'светильников')}.`,
  ];
  if (spec.style?.name) {
    const source = spec.style.source === 'reference' ? `, по референсу${spec.style.referenceName ? ` «${spec.style.referenceName}»` : ''}` : '';
    parts.push(`Стиль: ${spec.style.name}${source}; палитра ${spec.style.palette?.wall || ''} / ${spec.style.palette?.accent || ''} / ${spec.style.palette?.textile || ''}.`);
  }
  const fixed = results || view.artifacts;
  const good = fixed.filter((item) => (item.ok === undefined ? item.exists : item.ok) && item.bytes > 0);
  const bad = fixed.filter((item) => !((item.ok === undefined ? item.exists : item.ok) && item.bytes > 0));
  if (good.length) {
    parts.push(`Собрано: ${good.map((item) => `${item.file} (${Math.max(1, Math.round(item.bytes / 1024))} КБ)`).join(', ')}.`);
  }
  if (bad.length) {
    parts.push(`Не собрано: ${bad.map((item) => `${item.title || item.file}${item.error ? ` — ${item.error}` : ''}`).join('; ')}.`);
  }
  if (view.fixes?.length) parts.push(`Замечания к спеку: ${view.fixes.join('; ')}.`);
  return parts.join(' ');
}

