// 精修位图资源独立加载。角色透明 PNG 与背景各自渲染，保留实时碰撞和车道投影。
const root = '/games/run-aix/assets/';
export const artwork = {};
const files = { runCycle: 'run-cycle-v3.png', hero: 'hero-v2.png', btc: 'btc-v2.png', eth: 'eth-v2.png', bnb: 'bnb-v2.png', ghost: 'ghost-v2.png', hole: 'hole-v2.png', spike: 'spike-v2.png', city: 'city-v2.jpg', exchange: 'exchange-v2.jpg', ocean: 'ocean-v2.jpg' };
export const artReady = Promise.all(Object.entries(files).map(([key, file]) => new Promise(resolve => {
  const img = new Image(); img.decoding = 'async';
  img.onload = () => {
    // 先解码再就绪：否则切场景（500/1000 米）那一帧才首次解码大图，会卡顿甚至掉帧
    const done = () => { artwork[key] = img; resolve(true); };
    if (typeof img.decode === 'function') img.decode().then(done, done); else done();
  };
  img.onerror = () => resolve(false);
  img.src = root + file;
})));
export function cover(c, image, width, height) {
  const scale = Math.max(width / image.naturalWidth, height / image.naturalHeight);
  const w = image.naturalWidth * scale, h = image.naturalHeight * scale;
  c.drawImage(image, (width - w) / 2, (height - h) / 2, w, h);
}
