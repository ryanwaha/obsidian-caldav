import { chromium } from 'playwright-core';
import { readFileSync } from 'node:fs';
export async function connect(vault = 'vault-a') {
  const br = await chromium.connectOverCDP('http://127.0.0.1:9223');
  const page = (await Promise.all(br.contexts().flatMap(c => c.pages()).map(async p => [p, await p.evaluate(() => window.app?.vault?.getName?.()).catch(() => null)]))).find(([, n]) => n === vault)[0];
  return { br, page };
}
export async function measure(page, label, fn, file, outDir) {
  await page.evaluate(() => { window.__m6log = []; });
  await fn();
  await page.waitForTimeout(+(process.env.WAIT||2500));
  const log = await page.evaluate(() => { const L = window.__m6log; const t0 = L[0]?.t ?? 0; return L.map(r => `${r.ev}+${r.t - t0}ms ${r.fm ? JSON.stringify({ title: r.fm.title, status: r.fm.status, due: r.fm.due }) : ''}`); });
  if (outDir) await page.screenshot({ path: `${outDir}/s3-${label}.png` });
  console.log(`## ${label}\n` + log.join('\n') + '\n--- file:\n' + readFileSync(file, 'utf8'));
}
