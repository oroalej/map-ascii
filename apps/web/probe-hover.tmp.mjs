import { chromium } from '@playwright/test';
const time = process.argv[2];
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.addInitScript((t) => localStorage.setItem('atlas.life', JSON.stringify({ enabled: true, time: t })), time);
await page.goto('http://localhost:3117/naga');
await page.waitForTimeout(8000);
const hits = [];
for (let dy = -16; dy <= 16; dy += 4) for (let dx = -16; dx <= 16; dx += 4) {
  await page.mouse.move(640 + dx, 360 + dy);
  await page.waitForTimeout(100);
  if (await page.getByRole('tooltip').isVisible()) hits.push(`${dx},${dy}`);
}
console.log(time, 'hits', hits.length);
await browser.close();
