import fs from 'node:fs';
import { getOpenRouterKey } from '../src/keys.mjs';
const key = getOpenRouterKey();
if (!key) { console.log('NO KEY'); process.exit(2); }
const buf = fs.readFileSync('C:/Users/33620/.dsh/attachments/v1/objects/40/402a32fa0b6231636a6c0bb6cd8f996b8a9ba221bb02ec323473b13c9e166773');
const dataUrl = 'data:image/png;base64,' + buf.toString('base64');
const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
  method: 'POST',
  headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    model: 'google/gemini-2.5-flash',
    max_tokens: 2000,
    messages: [{ role: 'user', content: [
      { type: 'text', text: 'Опиши буквально и подробно, что видно на скриншоте веб-приложения: слева (панели, их заголовки, наложения, рисунки), в центре, справа (нарисованные линии/рамки/панель инструментов). Приведи все читаемые тексты и подписи. Не додумывай.' },
      { type: 'image_url', image_url: { url: dataUrl } },
    ]}],
  }),
});
const j = await r.json();
console.log(r.status);
console.log(j.choices?.[0]?.message?.content || JSON.stringify(j).slice(0, 800));
