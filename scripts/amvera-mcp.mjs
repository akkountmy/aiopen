// Р’СЂРµРјРµРЅРЅС‹Р№ РїРѕРјРѕС‰РЅРёРє РґР»СЏ СЂР°Р·РІС‘СЂС‚С‹РІР°РЅРёСЏ dsh-open-web РІ Amvera (MCP РїР»Р°С‚С„РѕСЂРјС‹).
// РўРѕРєРµРЅ Р±РµСЂС‘С‚СЃСЏ РёР· %TEMP%\amvera-token.json (СЃРѕР·РґР°С‘С‚СЃСЏ amvera-login.mjs).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REGION = process.env.AMVERA_REGION || 'msk1';
const ENDPOINT = `https://openmcp.${REGION}.amvera.ru/mcp`;
const TOKEN = JSON.parse(fs.readFileSync(path.join(os.tmpdir(), 'amvera-token.json'), 'utf8').replace(/^\uFEFF/, '')).access_token;

let sessionId = null;
let nextId = 1;
async function rpc(method, params) {
  const id = nextId++;
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    authorization: `Bearer ${TOKEN}`,
    'mcp-protocol-version': '2024-11-05',
  };
  if (sessionId) headers['mcp-session-id'] = sessionId;
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  const sid = res.headers.get('mcp-session-id');
  if (sid) sessionId = sid;
  const raw = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} ${method}: ${raw.slice(0, 500)}`);
  if ((res.headers.get('content-type') || '').includes('text/event-stream')) {
    for (const line of raw.split('\n')) {
      const s = line.trim();
      if (!s.startsWith('data:')) continue;
      let j;
      try { j = JSON.parse(s.slice(5).trim()); } catch { continue; }
      if (j.id === id) return j;
    }
    return null;
  }
  return raw ? JSON.parse(raw) : null;
}

await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'dsh-deploy', version: '1.0.0' } });
try { await rpc('notifications/initialized', {}); } catch {}

export async function callTool(name, args) {
  const r = await rpc('tools/call', { name, arguments: args });
  if (r?.error) throw new Error(`${name}: ${JSON.stringify(r.error).slice(0, 400)}`);
  const res = r?.result;
  const text = (res?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  return { isError: !!res?.isError, text: text || JSON.stringify(res?.structuredContent ?? {}) };
}

if (process.argv[1] && process.argv[1].endsWith('amvera-mcp.mjs')) {
  const mode = process.argv[2] || 'tools';
  if (mode === 'tools') {
    const r = await rpc('tools/list', {});
    const filter = process.argv[3] || '';
    for (const t of r.result.tools) {
      if (filter && t.name !== filter) continue;
      console.log(`- ${t.name}: ${String(t.description || '').slice(0, 100)}`);
      if (filter) console.log(JSON.stringify(t.inputSchema, null, 1));
    }
  } else if (mode === 'call') {
    const rawArg = process.argv[4] || '{}';
    const parsed = rawArg.startsWith('@')
      ? JSON.parse(fs.readFileSync(rawArg.slice(1), 'utf8'))
      : JSON.parse(rawArg);
    const r = await callTool(process.argv[3], parsed);
    console.log(r.isError ? 'ERROR ' : '', r.text.slice(0, 4000));
  }
}

