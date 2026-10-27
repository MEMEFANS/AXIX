// Deterministic Canvas feedback: no timers, DOM changes or network resources.
const clamp = value => Math.max(0, Math.min(1, value));

export function effectProgress(effect) {
  return effect ? clamp((Number(effect.elapsed) || 0) / Math.max(0.1, Number(effect.duration) || 0.8)) : 1;
}

export function applyHeroImpact(c, effect, x, ground, size) {
  const p = effectProgress(effect);
  if (p >= 1) return;
  const pulse = Math.sin(Math.PI * p), kind = effect.kind;
  c.translate(x, ground);
  if (kind === 'crush') {
    c.translate(0, size * 0.04 * pulse); c.scale(1 + pulse * 0.7, 1 - pulse * 0.77);
  } else if (kind === 'trip') {
    c.translate(size * p * 0.35, -size * pulse * 0.18); c.rotate(p * Math.PI * 0.9);
  } else if (kind === 'spin') {
    c.translate(Math.sin(p * 12) * size * .12 * (1 - p), -size * p * .35);
    c.rotate(p * Math.PI * 5); c.scale(Math.max(.07, 1 - p * .95), Math.max(.07, 1 - p * .95));
  } else if (kind === 'freeze') {
    c.translate(Math.sin(p * 80) * size * .018 * (1 - p), 0); c.rotate(Math.sin(p * 15) * .025);
  } else if (kind === 'launch') {
    c.translate(size * p * .4, -size * Math.sin(p * Math.PI * .7) * 2.4); c.rotate(-p * Math.PI * 1.3);
    c.globalAlpha *= 1 - p * .55;
  }
  c.translate(-x, -ground);
}

export function drawImpact(c, effect, x, ground, size, color = '#d5c4ff') {
  const p = effectProgress(effect); if (p >= 1) return;
  c.save(); c.translate(x, ground - size * .4); c.globalAlpha = 1 - p;
  c.strokeStyle = color; c.fillStyle = color; c.lineWidth = Math.max(1.5, size * .028);
  if (effect.kind === 'freeze') {
    c.fillStyle = '#92e9ff45'; c.beginPath();
    c.moveTo(-size * .53, size * .43); c.lineTo(-size * .65, -size * .48); c.lineTo(-size * .18, -size * 1.08);
    c.lineTo(size * .52, -size * .8); c.lineTo(size * .66, size * .4); c.closePath(); c.fill(); c.stroke();
    for (let i = 0; i < 6; i++) {
      const a = i * Math.PI / 3 + .2, r = size * (.65 + p * .7);
      c.save(); c.translate(Math.cos(a) * r, Math.sin(a) * r - size * .25); c.rotate(a);
      c.beginPath(); c.moveTo(-size * .08, 0); c.lineTo(size * .08, 0); c.moveTo(0, -size * .08); c.lineTo(0, size * .08); c.stroke(); c.restore();
    }
  } else if (effect.kind === 'spin') {
    for (let i = 0; i < 3; i++) {
      c.beginPath(); c.ellipse(0, size * .25, size * (.4 + p * .5 + i * .1), size * (.12 + p * .12), -p * 6 + i, 0, Math.PI * 1.6); c.stroke();
    }
  } else {
    const count = effect.kind === 'launch' ? 10 : 14;
    for (let i = 0; i < count; i++) {
      const a = i / count * Math.PI * 2, r = size * (.18 + p * 1.2), px = Math.cos(a) * r, py = Math.sin(a) * r * .7;
      c.beginPath(); c.moveTo(px, py); c.lineTo(px + Math.cos(a) * size * .15, py + Math.sin(a) * size * .15); c.stroke();
    }
    if (effect.kind === 'crush' || effect.kind === 'trip') {
      c.beginPath(); c.ellipse(0, size * .3, size * (.3 + p), size * (.08 + p * .1), 0, 0, Math.PI * 2); c.stroke();
    }
  }
  c.restore();
}

