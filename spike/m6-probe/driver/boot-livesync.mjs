// Enable plugins, dismiss known first-run dialogs, upload from vault-a, fetch into vault-b, start live replication on both.
import { connect } from './lib.mjs';
const KNOWN = ['Trust author and enable plugins', 'OK', 'No, and do not ask again until the next release', 'No, never warn please'];
async function dismiss(page) {
  for (let round = 0; round < 6; round++) {
    let clicked = false;
    for (const t of KNOWN) {
      const b = page.locator('.modal-container button').filter({ hasText: new RegExp('^' + t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$') }).first();
      if (await b.count()) { await b.click().catch(() => {}); clicked = true; await page.waitForTimeout(800); }
    }
    if (!clicked) await page.waitForTimeout(1000);
  }
}
const guard = `const c = app.plugins.plugins['obsidian-livesync']?.core; if (!c || c.settings.couchDB_DBNAME !== 'm6-spike' || !c.settings.couchDB_URI.includes('localhost')) throw new Error('ABORT wrong db');`;
const run = (p, body) => p.evaluate(new Function(`return (async () => { ${body} })()`));
const A = await connect('vault-a'), B = await connect('vault-b');
for (const P of [A, B]) {
  await run(P.page, `app.plugins.setEnable(true); await app.plugins.loadManifests(); await app.plugins.enablePluginAndSave('m6-probe'); await app.plugins.enablePluginAndSave('obsidian-livesync');`);
  await P.page.waitForTimeout(2500); await dismiss(P.page);
}
const up = run(A.page, `${guard} await c.rebuilder.rebuildEverything(); return 'up'`).catch(e => 'up-err ' + e.message);
await A.page.waitForTimeout(3000); await dismiss(A.page); console.log(await Promise.race([up, new Promise(r => setTimeout(() => r('up-timeout'), 60000))]));
const down = run(B.page, `${guard} await c.rebuilder.fetchLocal(); return 'fetched'`).catch(e => 'fetch-err ' + e.message);
await B.page.waitForTimeout(3000); await dismiss(B.page); console.log(await Promise.race([down, new Promise(r => setTimeout(() => r('fetch-timeout'), 60000))]));
for (const P of [A, B]) { await dismiss(P.page); console.log(await run(P.page, `${guard} c.settings.liveSync = true; c.replicator.openReplication(c.settings, true, false, false); return app.vault.getName() + ' live, files=' + app.vault.getFiles().map(f=>f.path).join(',')`)); }
await A.br.close(); await B.br.close();
