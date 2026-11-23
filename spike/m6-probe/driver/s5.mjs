import { connect } from './lib.mjs';
import { readFileSync } from 'node:fs';
const [scenario] = process.argv.slice(2);
const A = await connect('vault-a'), B = await connect('vault-b');
const F = '_caldav/k3f9x2qa.md';
const both = (f, arg) => Promise.all([A.page.evaluate(f, arg), B.page.evaluate(f, arg)]);
const guard = () => { const c = app.plugins.plugins['obsidian-livesync'].core; if (c.settings.couchDB_DBNAME !== 'm6-spike') throw new Error('wrong db'); return c; };
const open = `(${guard})().replicator.openReplication((${guard})().settings, true, false, false)`;
// pause
await both(new Function(`(${guard})().replicator.closeReplication(); return true`));
await A.page.waitForTimeout(1500);
const edits = {
  fm_vs_body: [ async (F) => { await app.fileManager.processFrontMatter(app.vault.getAbstractFileByPath(F), fm => { fm.status = 'in-process'; }); },
                async (F) => { await app.vault.process(app.vault.getAbstractFileByPath(F), t => t + 'B 在 body 加的一行\n'); } ],
  fm_diff_fields: [ async (F) => { await app.fileManager.processFrontMatter(app.vault.getAbstractFileByPath(F), fm => { fm.title = '交週報-A'; }); },
                    async (F) => { await app.fileManager.processFrontMatter(app.vault.getAbstractFileByPath(F), fm => { fm.due = '2027-01-05T08:00:00'; }); } ],
  fm_adjacent: [ async (F) => { await app.fileManager.processFrontMatter(app.vault.getAbstractFileByPath(F), fm => { fm.title = '交週報-A2'; }); },
                 async (F) => { await app.fileManager.processFrontMatter(app.vault.getAbstractFileByPath(F), fm => { fm.status = 'in-process'; }); } ],
  fm_server_meta: [ async (F) => { await app.fileManager.processFrontMatter(app.vault.getAbstractFileByPath(F), fm => { fm.status = 'needs-action'; }); },
                    async (F) => { await app.fileManager.processFrontMatter(app.vault.getAbstractFileByPath(F), fm => { fm._etag = '"e2"'; fm._hash = 'h9f3e00aa11bb22cc'; fm._sync = 'ok'; }); } ],
  fm_same_field: [ async (F) => { await app.fileManager.processFrontMatter(app.vault.getAbstractFileByPath(F), fm => { fm.status = 'completed'; }); },
                   async (F) => { await app.fileManager.processFrontMatter(app.vault.getAbstractFileByPath(F), fm => { fm.status = 'cancelled'; }); } ],
}[scenario];
await A.page.evaluate(edits[0], F); await B.page.evaluate(edits[1], F);
await A.page.waitForTimeout(2500);
// resume
await both(new Function(`${open}; return true`));
await A.page.waitForTimeout(30000);
const files = await both(async (F) => app.vault.read(app.vault.getAbstractFileByPath(F)), F);
const modals = await both(() => [...document.querySelectorAll('.modal-container .modal')].map(m => m.innerText.slice(0, 300)));
console.log(`### ${scenario}\n--- A:\n${files[0]}--- B:\n${files[1]}--- identical: ${files[0] === files[1]}\n--- modals A: ${JSON.stringify(modals[0])}\n--- modals B: ${JSON.stringify(modals[1])}`);
await A.br.close(); await B.br.close();
