import { connect } from './lib.mjs';
const guard = `const c = app.plugins.plugins['obsidian-livesync']?.core; if (!c || c.settings.couchDB_DBNAME !== 'm6-spike' || !c.settings.couchDB_URI.includes('localhost')) throw new Error('ABORT wrong db');`;
const run = (p, body) => p.evaluate(new Function(`return (async () => { ${body} })()`));
const A = await connect('vault-a'), B = await connect('vault-b');
const down = run(B.page, `${guard} await c.rebuilder.fetchLocal(); return 'fetched'`).catch(e => 'fetch-err ' + e.message);
console.log(await Promise.race([down, new Promise(r => setTimeout(() => r('fetch-timeout'), 30000))]));
for (const P of [A, B]) console.log(await run(P.page, `${guard} c.settings.liveSync = true; c.replicator.openReplication(c.settings, true, false, false); await new Promise(r=>setTimeout(r,3000)); return app.vault.getName() + ' files=' + app.vault.getFiles().map(f=>f.path).join(',') + ' modals=' + document.querySelectorAll('.modal-container').length`));
await A.br.close(); await B.br.close();
