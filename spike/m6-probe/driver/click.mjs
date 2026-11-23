import { chromium } from 'playwright-core';
const br = await chromium.connectOverCDP('http://127.0.0.1:9223');
const page = (await Promise.all(br.contexts().flatMap(c => c.pages()).map(async p => [p, await p.evaluate(() => window.app?.vault?.getName?.()).catch(() => null)]))).find(([, n]) => n === 'vault-a')[0];
const ev = (f) => page.evaluate(f);
const shot = (n) => page.screenshot({ path: `${process.argv[2]}/${n}.png` });
// A: cursor inside first link
await ev(() => { const ed = app.workspace.getMostRecentLeaf().view.editor; ed.setCursor({ line: 0, ch: 9 }); ed.focus(); });
await page.waitForTimeout(300);
console.log('A cursor-in-link line1:', await ev(() => { const l = app.workspace.getMostRecentLeaf().view.contentEl.querySelector('.cm-line'); return [l.querySelectorAll('.m6-probe-chip').length, l.textContent]; }));
await shot('s1-cursor-in-link');
// B: move cursor to end, click chip on line 2
await ev(() => { const ed = app.workspace.getMostRecentLeaf().view.editor; ed.setCursor({ line: ed.lastLine(), ch: 0 }); window.__m6log = []; });
await page.waitForTimeout(300);
const chips = page.locator('.cm-line .m6-probe-chip');
await chips.nth(1).click();
await page.waitForTimeout(500);
console.log('B after chip click:', await ev(() => { const v = app.workspace.getMostRecentLeaf().view; return { file: v.file.path, cursor: v.editor.getCursor(), log: window.__m6log.map(r => r.ev + ':' + (r.target || '')) }; }));
await shot('s1-after-chip-click');
// C: click link text on line 2
const link = page.locator('.cm-line').nth(1).locator('.cm-hmd-internal-link').first();
await link.click();
await page.waitForTimeout(800);
console.log('C after link click:', await ev(() => app.workspace.getActiveFile()?.path));
await shot('s1-after-link-click');
await br.close();
