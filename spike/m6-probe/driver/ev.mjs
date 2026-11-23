// usage: node ev.mjs <vault-name> <file.js | -e "code">   (code is an async function body; `return` value is printed as JSON)
import { chromium } from 'playwright-core';
import { readFileSync } from 'node:fs';
const [vault, a, b] = process.argv.slice(2);
const body = a === '-e' ? b : readFileSync(a, 'utf8');
const br = await chromium.connectOverCDP('http://127.0.0.1:9223');
const pages = br.contexts().flatMap(c => c.pages());
let page = null;
for (const p of pages) { try { if (await p.evaluate(() => window.app?.vault?.getName?.()) === vault) { page = p; break; } } catch {} }
if (!page) { console.error('no window for vault', vault, await Promise.all(pages.map(p => p.title()))); process.exit(2); }
const out = await page.evaluate(new Function(`return (async () => { ${body} })()`));
console.log(JSON.stringify(out, null, 1));
await br.close();