export function drawWeather(c, obstacle, x, y, size, time) {
  c.save(); c.globalAlpha *= .48;
  c.strokeStyle = obstacle.color || '#a4dfff'; c.lineWidth = Math.max(1, size * .018);
  for (let i = 0; i < 7; i++) {
    const dx = (i / 6 - .5) * size * 1.3;
    const dy = ((time * 22 + i * 17) % 70) / 70 * size - size * .9;
    c.beginPath(); c.moveTo(x + dx, y + dy); c.lineTo(x + dx - size * .07, y + dy + size * .15); c.stroke();
  }
  c.restore();
}

export function drawWeatherScreen(c, weather, w, h, time) {
  if (!weather || !(weather.remaining > 0)) return;
  const fraction = Math.min(1, weather.remaining / Math.max(.1, weather.total || weather.remaining));
  const alpha = Math.min(1, fraction * 4) * .28;
  const ice = ['usdt', 'dai'].includes(weather.id), laser = weather.id === 'liquidation', gas = weather.id === 'gas';
  c.save();
  const haze = c.createRadialGradient(w * .5, h * .6, w * .15, w * .5, h * .6, Math.max(w, h) * .7);
  haze.addColorStop(0, ice ? '#8eece500' : gas ? '#ffb77500' : laser ? '#ff789500' : '#7bd8ff00');
  haze.addColorStop(1, ice ? '#8eece5' : gas ? '#ffb775' : laser ? '#ff7895' : '#7bd8ff');
  c.globalAlpha = alpha; c.fillStyle = haze; c.fillRect(0, 0, w, h);
  c.globalAlpha = alpha * 1.6; c.strokeStyle = ice ? '#cbfff7' : laser ? '#ff8fa8' : '#9edfff'; c.lineWidth = 1;
  if (ice) {
    if (weather.id === 'usdt') {
      const count = 6 + Math.floor((1 - fraction) * 13);
      for (let i = 0; i < count; i++) {
        const x = (i * 73.7 + time * (45 + i % 3 * 10)) % (w + 20) - 10, y = (i * 123.1 + time * 95) % h, r = i % 3 + 4;
        c.fillStyle = '#63d5ad'; c.beginPath(); c.ellipse(x, y, r, r * 1.15, -.3, 0, Math.PI * 2); c.fill();
        c.strokeStyle = '#e1fff4'; c.beginPath(); c.moveTo(x - r * .5, y - r * .2); c.lineTo(x + r * .5, y - r * .2); c.moveTo(x, y - r * .5); c.lineTo(x, y + r * .5); c.stroke();
        if (fraction < .6) { c.strokeStyle = '#d9ffff'; c.beginPath(); c.moveTo(x - r - 2, y + r); c.lineTo(x + r + 3, y - r); c.stroke(); }
      }
    }
    for (let i = 0; i < 20; i++) {
      const x = (i * 73.7 + time * 17) % (w + 10), y = (i * 123.1 + time * 40) % h, r = i % 3 + 2;
      c.beginPath(); c.moveTo(x - r, y); c.lineTo(x + r, y); c.moveTo(x, y - r); c.lineTo(x, y + r); c.stroke();
    }
  } else if (laser) {
    const scan = (time * 75) % h;
    for (let i = -2; i < 3; i++) {
      c.beginPath(); c.moveTo(w * .5 + i * w * .28, h * .3); c.lineTo(w * .5 - i * w * .45, h); c.stroke();
    }
    for (let i = 0; i < 5; i++) {
      const y = (scan + i * h * .2) % h;
      c.beginPath(); c.moveTo(0, y); c.lineTo(w, y); c.stroke();
    }
  } else if (gas) {
    c.fillStyle = '#efa757';
    for (let i = 0; i < 7; i++) { c.beginPath(); c.ellipse((i / 6 * w + Math.sin(time + i) * 20), h * (.7 + Math.sin(i * 2) * .2), w * .22, h * .1, 0, 0, Math.PI * 2); c.fill(); }
  } else {
    for (let i = 0; i < 10; i++) { const y = (i * h * .12 + time * 80) % h; c.beginPath(); c.ellipse(w * .5, y, w * (.3 + Math.sin(time + i) * .16), h * .02, -.2, .1, 2.9); c.stroke(); }
  }
  c.restore();
}
