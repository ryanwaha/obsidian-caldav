import { chromium } from 'playwright-core';
const br = await chromium.connectOverCDP('http://127.0.0.1:9223');
for (const p of br.contexts().flatMap(c => c.pages())) if ((await p.title()).startsWith('Settings')) { await p.evaluate(() => window.close()).catch(() => {}); console.log('closed', await p.title().catch(() => '')); }
await br.close();
