import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, dataHome } from './config.mjs';
import { readJson } from './util.mjs';

const OVERRIDE_FILE = path.join(DATA_DIR, 'service-keys.json');

function parseCredentialsYaml(text) {
  const refs = {};
  const lines = String(text).split(/\r?\n/);
  let inRefs = false;
  for (const line of lines) {
    if (/^refs:\s*$/.test(line)) {
      inRefs = true;
      continue;
    }
    if (inRefs) {
      if (/^\S/.test(line) && line.trim() !== '') {
        inRefs = false;
        continue;
      }
      const m = line.match(/^\s{2}([A-Za-z0-9_]+)\s*:\s*(.+?)\s*$/);
      if (m) refs[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
  return refs;
}

function fromDshHome() {
  try {
    const file = path.join(dataHome(), '.credentials.yaml');
    return parseCredentialsYaml(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

function localOverrides() {
  return readJson(OVERRIDE_FILE, {}) || {};
}

function pick(...values) {
  for (const v of values) {
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

export function getDeepSeekKey() {
  return pick(
    process.env.DSHOW_DEEPSEEK_KEY,
    localOverrides().deepseek,
    fromDshHome().DEEPSEEK_API_KEY,
  );
}

export function getOpenRouterKey() {
  return pick(
    process.env.OPENROUTER_API_KEY,
    localOverrides().openrouter,
    fromDshHome().OPENROUTER_API_KEY,
  );
}

export function keyStatus() {
  return {
    chat: Boolean(getDeepSeekKey()),
    vision: Boolean(getOpenRouterKey()),
  };
}

export function setLocalKey(name, value) {
  const current = localOverrides();
  if (value) current[name] = String(value);
  else delete current[name];
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(OVERRIDE_FILE, JSON.stringify(current, null, 2), { mode: 0o600 });
}
