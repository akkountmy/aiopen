import fs from 'node:fs';
import { getOpenRouterKey } from '../src/keys.mjs';
const key = getOpenRouterKey();
const [src, q] = process.argv.slice(2);
const buf = fs.readFileSync(src);
const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
  method: 'POST',
  headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    model: 'google/gemini-2.5-flash', max_tokens: 1500,
    messages: [{ role: 'user', content: [
      { type: 'text', text: q },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,' + buf.toString('base64') } },
    ]}],
  }),
});
const j = await r.json();
console.log(j.choices?.[0]?.message?.content || JSON.stringify(j).slice(0, 500));
