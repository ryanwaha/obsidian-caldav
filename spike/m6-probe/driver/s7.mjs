// S7: resolve a LiveSync conflict programmatically on one side (simulated headless server).
import { connect } from './lib.mjs';
const [side = 'vault-b', path = '_caldav/k3f9x2qa.md', status = 'completed'] = process.argv.slice(2);
const A = await connect('vault-a'), B = await connect('vault-b');
const S = side === 'vault-a' ? A : B;
const r = await S.page.evaluate(async ({ path, status }) => {
  const c = app.plugins.plugins['obsidian-livesync'].core;
  if (c.settings.couchDB_DBNAME !== 'm6-spike') throw new Error('ABORT');
  const doc = await c.localDatabase.getDBEntry(path, { conflicts: true }, false, true, true);
  if (!doc) return 'no doc';
  const revs = doc._conflicts ?? [];
  if (!revs.length) return 'no conflicts';
  const text = (d) => Array.isArray(d.data) ? d.data.join('') : d.data;
  const cur = text(doc);
  const other = await c.localDatabase.getDBEntry(path, { rev: revs[0] }, false, true, true);
  // policy: frontmatter field from "server" decision, body = current (identical in this scenario)
  const resolved = cur.replace(/^status: .*$/m, `status: ${status}`);
  const stored = await c.databaseFileAccess.storeContent(path, resolved);
  const del = await c.services.conflict.resolveByDeletingRevision(path, revs[0], 'm6-server');
  return { revs, curStatus: /status: (.*)/.exec(cur)[1], otherStatus: /status: (.*)/.exec(text(other))[1], stored, del: String(del) };
}, { path, status });
console.log(JSON.stringify(r));
await A.page.waitForTimeout(30000);
const files = await Promise.all([A, B].map(P => P.page.evaluate((p) => app.vault.read(app.vault.getAbstractFileByPath(p)), path)));
const modals = await Promise.all([A, B].map(P => P.page.evaluate(() => document.querySelectorAll('.modal-container').length)));
console.log('identical:', files[0] === files[1], 'statusA:', /status: (.*)/.exec(files[0])[1], 'statusB:', /status: (.*)/.exec(files[1])[1], 'modals:', modals);
console.log(files[0]);
await A.br.close(); await B.br.close();
