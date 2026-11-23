// M6-3 e2e: device (vault-b, client mode) operates chips; server (vault-a) writes back to Radicale.
import { connect } from './lib.mjs';
import { readFileSync, existsSync } from 'node:fs';
const H = process.env.HOME, step = process.argv[2];
const AUTH = 'Basic ' + Buffer.from('ryanw:' + readFileSync(`${H}/.config/radicale/password.txt`, 'utf8').trim()).toString('base64');
const B = 'http://127.0.0.1:5232/ryanw';
const dav = async (method, path, body, headers = {}) => { const r = await fetch(B + path, { method, body, headers: { Authorization: AUTH, ...headers } }); return { status: r.status, text: (await r.text()).replace(/\r\n[ \t]/g, '') }; };
const ics = (uid, summary, lines = []) => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//e2e//EN', 'BEGIN:VTODO', `UID:${uid}`, 'DTSTAMP:20261123T000000Z', 'CREATED:20261120T010203Z', `SUMMARY:${summary}`, ...lines, 'END:VTODO', 'END:VCALENDAR', ''].join('\r\n');
const put = (col, uid, s, l) => dav('PUT', `/${col}/${uid}.ics`, ics(uid, s, l), { 'Content-Type': 'text/calendar' });
const S = await connect('vault-a'), D = await connect('vault-b');
const dp = D.page;
const srvSync = () => S.page.evaluate(async () => { const p = app.plugins.plugins['obsidian-caldav']; await p.syncNow(false, 'e2e'); await new Promise(r => setTimeout(r, 300)); await p.projection.reconcile(true); await p.guard.resolveConflicts(); });
const sid = (uid) => S.page.evaluate(async (u) => { const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(u))); let b = 0n; for (let i = 0; i < 5; i++) b = (b << 8n) | BigInt(d[i]); const A = '0123456789abcdefghjkmnpqrstvwxyz'; let o = ''; for (let i = 7; i >= 0; i--) o += A[Number((b >> BigInt(i * 5)) & 31n)]; return o; }, uid);
const dev = (p) => { const f = `${H}/m6-spike/vault-b/${p}`; return existsSync(f) ? readFileSync(f, 'utf8') : '(missing)'; };
const until = async (label, cond, ms = 40000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await cond()) return console.log(`  ✓ ${label} (${Date.now() - t0} ms)`); } catch {} await new Promise(r => setTimeout(r, 1000)); } console.log(`  ✗ ${label} (timeout)`); };
const pump = async (n = 2) => { for (let i = 0; i < n; i++) { await new Promise(r => setTimeout(r, 3500)); await srvSync(); } };
const openNote = (mode = 'source') => dp.evaluate(async (mode) => { const leaf = app.workspace.getLeaf(false); await leaf.openFile(app.vault.getAbstractFileByPath('note.md'), { state: { mode, source: false } }); await new Promise(r => setTimeout(r, 800)); }, mode);
const chip = (target) => dp.locator(`.workspace-leaf.mod-active .cm-content .m6-chip[data-target="${target}"]`).first();
const log = (t, x) => console.log(`--- ${t}: ${typeof x === 'string' ? x : JSON.stringify(x)}`);
const notices = () => dp.evaluate(() => [...document.querySelectorAll('.notice')].map(n => n.textContent));

