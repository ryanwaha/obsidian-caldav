import { connect, measure } from './lib.mjs';
const out = process.argv[2]; const F = process.env.HOME + '/m6-spike/vault-a/_caldav/k3f9x2qa.md';
const { br, page } = await connect();
const cell = page.locator('.workspace-leaf.mod-active .bases-tr:has([data-href="_caldav/k3f9x2qa.md"]) .bases-td[data-property="note.status"] .metadata-input-longtext');
await measure(page, '4-bases-status', async () => { await cell.click(); await page.keyboard.press('Control+A'); await page.keyboard.insertText('completed'); await page.keyboard.press('Enter'); }, F, out);
await measure(page, '4b-bases-due', async () => {
  const d = page.locator('.workspace-leaf.mod-active .bases-tr:has([data-href="_caldav/k3f9x2qa.md"]) .bases-td[data-property="note.due"] input');
  await d.click(); await d.fill('2026-12-24T10:00'); await page.keyboard.press('Enter');
}, F, out);
await br.close();
