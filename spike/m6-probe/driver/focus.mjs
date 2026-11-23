import { connect } from './lib.mjs';
const { br, page } = await connect(process.argv[2] ?? 'vault-b');
await page.bringToFront();
console.log(await page.evaluate(() => { window.focus(); window.dispatchEvent(new FocusEvent('focus')); return { activeIsMain: activeDocument === document, hasFocus: document.hasFocus() }; }));
await br.close();
