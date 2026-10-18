import puppeteer from 'puppeteer-core';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const URL = 'http://localhost:8899/promo-guide.html';
const OUT = 'c:\\Users\\cy020\\Desktop\\WG-Grid-Studio-完整成交账本\\AxiX-零撸全攻略.png';

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--force-device-scale-factor=1', '--hide-scrollbars'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1080, height: 1200, deviceScaleFactor: 1 });
await page.goto(URL, { waitUntil: 'networkidle0', timeout: 60000 });
await sleep(1500);
const height = await page.evaluate(() => document.documentElement.scrollHeight);
console.log('page height:', height);
await page.setViewport({ width: 1080, height, deviceScaleFactor: 1 });
await sleep(800);
await page.screenshot({ path: OUT, clip: { x: 0, y: 0, width: 1080, height } });
await browser.close();
console.log('saved:', OUT);
