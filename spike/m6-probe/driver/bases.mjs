import { connect } from './lib.mjs';
const { br, page } = await connect();
await page.evaluate(async () => { const leaf = app.workspace.getLeaf(false); await leaf.openFile(app.vault.getAbstractFileByPath('tasks.base')); });
await page.waitForTimeout(2000);
await page.screenshot({ path: process.argv[2] + '/s3-4-bases.png' });
console.log(await page.evaluate(() => {
  const root = app.workspace.getMostRecentLeaf().view.containerEl;
  const rows = [...root.querySelectorAll('.bases-tr')].slice(0, 3).map(r => r.outerHTML.slice(0, 900));
  return { viewType: app.workspace.getMostRecentLeaf().view.getViewType(), rows };
}));
await br.close();
