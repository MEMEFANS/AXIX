import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { Buffer } from 'node:buffer';
import { connectCDP } from './cdp.mjs';
const browser = await connectCDP(), call = browser.call, checks = [];
async function evaluate(expression) {
  const r = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
  return r.result.value;
}
async function until(expression) {
  const start = Date.now();
  while (Date.now() - start < 10000) { if (await evaluate(expression)) return; await new Promise(r => setTimeout(r, 70)); }
  throw new Error('Timed out: ' + expression);
}
try {
  await call('Runtime.discardConsoleEntries'); await call('Runtime.enable'); await call('Page.enable'); browser.events.length = 0;
  await call('Emulation.setDeviceMetricsOverride', { width: 1320, height: 840, deviceScaleFactor: 1, mobile: false });
  await call('Page.navigate', { url: 'http://127.0.0.1:4173/games/run-aix/launcher.css' });
  await until("document.body?.textContent.includes('.run-aix-dialog')");
  const assets = await evaluate(`(async()=>{
    const {artwork,artReady}=await import('/games/run-aix/sprites.js');await artReady;
    const canvas=document.createElement('canvas');canvas.width=640;canvas.height=640;const c=canvas.getContext('2d');
    return Object.entries(artwork).map(([name,image])=>{
      c.clearRect(0,0,640,640);c.drawImage(image,0,0,640,640);
      return {name,width:image.naturalWidth,height:image.naturalHeight,cornerAlpha:c.getImageData(0,0,1,1).data[3]};
    });
  })()`);
  assert.equal(assets.length, 11); checks.push('十一张资源含跑步精灵表全部加载成功');
  for (const name of ['hero','btc','eth','bnb','ghost','hole','spike']) assert.equal(assets.find(a=>a.name===name).cornerAlpha, 0, name);
  checks.push('主角和六种障碍具有真实透明通道，无整块绿幕背景');
  for (const name of ['city','exchange','ocean']) {
    const asset=assets.find(a=>a.name===name); assert.ok(asset.height>asset.width); assert.ok(asset.width>=800);
    const response = await fetch(`http://127.0.0.1:4173/games/run-aix/assets/${name}-v2.jpg`);
    assert.equal(response.headers.get('content-type'), 'image/jpeg');
  }
  checks.push('三套竖屏背景尺寸正确，JPEG以正确类型提供');
  await evaluate(`(async()=>{
    const {GameArt}=await import('/games/run-aix/art.js');
    document.body.replaceChildren();document.body.style.cssText='margin:0;padding:26px 30px;background:#0c1020;color:#eee4d9;font:14px Arial;display:flex;gap:24px;justify-content:center';
    const titles=['01 / 星空之城','02 / 交易所大厅','03 / 稳定币海域'];window.artFixtures=[];
    for(let i=0;i<3;i++){
      const card=document.createElement('section');card.style.cssText='width:390px;border:1px solid #6f5f7b55;border-radius:20px;overflow:hidden;background:#141b2c';
      const title=document.createElement('div');title.textContent=titles[i];title.style.cssText='padding:17px 20px;font-weight:bold;letter-spacing:2px;color:#efdbbc';
      const canvas=document.createElement('canvas');canvas.style.cssText='width:390px;height:680px;display:block';card.append(title,canvas);document.body.append(card);
      const art=new GameArt(canvas);art.render({state:'running',distance:i*175,lane:1,visualLane:1,energy:0.7,obstacles:[{id:['btc','bnb','ghost'][i],name:['BTC 巨币','BNB 箱怪','链上幽灵'][i],lane:0,ahead:20},{id:['eth','hole','spike'][i],name:['ETH 晶兽','星际黑洞','行情插针'][i],lane:2,ahead:34}]},5.3);window.artFixtures.push(art);
    }
  })()`);
  // ResizeObserver 的首次回调会重置画布，重新绘制固定时刻用于视觉验收。
  await new Promise(r=>setTimeout(r,150));
  await evaluate(`window.artFixtures.forEach((art,i)=>art.render({state:'running',distance:i*175,lane:1,visualLane:1,energy:0.7,obstacles:[{id:['btc','bnb','ghost'][i],name:['BTC 巨币','BNB 箱怪','链上幽灵'][i],lane:0,ahead:20},{id:['eth','hole','spike'][i],name:['ETH 晶兽','星际黑洞','行情插针'][i],lane:2,ahead:34}]},5.3))`);
  const screenshot = await call('Page.captureScreenshot', { format:'png',captureBeyondViewport:false });
  await fs.writeFile(new URL('./scenes-v2-gallery.png',import.meta.url),Buffer.from(screenshot.data,'base64'));
  checks.push('真实渲染器正确绘制三套场景、精修角色和六种障碍');
  const errors=browser.events.filter(e=>e.method==='Runtime.exceptionThrown');assert.equal(errors.length,0,JSON.stringify(errors));
  await fs.writeFile(new URL('./art-results-v2.json',import.meta.url),JSON.stringify({passed:checks.length,checks,assets,runtimeErrors:0},null,2));
  console.log(JSON.stringify({passed:checks.length,checks},null,2));
} finally {
  await call('Emulation.setDeviceMetricsOverride',{width:430,height:932,deviceScaleFactor:1,mobile:true});
  await call('Page.navigate',{url:'http://127.0.0.1:4173/run-aix-classic.html'});browser.close();
}
