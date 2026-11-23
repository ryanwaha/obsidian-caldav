// usage: node modal.mjs <vault> <button text>...   clicks buttons (exact text) in open modals, in order, then prints remaining modals
import { connect } from './lib.mjs';
const [vault, ...buttons] = process.argv.slice(2);
const { br, page } = await connect(vault);
for (const b of buttons) {
  const btn = page.locator('.modal-container button', { hasText: b }).filter({ hasText: new RegExp('^' + b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$') }).first();
  if (await btn.count()) { await btn.click(); console.log('clicked', b); await page.waitForTimeout(1200); } else console.log('not found', b);
}
console.log(await page.evaluate(() => [...document.querySelectorAll('.modal-container .modal')].map(m => m.innerText.slice(0, 400))));
await br.close();
