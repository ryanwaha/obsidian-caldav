import { connect } from './lib.mjs';
const { br, page } = await connect('vault-a');
await page.evaluate(async () => { app.metadataTypeManager.setType('due_time', 'text'); const leaf = app.workspace.getLeaf(false); await leaf.openFile(app.vault.getAbstractFileByPath('_caldav/k3f9x2qa.md'), { state: { mode: 'source', source: false } }); });
await page.waitForTimeout(1000);
const el = page.locator('.workspace-leaf.mod-active .metadata-property[data-property-key="due_time"] .metadata-input-longtext');
await el.click(); await page.keyboard.press('Control+A'); await page.keyboard.insertText('07:05'); await page.keyboard.press('Enter');
await page.waitForTimeout(1500);
console.log(await page.evaluate(async () => { const f = app.vault.getAbstractFileByPath('_caldav/k3f9x2qa.md'); const fm = app.metadataCache.getFileCache(f).frontmatter; return { line: (await app.vault.read(f)).split('\n').find(l => l.startsWith('due_time')), type: typeof fm.due_time, val: fm.due_time }; }));
await br.close();
