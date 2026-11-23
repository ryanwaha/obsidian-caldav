// M6-2 e2e: device (vault-b) edits projection files; server (vault-a, server mode) writes back to Radicale.
import { connect } from './lib.mjs';
import { readFileSync, existsSync } from 'node:fs';
const H = process.env.HOME, step = process.argv[2];
const AUTH = 'Basic ' + Buffer.from('ryanw:' + readFileSync(`${H}/.config/radicale/password.txt`, 'utf8').trim()).toString('base64');
const B = 'http://127.0.0.1:5232/ryanw';
const dav = async (method, path, body, headers = {}) => { const r = await fetch(B + path, { method, body, headers: { Authorization: AUTH, ...headers } }); return { status: r.status, text: await r.text() }; };
const ics = (uid, summary, lines = []) => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//e2e//EN', 'BEGIN:VTODO', `UID:${uid}`, 'DTSTAMP:20261123T000000Z', 'CREATED:20261120T010203Z', `SUMMARY:${summary}`, 'X-KEEP:keep-me', ...lines, 'END:VTODO', 'END:VCALENDAR', ''].join('\r\n');
const S = await connect('vault-a'), D = await connect('vault-b');
const srvSync = () => S.page.evaluate(async () => { const p = app.plugins.plugins['obsidian-caldav']; await p.syncNow(false, 'e2e'); await new Promise(r => setTimeout(r, 300)); await p.projection.reconcile(true); const n = await p.guard.resolveConflicts(); if (n) console.log('[e2e] resolved', n); window.__resolved = (window.__resolved ?? 0) + n; });
const sid = (uid) => S.page.evaluate(async (u) => { const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(u))); let b = 0n; for (let i = 0; i < 5; i++) b = (b << 8n) | BigInt(d[i]); const A = '0123456789abcdefghjkmnpqrstvwxyz'; let o = ''; for (let i = 7; i >= 0; i--) o += A[Number((b >> BigInt(i * 5)) & 31n)]; return o; }, uid);
const devRead = (p) => { const f = `${H}/m6-spike/vault-b/${p}`; return existsSync(f) ? readFileSync(f, 'utf8') : '(missing)'; };
const devFm = (p, fn) => D.page.evaluate(async ({ p, fn }) => { await app.fileManager.processFrontMatter(app.vault.getAbstractFileByPath(p), new Function('fm', fn)); }, { p, fn });
const until = async (label, cond, ms = 40000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await cond()) return console.log(`  ✓ ${label} (${Date.now() - t0} ms)`); await new Promise(r => setTimeout(r, 1000)); } console.log(`  ✗ ${label} (timeout)`); };
const get = async (col, uid) => (await dav('GET', `/${col}/${uid}.ics`)).text.replace(/\r\n[ \t]/g, '');
const line = (s, k) => s.split(/\r?\n/).find(l => l.startsWith(k)) ?? '(none)';
const log = (t, x) => console.log(`--- ${t}: ${typeof x === 'string' ? x : JSON.stringify(x)}`);

