import { connect } from './lib.mjs';
const { br, page } = await connect();
for (const type of ['date', 'datetime']) {
  await page.evaluate(async (t) => { app.metadataTypeManager.setType('due', t); const leaf = app.workspace.getLeaf(false); await leaf.openFile(app.vault.getAbstractFileByPath('tasks.base')); }, type);
  await page.waitForTimeout(1500);
  const vals = await page.evaluate(() => [...app.workspace.getMostRecentLeaf().view.containerEl.querySelectorAll('.bases-td[data-property="note.due"] input')].map(i => [i.type, i.value]));
  await page.screenshot({ path: `${process.argv[2]}/s3-mixed-${type}.png` });
  console.log(type, JSON.stringify(vals));
}
await br.close();
