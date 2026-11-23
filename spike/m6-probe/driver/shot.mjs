import { connect } from './lib.mjs';
const { br, page } = await connect(process.argv[2]);
await page.screenshot({ path: process.argv[3] });
console.log(await page.evaluate(() => [...document.querySelectorAll('.modal-container .modal')].map(m => m.innerText.slice(0, 600))));
await br.close();