if (step === 'seed') {
  log('put e-a', (await dav('PUT', '/m6-e2e/e-a.ics', ics('e-a', '原標題', ['DUE;VALUE=DATE:20261124', 'STATUS:NEEDS-ACTION']), { 'Content-Type': 'text/calendar' })).status);
  log('put e-r', (await dav('PUT', '/m6-e2e/e-r.ics', ics('e-r', '每週任務', ['DTSTART;VALUE=DATE:20261123', 'DUE;VALUE=DATE:20261123', 'RRULE:FREQ=WEEKLY', 'STATUS:NEEDS-ACTION']), { 'Content-Type': 'text/calendar' })).status);
  await srvSync();
  const a = await sid('e-a'); await until('device has e-a', () => devRead(`_caldav/${a}.md`).includes('原標題'));
  await D.page.evaluate(async (a) => { await app.vault.process(app.vault.getAbstractFileByPath(`_caldav/${a}.md`), t => t + '裝置上的筆記\n'); }, a);
  await new Promise(r => setTimeout(r, 4000));
}
const a = await sid('e-a'), r = await sid('e-r'), A = `_caldav/${a}.md`, R = `_caldav/${r}.md`;
const afterEdit = async () => { await new Promise(r => setTimeout(r, 4000)); await srvSync(); };
if (step === '1') {
  await devFm(A, "fm.title = '裝置改的標題'"); await afterEdit();
  await until('Radicale SUMMARY updated', async () => (await get('m6-e2e', 'e-a')).includes('SUMMARY:裝置改的標題'));
  const s = await get('m6-e2e', 'e-a'); log('X-KEEP kept', s.includes('X-KEEP:keep-me'));
  await srvSync(); await until('device _etag refreshed', async () => { const t = devRead(A); return t.includes('裝置改的標題') && !t.includes('_sync: rejected'); });
  log('device file', devRead(A));
}
if (step === '2') { await devFm(A, "fm.status = 'completed'"); await afterEdit(); await until('STATUS:COMPLETED', async () => { const s = await get('m6-e2e', 'e-a'); return s.includes('STATUS:COMPLETED') && /^COMPLETED:/m.test(s) && s.includes('PERCENT-COMPLETE:100'); }); }
if (step === '3') { await devFm(A, "fm.due_time = '09:30'"); await afterEdit(); await until('DUE TZID Taipei', async () => (await get('m6-e2e', 'e-a')).includes('DUE;TZID=Asia/Taipei:20261124T093000')); }
if (step === '4') {
  await devFm(A, "fm.list = 'm6-e2e2'"); await afterEdit(); await srvSync();
  await until('object in e2e2, UID kept', async () => (await get('m6-e2e2', 'e-a')).includes('UID:e-a'));
  log('old location', (await dav('GET', '/m6-e2e/e-a.ics')).status); await srvSync();
  await until('device list updated, same filename', async () => devRead(A).includes('list: m6-e2e2'));
}
if (step === '5') { await devFm(A, "fm._etag = 'hacked'"); await afterEdit(); await until('_etag rolled back', async () => !devRead(A).includes('hacked')); }
if (step === '6') {
  const before = await get('m6-e2e', 'e-r');
  await devFm(R, "fm.status = 'completed'"); await afterEdit();
  await until('recurring status rolled back + rejected', async () => { const t = devRead(R); return t.includes('status: needs-action') && t.includes('_sync: rejected'); });
  log('msg', line(devRead(R), '_sync_msg')); log('Radicale unchanged', (await get('m6-e2e', 'e-r')) === before);
}
if (step === '7') {
  await D.page.evaluate(async (p) => { await app.vault.delete(app.vault.getAbstractFileByPath(p)); }, A);
  await new Promise(r => setTimeout(r, 6000));
  await until('device file restored with body', async () => devRead(A).includes('裝置上的筆記'));
}
if (step === '8') {
  await devFm(A, "fm._request = 'delete'"); await afterEdit(); await srvSync();
  await until('Radicale object gone', async () => (await dav('GET', '/m6-e2e2/e-a.ics')).status === 404);
  await srvSync(); await until('device _deleted true, body kept', async () => { const t = devRead(A); return t.includes('_deleted: true') && t.includes('裝置上的筆記') && !t.includes('_request'); });
}
if (step === '9') {
  log('put e-c', (await dav('PUT', '/m6-e2e/e-c.ics', ics('e-c', '衝突前', ['STATUS:NEEDS-ACTION']), { 'Content-Type': 'text/calendar' })).status);
  await srvSync(); const c = await sid('e-c'), C = `_caldav/${c}.md`;
  await until('device has e-c', () => devRead(C).includes('衝突前'));
  const pause = (P) => P.page.evaluate(() => app.plugins.plugins['obsidian-livesync'].core.replicator.closeReplication());
  const resume = (P) => P.page.evaluate(() => { const c = app.plugins.plugins['obsidian-livesync'].core; c.replicator.openReplication(c.settings, true, false, false); });
  await pause(S); await pause(D); await new Promise(r => setTimeout(r, 1500));
  await devFm(C, "fm.title = '裝置版A'");
  log('server-side change', (await dav('PUT', '/m6-e2e/e-c.ics', ics('e-c', '伺服器版B', ['STATUS:NEEDS-ACTION']), { 'Content-Type': 'text/calendar' })).status);
  await srvSync(); await new Promise(r => setTimeout(r, 1500));
  await resume(S); await resume(D); await new Promise(r => setTimeout(r, 8000)); await srvSync(); await new Promise(r => setTimeout(r, 6000));
  const srvFile = readFileSync(`${H}/m6-spike/vault-a/${C}`, 'utf8');
  log('device == server', devRead(C) === srvFile); log('title', line(srvFile, 'title')); log('_conflict', srvFile.split('_conflict:')[1]?.split('\n').slice(0, 4).join(' | ') ?? '(none)');
  const set = (await import('node:child_process')).execSync(`bash -c 'set -a; . ~/docker/couchdb/.env; set +a; curl -s -u "$COUCHDB_USER:$COUCHDB_PASSWORD" "http://localhost:5984/m6-spike/%2F_caldav%2F${c}.md?conflicts=true"'`).toString();
  log('couch _conflicts', JSON.parse(set)._conflicts ?? 'none');
  log('guard resolved count', await S.page.evaluate(() => window.__resolved ?? 0));
}
if (step === '10') {
  log('put e-t', (await dav('PUT', '/m6-e2e/e-t.ics', ics('e-t', '時間測試', ['DUE;VALUE=DATE:20261201']), { 'Content-Type': 'text/calendar' })).status);
  await srvSync(); const t = `_caldav/${await sid('e-t')}.md`; await until('device has e-t', () => devRead(t).includes('時間測試'));
  await devFm(t, "fm.due_time = '25:00'"); await afterEdit();
  await until('25:00 rejected & rolled back', async () => { const x = devRead(t); return line(x, 'due_time') === '(none)' && x.includes('_sync: rejected'); });
  log('msg', line(devRead(t), '_sync_msg')); log('Radicale DUE', line(await get('m6-e2e', 'e-t'), 'DUE'));
}
if (step === '12') {
  log('put e-m', (await dav('PUT', '/m6-e2e/e-m.ics', ics('e-m', '一起改', ['STATUS:NEEDS-ACTION']), { 'Content-Type': 'text/calendar' })).status);
  await srvSync(); const M = `_caldav/${await sid('e-m')}.md`; await until('device has e-m', () => devRead(M).includes('一起改'));
  await devFm(M, "fm.title = '改名又搬家'; fm.list = 'm6-e2e2'"); await afterEdit(); await srvSync(); await srvSync();
  await until('title + list both applied on server', async () => (await get('m6-e2e2', 'e-m')).includes('SUMMARY:改名又搬家'));
  await until('device shows both, ok', async () => { const t = devRead(M); return t.includes('改名又搬家') && t.includes('list: m6-e2e2') && t.includes('_sync: ok'); });
}
if (step === '13') {
  log('put e-n', (await dav('PUT', `/m6-e2e/${process.env.NUID ?? 'e-n'}.ics`, ics(process.env.NUID ?? 'e-n', '改名測試', ['STATUS:NEEDS-ACTION']), { 'Content-Type': 'text/calendar' })).status);
  await srvSync(); const N = `_caldav/${await sid(process.env.NUID ?? 'e-n')}.md`; await until('device has e-n', () => devRead(N).includes('改名測試'));
  await D.page.evaluate(async (p) => { await app.vault.process(app.vault.getAbstractFileByPath(p), t => t + 'n 的筆記\n'); }, N);
  await new Promise(r => setTimeout(r, 3000));
  await D.page.evaluate(async (p) => { await app.fileManager.renameFile(app.vault.getAbstractFileByPath(p), '_caldav/我改的名字.md'); }, N);
  await new Promise(r => setTimeout(r, 8000));
  await until('original path back on device, body kept, no stray copy', async () => devRead(N).includes('n 的筆記') && devRead('_caldav/我改的名字.md') === '(missing)');
}
if (step === '11') {
  for (const P of [S, D]) await P.page.evaluate(() => { window.__m = 0; app.vault.on('modify', f => { if (f.path.startsWith('_caldav/')) window.__m++; }); });
  await srvSync(); await new Promise(r => setTimeout(r, 6000)); await srvSync(); await new Promise(r => setTimeout(r, 4000));
  log('modify server/device', [await S.page.evaluate(() => window.__m), await D.page.evaluate(() => window.__m)]);
}
await S.br.close(); await D.br.close();
