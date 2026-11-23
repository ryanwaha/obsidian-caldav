import { connect } from './lib.mjs';
import { readFileSync } from 'node:fs';
const H = process.env.HOME;
const AUTH = 'Basic ' + Buffer.from('ryanw:' + readFileSync(`${H}/.config/radicale/password.txt`, 'utf8').trim()).toString('base64');
const ics = (uid, summary, lines = []) => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//x//EN', 'BEGIN:VTODO', `UID:${uid}`, 'DTSTAMP:20261123T000000Z', `SUMMARY:${summary}`, ...lines, 'END:VTODO', 'END:VCALENDAR', ''].join('\r\n');
for (const [u, s, l] of [['fx-a', '分隔---', ['DUE:20261123T170000Z']], ['fx-b', '備註有分隔線', ['DESCRIPTION:上\\n---\\n下']]])
  console.log('PUT', u, (await fetch(`http://127.0.0.1:5232/ryanw/m6-e2e/${u}.ics`, { method: 'PUT', body: ics(u, s, l), headers: { Authorization: AUTH, 'Content-Type': 'text/calendar' } })).status);
const { br, page } = await connect('vault-s');
const run = () => page.evaluate(async () => { const p = app.plugins.plugins['obsidian-caldav']; await p.syncNow(false, 'fix'); await new Promise(r => setTimeout(r, 300)); await p.projection.reconcile(true); await new Promise(r => setTimeout(r, 500)); });
await run();
await page.evaluate(() => { window.__mods = 0; app.vault.on('modify', f => { if (f.path.startsWith('_caldav/')) window.__mods++; }); });
await run(); await run();
console.log('files', await page.evaluate(() => app.vault.getFiles().map(f => f.path).filter(p => p.startsWith('_caldav/'))));
console.log('modifies in 2 idle rounds', await page.evaluate(() => window.__mods));
for (const f of await page.evaluate(() => app.vault.getFiles().map(f => f.path).filter(p => p.startsWith('_caldav/')))) console.log(`== ${f}\n` + readFileSync(`${H}/m6-spike/vault-s/${f}`, 'utf8'));
await br.close();
