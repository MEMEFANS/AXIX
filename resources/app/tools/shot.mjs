import puppeteer from 'puppeteer';

const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  args: ['--no-sandbox']
});
const page = await browser.newPage({ viewport: { width: 1080, height: 1920 } });
await page.goto('http://localhost:8765/policy-posters.html', { waitUntil: 'networkidle0' });
await new Promise(r => setTimeout(r, 800));

// Poster 1: 工作室扶持
const p1 = await page.$('#poster1');
await p1.screenshot({ path: 'c:/Users/cy020/Desktop/axiX工作室扶持政策.png' });
console.log('Poster 1 saved');

// Poster 2: 级别扶持
const p2 = await page.$('#poster2');
await p2.screenshot({ path: 'c:/Users/cy020/Desktop/axiX级别扶持政策.png' });
console.log('Poster 2 saved');

await browser.close();
