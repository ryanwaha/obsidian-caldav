// M6-1 Task 6 integration: server-mode projection against Radicale temp collections (vault-s, no LiveSync).
import { connect } from './lib.mjs';
import { readFileSync, existsSync, statSync } from 'node:fs';
const step = process.argv[2];
const H = process.env.HOME, V = `${H}/m6-spike/vault-s`;
const AUTH = 'Basic ' + Buffer.from('ryanw:' + readFileSync(`${H}/.config/radicale/password.txt`, 'utf8').trim()).toString('base64');
const B = 'http://127.0.0.1:5232/ryanw';
const dav = async (method, path, body, headers = {}) => { const r = await fetch(B + path, { method, body, headers: { Authorization: AUTH, ...headers } }); return r.status; };
const ics = (uid, summary, lines = []) => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//m6e2e//EN', 'BEGIN:VTODO', `UID:${uid}`, 'DTSTAMP:20261123T000000Z', 'CREATED:20261120T010203Z', `SUMMARY:${summary}`, ...lines, 'END:VTODO', 'END:VCALENDAR', ''].join('\r\n');
const put = (col, uid, summary, lines) => dav('PUT', `/${col}/${uid}.ics`, ics(uid, summary, lines), { 'Content-Type': 'text/calendar' });
const { br, page } = await connect('vault-s');
const ev = (f, a) => page.evaluate(f, a);
const sync = () => ev(async () => { const p = app.plugins.plugins['obsidian-caldav']; await p.syncNow(false, 'e2e'); await new Promise(r => setTimeout(r, 300)); await p.projection.reconcile(); await new Promise(r => setTimeout(r, 300)); return true; });
const setWl = (wl) => ev(async (wl) => { const p = app.plugins.plugins['obsidian-caldav']; p.settings.projectCollections = wl; await p.saveSettings(); }, wl);
const shortOf = (uid) => ev(async (u) => { const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(u))); let b = 0n; for (let i = 0; i < 5; i++) b = (b << 8n) | BigInt(d[i]); const A = '0123456789abcdefghjkmnpqrstvwxyz'; let o = ''; for (let i = 7; i >= 0; i--) o += A[Number((b >> BigInt(i * 5)) & 31n)]; return o; }, uid);
const cat = (rel) => existsSync(`${V}/${rel}`) ? readFileSync(`${V}/${rel}`, 'utf8') : '(missing)';
const ls = () => ev(() => app.vault.getFiles().map(f => f.path).filter(p => p.startsWith('_caldav/')).sort());
const log = (t, x) => console.log(`--- ${t}\n${typeof x === 'string' ? x : JSON.stringify(x)}`);

if (step === '1') {
  log('put a', await put('m6-e2e', 'e2e-a', '全天任務', ['DUE;VALUE=DATE:20261124', 'STATUS:NEEDS-ACTION']));
  log('put b', await put('m6-e2e', 'e2e-b', '定時任務', ['DUE;TZID=Asia/Taipei:20261125T093000', 'DESCRIPTION:備註第一行\\n第二行']));
  await sync();
  log('files', await ls());
  for (const u of ['e2e-a', 'e2e-b']) log(u, cat(`_caldav/${await shortOf(u)}.md`));
}
if (step === '2') {
  const a = await shortOf('e2e-a');
  await ev(async ({ a }) => { await app.vault.process(app.vault.getAbstractFileByPath(`_caldav/${a}.md`), t => t + '我的筆記\n'); await app.vault.create('note.md', `連到 [[${a}|全天任務]] 這裡\n`).catch(async () => {}); }, { a });
  await ev(() => { window.__mods = 0; app.vault.on('modify', f => { if (f.path.startsWith('_caldav/')) window.__mods++; }); });
  log('put a renamed', await put('m6-e2e', 'e2e-a', '全天任務（改名）', ['DUE;VALUE=DATE:20261124', 'STATUS:NEEDS-ACTION']));
  await sync();
  log('a', cat(`_caldav/${a}.md`)); log('modify count', await ev(() => window.__mods));
}
if (step === '3') {
  const a = await shortOf('e2e-a'), f = `${V}/_caldav/${a}.md`; const m0 = statSync(f).mtimeMs;
  await ev(() => { window.__mods = 0; });
  await sync(); log('mtime unchanged', statSync(f).mtimeMs === m0); log('modify count', await ev(() => window.__mods));
}
if (step === '4') {
  await setWl(['/ryanw/m6-e2e/', '/ryanw/m6-e2e2/']);
  const a = await shortOf('e2e-a'), n = await shortOf('e2e-a-moved');
  log('ios-style move: put new uid', await put('m6-e2e2', 'e2e-a-moved', '全天任務（改名）', ['DUE;VALUE=DATE:20261124', 'STATUS:NEEDS-ACTION']));
  log('delete old', await dav('DELETE', '/m6-e2e/e2e-a.ics'));
  await sync(); await sync();
  log('files', await ls()); log('new file', cat(`_caldav/${n}.md`)); log('old exists?', existsSync(`${V}/_caldav/${a}.md`)); log('note.md', cat('note.md'));
}
if (step === '5') {
  const b = await shortOf('e2e-b');
  log('MOVE b', await dav('MOVE', '/m6-e2e/e2e-b.ics', undefined, { Destination: `${B}/m6-e2e2/e2e-b.ics`, Overwrite: 'F' }));
  await sync(); await sync();
  log('files', await ls()); log('b', cat(`_caldav/${b}.md`));
}
if (step === '6') {
  const b = await shortOf('e2e-b');
  await ev(async ({ b }) => { await app.vault.process(app.vault.getAbstractFileByPath(`_caldav/${b}.md`), t => t + 'b 的筆記\n'); }, { b });
  log('DELETE b', await dav('DELETE', '/m6-e2e2/e2e-b.ics'));
  await sync(); await sync();
  log('b', cat(`_caldav/${b}.md`));
}
if (step === '7') {
  await ev(async () => { await app.vault.create('_caldav/foreign.md', '使用者自己的檔案\n'); });
  await sync();
  log('foreign', cat('_caldav/foreign.md'));
}
if (step === '8') {
  await ev(() => { window.__mods = 0; app.vault.on('modify', f => { if (f.path.startsWith('_caldav/')) window.__mods++; }); });
  await sync(); log('files', await ls()); log('modify count after restart', await ev(() => window.__mods));
}
await br.close();
