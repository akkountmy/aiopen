// Проверка целостности токенов типографики в public/styles.css
import fs from 'node:fs';

const css = fs.readFileSync('public/styles.css', 'utf8');
const defined = new Set();
for (const match of css.matchAll(/^\s*(--(?:fs|lh)-[\w-]+):/gm)) defined.add(match[1]);

const used = new Set();
for (const match of css.matchAll(/var\((--(?:fs|lh)-[\w-]+)\)/g)) used.add(match[1]);

const missing = [...used].filter((name) => !defined.has(name));
const unused = [...defined].filter((name) => !used.has(name));
console.log('определено токенов:', defined.size);
console.log('используется:', used.size);
console.log('нет в :root:', missing.length ? missing.join(', ') : '—');
console.log('не используется:', unused.length ? unused.join(', ') : '—');

const sizes = new Map();
for (const match of css.matchAll(/font-size:\s*([^;]+);/g)) {
  const value = match[1].trim();
  sizes.set(value, (sizes.get(value) || 0) + 1);
}
console.log('разные значения font-size:');
for (const [value, count] of [...sizes].sort((a, b) => a[0].localeCompare(b[0]))) {
  console.log('   ' + value + ' × ' + count);
}

const weights = new Map();
for (const match of css.matchAll(/font-weight:\s*([^;]+);/g)) {
  weights.set(match[1].trim(), (weights.get(match[1].trim()) || 0) + 1);
}
console.log('значения font-weight:', [...weights].map(([w, c]) => w + '×' + c).join(', '));

// типографика внутри медиазапросов
let depth = 0;
let mediaDepth = 0;
let inside = 0;
for (const line of css.split('\n')) {
  const trimmed = line.trim();
  if (trimmed.startsWith('@media')) mediaDepth = depth + 1;
  if (trimmed.endsWith('{')) depth += 1;
  else if (trimmed === '}') {
    depth -= 1;
    if (mediaDepth && depth < mediaDepth) mediaDepth = 0;
  }
  if (mediaDepth && /^\s*(font-size|line-height|font-weight|font-family)\s*:/.test(line)) inside += 1;
}
console.log('типографика внутри @media:', inside);
