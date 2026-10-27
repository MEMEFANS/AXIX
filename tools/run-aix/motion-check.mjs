import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { Buffer } from 'node:buffer';
import { connectCDP } from './cdp.mjs';
const browser=await connectCDP(), call=browser.call;
async function evaluate(expression) {
 const r=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});
 if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails));return r.result.value;
}
try {
 await call('Runtime.enable');await call('Page.enable');
 await call('Emulation.setDeviceMetricsOverride',{width:430,height:760,deviceScaleFactor:1,mobile:false});
 await call('Page.navigate',{url:'http://127.0.0.1:4173/games/run-aix/launcher.css'});
 await new Promise(r=>setTimeout(r,250));
 await evaluate(`(async()=>{
 const {GameArt}=await import('/games/run-aix/art.js');const {artwork,artReady}=await import('/games/run-aix/sprites.js');await artReady;
 window.motion=await import('/games/run-aix/runner-animation.js');window.projection=await import('/games/run-aix/world-motion.js');
 document.body.innerHTML='<canvas style="display:block;width:430px;height:760px"></canvas>';document.body.style='margin:0;background:#0d1020';
 window.art=new GameArt(document.querySelector('canvas'));window.s={state:'running',distance:60,lane:1,visualLane:1,energy:0,time:8,obstacles:[{id:'btc',name:'BTC',lane:0,ahead:12}]};
 window.paint=(d,t)=>{s.distance=d;art.render(s,t);return art.canvas.toDataURL()};
 window.sheet=artwork.runCycle;
 })()`);
 await new Promise(r=>setTimeout(r,100));
 const frames=await evaluate(`Array.from({length:8},(_,i)=>paint(56+i*.7+.01,8))`);
 assert.equal(new Set(frames).size,8);
 const isolated=await evaluate(`(()=>{const c=document.createElement('canvas');c.width=200;c.height=260;const ctx=c.getContext('2d');return Array.from({length:8},(_,i)=>{ctx.clearRect(0,0,200,260);motion.drawRunner(ctx,sheet,100,240,90,i*.7+.01);return c.toDataURL()})})()`);
 assert.equal(new Set(isolated).size,8,'Character alone must have eight distinct poses');
 const frozen=await evaluate(`s.state='paused';[paint(60,8),paint(60,80)]`);assert.equal(frozen[0],frozen[1]);
 const world=await evaluate(`(()=>{const c=document.createElement('canvas');c.width=430;c.height=760;const ctx=c.getContext('2d');return [0,.5,1].map(d=>{ctx.clearRect(0,0,430,760);projection.drawWorld(ctx,430,760,d,0);return c.toDataURL()})})()`);
 assert.equal(new Set(world).size,3);
 const spatial=await evaluate(`[-10,0,20,50].map(z=>projection.project(430,760,z,1.9))`);
 assert.ok(spatial.every((p,i)=>i===0||p.y<spatial[i-1].y&&p.x<spatial[i-1].x));
 const phase=await evaluate(`Array.from({length:8},(_,i)=>motion.runFrame(i*.7+.01))`);assert.deepEqual(phase,[0,1,2,3,4,5,6,7]);
 // Real renderer, 3.5 seconds, recorded from the live canvas rather than a still mockup.
 const video=await evaluate(`(async()=>{
 s.state='running';s.obstacles=[];let chunks=[];const recorder=new MediaRecorder(art.canvas.captureStream(30),{mimeType:'video/webm;codecs=vp9'});
 const stopped=new Promise(resolve=>recorder.onstop=resolve);recorder.ondataavailable=e=>chunks.push(e.data);recorder.start();
 const start=performance.now();await new Promise(resolve=>{function tick(now){const t=(now-start)/1000;s.distance=60+t*12;s.time=t;art.render(s,t);if(t<3.5)requestAnimationFrame(tick);else resolve()}requestAnimationFrame(tick)});
 recorder.stop();await stopped;return await new Promise(resolve=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result.split(',')[1]);reader.readAsDataURL(new Blob(chunks,{type:'video/webm'}))});})()`);
 await fs.writeFile(new URL('./run-cycle-v3.webm',import.meta.url),Buffer.from(video,'base64'));
 const checks=['八个独立跑步帧按顺序播放','暂停后不同墙钟时间画面逐像素一致','赛道在小距离变化时连续推进','近景向外放大、远景向消失点收缩','完整跑步循环与距离同步','真实渲染器动画录像已保存'];
 await fs.writeFile(new URL('./motion-results-v3.json',import.meta.url),JSON.stringify({passed:checks.length,checks},null,2));console.log(JSON.stringify({passed:checks.length,checks}));
} finally {await call('Page.navigate',{url:'http://127.0.0.1:4173/run-aix-classic.html'});browser.close();}
