import { connect } from './lib.mjs';
import { existsSync } from 'node:fs';
const S = await connect('vault-a'), D = await connect('vault-b');
const P = '_caldav/bn3atfsv.md';
for (const X of [S, D]) await X.page.evaluate(() => { window.__ev = []; const t0 = Date.now(); for (const e of ['create', 'delete']) app.vault.on(e, (f) => { if (f.path === '_caldav/bn3atfsv.md') window.__ev.push(`${((Date.now() - t0) / 1000).toFixed(1)}s ${e}`); }); });
await D.page.evaluate(async (p) => { await app.vault.delete(app.vault.getAbstractFileByPath(p)); }, P);
const t0 = Date.now(); let back = null;
while (Date.now() - t0 < 120000) { if (existsSync(`${process.env.HOME}/m6-spike/vault-b/${P}`)) { back = (Date.now() - t0) / 1000; break; } await new Promise(r => setTimeout(r, 1000)); }
console.log('device restored after', back, 's');
console.log('server events', await S.page.evaluate(() => window.__ev)); console.log('device events', await D.page.evaluate(() => window.__ev));
await S.br.close(); await D.br.close();
