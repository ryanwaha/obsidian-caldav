import { connect, measure } from './lib.mjs';
const out = process.argv[2]; const F = process.env.HOME + '/m6-spike/vault-a/_caldav/k3f9x2qa.md';
const { br, page } = await connect();
await page.evaluate(async () => { app.metadataTypeManager.setType('due', 'date'); const f = app.vault.getAbstractFileByPath('_caldav/k3f9x2qa.md'); await app.fileManager.processFrontMatter(f, fm => { fm.due = '2026-11-24'; }); const leaf = app.workspace.getLeaf(false); await leaf.openFile(f, { state: { mode: 'source', source: false } }); });
await page.waitForTimeout(1500);
const prop = (k) => page.locator(`.workspace-leaf.mod-active .metadata-property[data-property-key="${k}"] .metadata-property-value`);
await measure(page, '2-date', async () => { const i = prop('due').locator('input'); await i.click(); await i.fill('2026-12-01'); await page.locator('.workspace-leaf.mod-active .cm-content').click({ position: { x: 5, y: 5 } }); }, F, out);
await measure(page, '2b-date-keys', async () => { const i = prop('due').locator('input'); await i.click(); await page.keyboard.type('12152026'); }, F, out);
await measure(page, '3-datetime', async () => {
  await page.evaluate(() => app.metadataTypeManager.setType('due', 'datetime')); await page.waitForTimeout(1000);
  const i = prop('due').locator('input'); await i.click(); await i.fill('2026-12-01T09:30'); await page.locator('.workspace-leaf.mod-active .cm-content').click({ position: { x: 5, y: 5 } });
}, F, out);
await br.close();
