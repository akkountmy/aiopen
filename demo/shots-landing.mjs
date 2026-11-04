/* Снимки секций лендинга для глазами-проверки: node demo/shots-landing.mjs */
import { chromium } from 'playwright';
import { pathToFileURL } from 'node:url';

const shots = {
  1440: ['top', 'services', 'prices', 'calc', 'cases', 'warranty', 'faq', 'form'],
  390: ['top', 'services', 'prices', 'calc', 'cases', 'form']
};

const browser = await chromium.launch();
for (const [width, ids] of Object.entries(shots)) {
  const page = await browser.newPage({ viewport: { width: Number(width), height: 900 } });
  await page.goto(pathToFileURL('demo/landing-spatlevka.html').href, { waitUntil: 'load' });
  await page.waitForTimeout(250);
  for (const id of ids) {
    const target = id === 'top' ? null : await page.$('#' + id);
    if (id !== 'top' && !target) {
      console.log('нет секции', id);
      continue;
    }
    const file = id === 'top' ? `demo/screenshots/top-${width}.png` : `demo/screenshots/sec-${id}-${width}.png`;
    try {
      if (target) await target.screenshot({ path: file });
      else await page.screenshot({ path: file });
      console.log('снято', id, width);
    } catch (error) {
      console.log('не снято', id, width, String(error.message).slice(0, 70));
    }
  }
  await page.close();
}
await browser.close();
