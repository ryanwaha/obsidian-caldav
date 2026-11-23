// S9: can the receiving vault tell LiveSync-applied changes from local user actions, at event time?
import { connect } from './lib.mjs';
const A = await connect('vault-a'), B = await connect('vault-b');
await B.page.evaluate(() => {
  const c = app.plugins.plugins['obsidian-livesync'].core;
  const sam = c._serviceModules.storageAccess.vaultAccess.storageAccessManager;
  window.__s9 = [];
  const rec = (ev, f, extra = {}) => { if (!f.path.startsWith('_caldav/') && !(extra.old || '').startsWith('_caldav/')) return;
    window.__s9.push({ ev, path: f.path, processing: sam.isFileProcessing(f.path) || (extra.old ? sam.isFileProcessing(extra.old) : false), touched: f.stat ? sam.recentlyTouched({ path: f.path, stat: f.stat }) : null, ...extra }); };
  app.vault.on('modify', f => rec('modify', f)); app.vault.on('create', f => rec('create', f));
  app.vault.on('delete', f => rec('delete', f)); app.vault.on('rename', (f, old) => rec('rename', f, { old }));
});
const step = async (who, label, fn) => { await B.page.evaluate(l => window.__s9.push({ mark: l }), `${who}:${label}`); await (who === 'A' ? A : B).page.evaluate(fn); await A.page.waitForTimeout(6000); };
await step('A', 'modify', async () => { await app.fileManager.processFrontMatter(app.vault.getAbstractFileByPath('_caldav/k3f9x2qa.md'), fm => { fm.title = 'A改'; }); });
await step('A', 'create', async () => { await app.vault.create('_caldav/zzzz0001.md', '---\n_uid: z1\n---\n'); });
await step('A', 'rename', async () => { await app.fileManager.renameFile(app.vault.getAbstractFileByPath('_caldav/zzzz0001.md'), '_caldav/zzzz0002.md'); });
await step('A', 'delete', async () => { await app.vault.delete(app.vault.getAbstractFileByPath('_caldav/zzzz0002.md')); });
await step('B', 'modify', async () => { await app.fileManager.processFrontMatter(app.vault.getAbstractFileByPath('_caldav/k3f9x2qa.md'), fm => { fm.title = 'B改'; }); });
await step('B', 'create', async () => { await app.vault.create('_caldav/zzzz0003.md', '---\n_uid: z3\n---\n'); });
await step('B', 'rename', async () => { await app.fileManager.renameFile(app.vault.getAbstractFileByPath('_caldav/zzzz0003.md'), '_caldav/zzzz0004.md'); });
await step('B', 'delete', async () => { await app.vault.delete(app.vault.getAbstractFileByPath('_caldav/zzzz0004.md')); });
for (const r of await B.page.evaluate(() => window.__s9)) console.log(JSON.stringify(r));
await A.br.close(); await B.br.close();
