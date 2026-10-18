import puppeteer from 'puppeteer';

// Usage: node shot-mindmap.mjs <file-url> <out-png> [width] [height]
const url = process.argv[2] || 'file:///c:/Users/cy020/Desktop/AxiX-%E7%94%9F%E6%80%81%E6%80%9D%E7%BB%B4%E5%AF%BC%E5%9B%BE.html';
const out = process.argv[3] || 'c:/Users/cy020/Desktop/AxiX-生态思维导图.png';
const width = Number(process.argv[4] || 1920);
const height = Number(process.argv[5] || 1080);

const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  args: ['--no-sandbox']
});
const page = await browser.newPage();
await page.setViewport({ width, height, deviceScaleFactor: 2 });
await page.goto(url, { waitUntil: 'networkidle0' });
await new Promise(r => setTimeout(r, 800));
await page.screenshot({ path: out });
console.log('Saved:', out, `(${width}x${height} @2x)`);
await browser.close();
