import { connect, measure } from './lib.mjs';
const out = process.argv[2]; const F = process.env.HOME + '/m6-spike/vault-a/_caldav/k3f9x2qa.md';
const { br, page } = await connect();
await page.evaluate(async () => { const leaf = app.workspace.getLeaf(false); await leaf.openFile(app.vault.getAbstractFileByPath('_caldav/k3f9x2qa.md'), { state: { mode: 'source', source: false } }); });
await page.waitForTimeout(800);
const prop = (k) => page.locator(`.workspace-leaf.mod-active .metadata-property[data-property-key="${k}"] .metadata-property-value`);
await measure(page, '1-title', async () => {
  const el = prop('title').locator('.metadata-input-longtext'); await el.click(); await page.keyboard.press('Control+A'); await page.keyboard.insertText('交週報二'); await page.keyboard.press('Enter');
}, F, out);
await measure(page, '2-date', async () => { await prop('due').locator('input').fill('2026-12-01'); await page.keyboard.press('Tab'); }, F, out);
await measure(page, '3-datetime', async () => {
  await page.evaluate(() => app.metadataTypeManager.setType('due', 'datetime')); await page.waitForTimeout(800);
  await prop('due').locator('input').fill('2026-12-01T09:30'); await page.keyboard.press('Tab');
}, F, out);
await measure(page, '5-body', async () => {
  await page.evaluate(() => { const ed = app.workspace.getMostRecentLeaf().view.editor; ed.setCursor({ line: ed.lastLine(), ch: 0 }); ed.focus(); });
  await page.keyboard.insertText('會議紀錄一行'); await page.keyboard.press('Enter');
}, F, out);
await br.close();