const a = await sid('e-a'), r = await sid('e-r'), A = `_caldav/${a}.md`, R = `_caldav/${r}.md`;
if (step === 'seed') {
  log('put', [(await put('m6-e2e', 'e-a', '原標題', ['DUE;VALUE=DATE:20261124', 'STATUS:NEEDS-ACTION'])).status, (await put('m6-e2e', 'e-r', '每週任務', ['DTSTART;VALUE=DATE:20261123', 'DUE;VALUE=DATE:20261123', 'RRULE:FREQ=WEEKLY', 'STATUS:NEEDS-ACTION'])).status]);
  await srvSync(); await until('device has projections', () => dev(A).includes('原標題') && dev(R).includes('每週任務'));
  await dp.evaluate(async ({ a, r }) => { await app.vault.create('note.md', `今天 [[${a}|原標題]] 要做\n還有 [[${r}|每週任務]]\n`); }, { a, r });
  await new Promise(r => setTimeout(r, 3000));
}
if (step === '1') {
  await openNote(); await dp.evaluate(() => { const ed = app.workspace.getMostRecentLeaf().view.editor; ed.setCursor({ line: ed.lastLine(), ch: 0 }); });
  log('LP chips', await dp.locator('.workspace-leaf.mod-active .cm-content .m6-chip').count());
  await chip(A).locator('.m6-chip__check').click();
  log('file still note.md', await dp.evaluate(() => app.workspace.getActiveFile()?.path));
  await pump(); await until('Radicale STATUS:COMPLETED', async () => (await dav('GET', '/m6-e2e/e-a.ics')).text.includes('STATUS:COMPLETED'));
  await openNote('preview'); log('reading-mode chips', await dp.locator('.workspace-leaf.mod-active .markdown-preview-view .m6-chip').count());
  await dp.screenshot({ path: `${process.env.SHOT ?? '/tmp'}/m6-3-reading.png` });
}
if (step === '2') {
  await openNote(); await chip(A).locator('.m6-chip__date').click(); await dp.waitForTimeout(500);
  const inputs = dp.locator('.modal-container input'); await inputs.nth(0).fill('2026-12-05'); await inputs.nth(1).fill('14:15');
  await dp.locator('.modal-container button', { hasText: '儲存' }).click();
  await pump(); await until('Radicale DUE updated', async () => (await dav('GET', '/m6-e2e/e-a.ics')).text.includes('DUE;TZID=Asia/Taipei:20261205T141500'));
}
if (step === '3') { await openNote(); log('recurring checkbox disabled', await chip(R).locator('.m6-chip__check').isDisabled()); }
if (step === '4') {
  await put('m6-e2e', 'e-a', '伺服器改的標題', ['DUE;TZID=Asia/Taipei:20261205T141500', 'STATUS:COMPLETED']); await srvSync();
  await until('device projection has new title', () => dev(A).includes('伺服器改的標題'));
  await openNote(); await until('chip shows ↻', async () => (await chip(A).locator('.m6-chip__changed').count()) === 1);
  await chip(A).locator('.m6-chip__more').click(); await dp.waitForTimeout(400);
  await dp.locator('.menu .menu-item', { hasText: '更新這篇筆記的連結標籤' }).click(); await dp.waitForTimeout(1000);
  log('note.md', dev('note.md').split('\n')[0]);
}
if (step === '5') {
  await openNote(); await dp.evaluate(() => { const ed = app.workspace.getMostRecentLeaf().view.editor; ed.setCursor({ line: ed.lastLine(), ch: 0 }); ed.focus(); app.commands.executeCommandById('obsidian-caldav:new-task'); });
  await dp.waitForTimeout(600);
  const inputs = dp.locator('.modal-container input'); await inputs.nth(0).fill('裝置新建的任務'); await inputs.nth(1).fill('2026-12-10');
  await dp.locator('.modal-container button', { hasText: '建立' }).click(); await dp.waitForTimeout(3500);
  const line = dev('note.md').split('\n').find(l => l.includes('裝置新建的任務')) ?? ''; log('inserted', line);
  const id = /\[\[([0-9a-z]{8})\|/.exec(line)?.[1]; const N = `_caldav/${id}.md`;
  await pump(3); await until('server created object in Radicale', async () => (await dav('PROPFIND', '/m6-e2e/', '<propfind xmlns="DAV:"><prop><getetag/></prop></propfind>', { Depth: '1' })).text.split('<href>').length > 3);
  await pump(); await until('device file got _etag, chip ok', async () => dev(N).includes('_etag:') && (await openNote(), (await chip(N).getAttribute('class')).includes('m6-chip--ok')));
}
if (step === '6') {
  const body0 = dev(A);
  await dp.evaluate(async (p) => { await app.vault.delete(app.vault.getAbstractFileByPath(p)); }, A);
  await until('locally deleted file restored quickly', () => dev(A) === body0, 4000);
  log('notice', (await notices()).find(n => n.includes('已還原')) ?? '(none)');
  await put('m6-e2e2', 'e-r-moved', '每週任務', ['DTSTART;VALUE=DATE:20261123', 'DUE;VALUE=DATE:20261123', 'RRULE:FREQ=WEEKLY', 'STATUS:NEEDS-ACTION']);
  await dav('DELETE', '/m6-e2e/e-r.ics'); await pump(3);
  const Rn = `_caldav/${await sid('e-r-moved')}.md`;
  await until('server move reached device as rename; old path NOT restored', async () => dev(Rn).includes('每週任務') && dev(R) === '(missing)');
  await new Promise(r => setTimeout(r, 6000)); log('old path still missing after 6s', dev(R) === '(missing)'); log('note link updated', dev('note.md').includes(Rn.slice(8, 16)));
}
if (step === '7') {
  for (const choice of ['用我的', '用伺服器的']) {
    const pause = (P) => P.page.evaluate(() => app.plugins.plugins['obsidian-livesync'].core.replicator.closeReplication());
    const resume = (P) => P.page.evaluate(() => { const c = app.plugins.plugins['obsidian-livesync'].core; c.replicator.openReplication(c.settings, true, false, false); });
    await pause(S); await pause(D); await new Promise(r => setTimeout(r, 1500));
    const mine = `裝置版-${choice}`, theirs = `伺服器版-${choice}`;
    await dp.evaluate(async ({ p, t }) => { await app.fileManager.processFrontMatter(app.vault.getAbstractFileByPath(p), fm => { fm.title = t; }); }, { p: A, t: mine });
    await put('m6-e2e', 'e-a', theirs, ['DUE;TZID=Asia/Taipei:20261205T141500', 'STATUS:COMPLETED']); await srvSync(); await new Promise(r => setTimeout(r, 1500));
    await resume(S); await resume(D); await pump(3);
    await until(`device notice for conflict (${choice})`, async () => (await notices()).some(n => n.includes('有衝突')));
    await dp.locator('.notice', { hasText: '有衝突' }).first().click(); await dp.waitForTimeout(500);
    await dp.locator('.modal-container button', { hasText: choice }).click(); await pump(3);
    const want = choice === '用我的' ? mine : theirs;
    await until(`Radicale SUMMARY = ${want}`, async () => (await dav('GET', '/m6-e2e/e-a.ics')).text.includes(`SUMMARY:${want}`));
    await until(`device title = ${want}, _conflict cleared`, () => dev(A).includes(`title: ${want}`) && !dev(A).includes('_conflict'));
  }
}
if (step === '8') {
  const Rn = `_caldav/${await sid('e-r-moved')}.md`;
  await dp.evaluate(async (p) => { await app.fileManager.processFrontMatter(app.vault.getAbstractFileByPath(p), fm => { fm.status = 'completed'; }); }, Rn);
  await pump(2); await until('device notice for rejection', async () => (await notices()).some(n => n.includes('沒有被接受')));
}
if (step === '10') {
  const body0 = dev(A);
  await dp.evaluate(async (p) => { await app.fileManager.renameFile(app.vault.getAbstractFileByPath(p), '_caldav/裝置上改的名字.md'); }, A);
  await until('device rename undone locally', () => dev(A) === body0 && dev('_caldav/裝置上改的名字.md') === '(missing)', 5000);
  await pump(2); await new Promise(r => setTimeout(r, 15000)); await pump(1);
  const srv = (p) => { const f = `${H}/m6-spike/vault-a/${p}`; return existsSync(f) ? readFileSync(f, 'utf8') : '(missing)'; };
  log('server has original path, no stray', srv(A) !== '(missing)' && srv('_caldav/裝置上改的名字.md') === '(missing)');
  log('device still consistent', dev(A) === srv(A));
}
if (step === '9') {
  for (const P of [S, D]) await P.page.evaluate(() => { window.__m = 0; app.vault.on('modify', f => { if (f.path.startsWith('_caldav/')) window.__m++; }); });
  await pump(2); await new Promise(r => setTimeout(r, 4000));
  log('modify server/device', [await S.page.evaluate(() => window.__m), await dp.evaluate(() => window.__m)]);
}
await S.br.close(); await D.br.close();
