// 原创 Canvas 美术模块：角色、16 种独立障碍、四阶段反馈与三套多层场景。
import { SCENES } from './config.js';
import { artwork, cover } from './sprites.js?v=20261027b';
import { drawRunner } from './runner-animation.js';
import { drawWorld, project } from './world-motion.js?v=20261028a';
import { HAZARD_BY_ID, hazardPhase } from './hazards.js';
import { applyHeroImpact, drawImpact, drawWeather, drawWeatherScreen, effectProgress } from './effects.js';
function ellipse(c, x, y, rx, ry, color) { c.fillStyle = color; c.beginPath(); c.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2); c.fill(); }
function path(c, points, fill, stroke, width = 2) {
  c.beginPath(); points.forEach(([x, y], i) => i ? c.lineTo(x, y) : c.moveTo(x, y)); c.closePath();
  if (fill) { c.fillStyle = fill; c.fill(); } if (stroke) { c.strokeStyle = stroke; c.lineWidth = width; c.stroke(); }
}
function rounded(c, x, y, w, h, r, fill, stroke) {
  c.beginPath(); c.roundRect(x, y, w, h, r); if (fill) { c.fillStyle = fill; c.fill(); } if (stroke) { c.strokeStyle = stroke; c.lineWidth = 2; c.stroke(); }
}
export function drawHero(c, x, y, size, time, rocket = false, moving = false) {
  if (artwork.hero) {
    c.save(); c.translate(x, y);
    const bob = Math.sin(time * (moving ? 15 : 2.1)) * (moving ? 2 : 5);
    ellipse(c, 0, size * 0.55, size * 0.49, size * 0.09, '#08071c60');
    if (rocket) {
      c.save(); c.globalCompositeOperation = 'screen';
      const plume = c.createRadialGradient(0, size * 0.5, 0, 0, size * 0.7, size * 0.85);
      plume.addColorStop(0, '#fff1b8d0'); plume.addColorStop(0.3, '#e28aff90'); plume.addColorStop(1, '#8e7bff00');
      ellipse(c, 0, size * 0.7, size * 0.38, size * 0.9, plume); c.restore();
    }
    c.translate(0, bob); c.rotate(moving ? Math.sin(time * 15) * 0.035 : Math.sin(time * 1.1) * 0.025);
    c.drawImage(artwork.hero, -size * 0.87, -size * 0.87, size * 1.74, size * 1.74);
    // 清晰的品牌胸牌由矢量文字叠加，避免生成文字变形。
    c.fillStyle = '#f9edff'; c.shadowColor = '#27194d'; c.shadowBlur = 4;
    c.font = `900 ${Math.max(8, size * 0.09)}px sans-serif`; c.textAlign = 'center'; c.fillText('AIX', size * 0.01, size * 0.22);
    c.restore(); return;
  }
  c.save(); c.translate(x, y); c.scale(size / 100, size / 100);
  const bob = moving ? Math.sin(time * 19) * 3 : Math.sin(time * 2.4) * 4;
  ellipse(c, 0, 47, 37, 8, '#080c3055');
  c.translate(0, bob);
  if (rocket) {
    for (let i = 0; i < 3; i++) {
      const flame = c.createLinearGradient(0, 30, 0, 110); flame.addColorStop(0, ['#fff5b6', '#ffc15a', '#ff6b9a'][i]); flame.addColorStop(1, '#ff65db00');
      path(c, [[-21 + i * 7, 30], [0, 95 + Math.sin(time * 35 + i) * 15 - i * 15], [21 - i * 7, 30]], flame);
    }
  }
  const stride = moving ? Math.sin(time * 20) * 9 : 0;
  rounded(c, -30, 28 + stride, 21, 18, 8, '#7461df', '#242359');
  rounded(c, 10, 28 - stride, 21, 18, 8, '#7461df', '#242359');
  c.save(); c.translate(-37, 2); c.rotate(-0.35 + stride / 35); ellipse(c, 0, 0, 10, 20, '#afa1ff'); c.restore();
  c.save(); c.translate(37, 2); c.rotate(0.35 - stride / 35); ellipse(c, 0, 0, 10, 20, '#afa1ff'); c.restore();
  path(c, [[-29, -27], [-25, -52], [-8, -36]], '#b8a4ff', '#50418f');
  path(c, [[11, -36], [29, -53], [31, -22]], '#b8a4ff', '#50418f');
  const body = c.createLinearGradient(-30, -40, 35, 45); body.addColorStop(0, '#eee6ff'); body.addColorStop(0.38, '#bc9bff'); body.addColorStop(1, '#7860df');
  ellipse(c, 0, -1, 39, 41, body);
  c.strokeStyle = '#443777'; c.lineWidth = 2.4; c.stroke();
  ellipse(c, -14, -18, 16, 9, '#ffffff35');
  rounded(c, -29, -18, 58, 35, 16, '#182347', '#c8b7ff');
  ellipse(c, -11, -5, 4, 6, '#8cffe5'); ellipse(c, 11, -5, 4, 6, '#8cffe5');
  c.strokeStyle = '#8cffe5'; c.lineWidth = 2; c.beginPath(); c.arc(0, 0, 7, 0.25, Math.PI - 0.25); c.stroke();
  ellipse(c, -23, 4, 4, 2, '#ff99d6aa'); ellipse(c, 23, 4, 4, 2, '#ff99d6aa');
  c.fillStyle = '#fff8ff'; c.font = '900 13px sans-serif'; c.textAlign = 'center'; c.fillText('AIX', 0, 30);
  c.strokeStyle = '#b9fff0'; c.lineWidth = 2; c.beginPath(); c.moveTo(0, -41); c.lineTo(0, -62); c.stroke();
  ellipse(c, 0, -64, 5, 5, '#a0ffe2');
  c.restore();
}
function face(c, color = '#122638', eyeY = -5, eyeX = 12) {
  ellipse(c, -eyeX, eyeY, 4, 5, color); ellipse(c, eyeX, eyeY, 4, 5, color);
  c.strokeStyle = color; c.lineWidth = 2.5; c.beginPath(); c.arc(0, eyeY + 10, 6, .1, Math.PI - .1); c.stroke();
}

function drawNewHazard(c, o, time) {
  if (o.id === 'ltc') {
    // V3: elongated silver rocket, mirrored goggles and silver speed trails.
    c.save(); c.rotate(-.43); c.translate(Math.sin(time * 12) * 2, 0);
    c.strokeStyle = '#c7e7ff88'; c.lineWidth = 2;
    for (let i = 0; i < 4; i++) { c.beginPath(); c.moveTo(-54 - i * 5, -19 + i * 13); c.lineTo(-27, -19 + i * 13); c.stroke(); }
    path(c, [[-29, -13], [-53 - Math.sin(time * 30) * 7, 0], [-29, 13]], '#adf1ff');
    path(c, [[-17, -13], [-32, -33], [1, -19], [14, -6]], '#9aaec9', '#e8f5ff');
    path(c, [[-17, 13], [-32, 32], [1, 20], [14, 6]], '#9aaec9', '#e8f5ff');
    const silver = c.createLinearGradient(0, -19, 0, 19); silver.addColorStop(0, '#f7fcff'); silver.addColorStop(.5, '#c9dbea'); silver.addColorStop(1, '#718aa9');
    rounded(c, -31, -18, 65, 36, 18, silver, '#eff8ff'); path(c, [[24, -17], [47, 0], [24, 17]], '#e4f4ff', '#8daac5');
    rounded(c, -11, -14, 33, 19, 6, '#1b314c', '#eefaff');
    rounded(c, -7, -10, 11, 11, 3, '#7be4ff'); rounded(c, 8, -10, 10, 11, 3, '#7be4ff');
    path(c, [[-5, -8], [1, -8], [-5, -2]], '#e3fbff'); path(c, [[10, -8], [16, -8], [10, -2]], '#e3fbff');
    c.strokeStyle = '#48647d'; c.lineWidth = 2; c.beginPath(); c.moveTo(2, 11); c.lineTo(16, 8); c.stroke(); c.restore();
  } else if (o.id === 'sol') {
    // V3: an intentionally glitching block creature, offline cross and pixel spikes.
    const glitch = Math.floor(time * 6) % 4;
    c.translate(glitch === 0 ? -3 : 0, 0);
    path(c, [[-35, 28], [-35, -28], [-21, -28], [-21, -39], [21, -39], [21, -28], [35, -28], [35, 28]], '#6552ad', '#b5ffe7');
    for (let row = 0; row < 7; row++) for (let col = 0; col < 8; col++) {
      const pixel = (col * 3 + row * 5 + glitch) % 6;
      c.fillStyle = ['#8b7bd6', '#68d8b6', '#a491ef', '#554d98', '#8ee8cb', '#7b69c7'][pixel];
      if (!(glitch === 0 && row === 3 && col > 4)) c.fillRect(-28 + col * 7, -28 + row * 7, 7, 7);
    }
    for (let i = 0; i < 5; i++) path(c, [[-42 + i * 18, 31], [-34 + i * 18, 11 + (i % 2 ? 6 : 0)], [-26 + i * 18, 31]], i % 2 ? '#77eed3' : '#af8fff', '#d6fff0');
    rounded(c, -12, -48, 24, 20, 4, '#312449', '#ffb1ba');
    c.strokeStyle = '#ff6a8f'; c.lineWidth = 4; c.beginPath(); c.moveTo(-6, -43); c.lineTo(6, -33); c.moveTo(6, -43); c.lineTo(-6, -33); c.stroke();
    rounded(c, -21, -12, 12, 7, 1, '#242643'); rounded(c, 9, -12, 12, 7, 1, '#242643');
    c.fillStyle = '#d0fff1'; c.fillRect(-12, 7, 24, 4);
  } else if (o.id === 'xrp') {
    // V3: a dragon made from concentric blue water rings and splashing droplets.
    for (let i = 0; i < 6; i++) {
      const yy = 30 - i * 11, radius = 10 + i * 5, dx = Math.sin(time * 4 - i * .8) * 7;
      ellipse(c, dx, yy, radius, 6 + i, '#54b8ed24');
      c.strokeStyle = i % 2 ? '#7edcff' : '#b4f5ff'; c.lineWidth = 3;
      c.beginPath(); c.ellipse(dx, yy, radius, 6 + i, -.12, time * 3 + i, time * 3 + i + Math.PI * 1.8); c.stroke();
    }
    const headX = Math.sin(time * 4 - 4) * 7;
    rounded(c, headX - 29, -40, 43, 24, 11, '#83d9f7', '#d4faff');
    path(c, [[headX - 7, -38], [headX - 15, -52], [headX + 3, -42], [headX + 15, -49], [headX + 9, -33]], '#7bc6ed', '#d3faff');
    ellipse(c, headX - 17, -32, 3, 4, '#234c83'); c.strokeStyle = '#397fad'; c.lineWidth = 2; c.beginPath(); c.moveTo(headX - 28, -24); c.lineTo(headX - 17, -22); c.stroke();
    for (let i = 0; i < 4; i++) { const a = time * 2 + i * 1.6; ellipse(c, Math.cos(a) * 42, -7 + Math.sin(a) * 25, 3, 5, '#baf3ff'); }
  } else if (o.id === 'doge') {
    const dog = (dx, dy, scale, leader = false) => {
      c.save(); c.translate(dx, dy - Math.max(0, Math.sin(time * 11 + dx)) * 3); c.scale(scale, scale);
      ellipse(c, 0, 13, 27, 22, '#e1a959'); ellipse(c, -17, 29, 8, 9, '#c58a43'); ellipse(c, 17, 29, 8, 9, '#c58a43');
      path(c, [[-24, -9], [-26, -36], [-9, -23], [9, -23], [26, -36], [24, -8]], '#d99b50', '#ffdb98');
      ellipse(c, 0, -7, 28, 24, '#eabd77'); ellipse(c, 0, 4, 21, 13, '#fff2cf');
      ellipse(c, -12, -12, 3, 4, '#3e2c23'); ellipse(c, 12, -12, 3, 4, '#3e2c23'); ellipse(c, 0, -2, 5, 3, '#362c2e');
      if (leader) {
        c.strokeStyle = '#70472b'; c.lineWidth = 3; c.beginPath(); c.moveTo(-19, -19); c.lineTo(-7, -16); c.moveTo(7, -16); c.lineTo(19, -20); c.stroke();
        c.strokeStyle = '#ffdf72'; c.lineWidth = 3;
        for (let i = 0; i < 7; i++) { c.beginPath(); c.ellipse(-19 + i * 6, 17 + Math.sin(i / 6 * Math.PI) * 6, 4, 3, 0, 0, Math.PI * 2); c.stroke(); }
        ellipse(c, 0, 27, 5, 6, '#ffcf50');
      } else rounded(c, -3, 7, 7, 11, 3, '#f88d9c');
      c.restore();
    };
    dog(-35, -2, .53); dog(34, -7, .47); dog(0, -15, .62); dog(0, 7, .95, true);
  } else if (o.id === 'usdt') {
    // V3: angry green coins become hail and sweep sideways through the blizzard.
    for (let i = 0; i < 5; i++) {
      const dx = (i - 2) * 17 + Math.sin(time * 3 + i) * 5, dy = ((time * 33 + i * 19) % 65) - 40;
      c.save(); c.translate(dx, dy); c.rotate(-.25);
      if (i % 2) path(c, [[-14, -8], [-7, -17], [7, -15], [16, -3], [9, 13], [-8, 15], [-16, 2]], '#bcfff5bb', '#e5fffd');
      ellipse(c, 0, 0, 11, 13, '#36af91'); ellipse(c, 0, 0, 8, 10, '#78dec0');
      c.strokeStyle = '#256c64'; c.lineWidth = 2; c.beginPath(); c.moveTo(-7, -5); c.lineTo(-2, -3); c.moveTo(2, -3); c.lineTo(7, -5); c.stroke();
      path(c, [[-4, 1], [4, 1], [0, 7]], '#e4fff7'); c.restore();
    }
    c.strokeStyle = '#d5fffcaa'; c.lineWidth = 2;
    for (let i = 0; i < 4; i++) { c.beginPath(); c.moveTo(-43, -30 + i * 19); c.quadraticCurveTo(0, -39 + i * 19, 43, -26 + i * 19); c.stroke(); }
  } else if (o.id === 'dai') {
    // V3: an icy robe, floating crystal and a staff casting a freezing ray.
    path(c, [[-15, -15], [-29, 34], [0, 25], [25, 35], [13, -16]], '#628bc4', '#caefff');
    path(c, [[-3, -13], [-12, 28], [0, 23], [10, 29]], '#a4dcf1');
    path(c, [[-19, -10], [-24, -27], [0, -43], [23, -26], [18, -10]], '#c4f2ff', '#e9fdff');
    ellipse(c, 0, -17, 18, 18, '#a5dded'); rounded(c, -14, -22, 28, 14, 6, '#304a79');
    ellipse(c, -6, -17, 2, 3, '#ddfaff'); ellipse(c, 6, -17, 2, 3, '#ddfaff');
    const float = Math.sin(time * 3) * 3;
    path(c, [[0, -62 + float], [8, -51 + float], [0, -40 + float], [-8, -51 + float]], '#b5faff', '#efffff');
    c.strokeStyle = '#b8eafa'; c.lineWidth = 4; c.beginPath(); c.moveTo(29, 30); c.lineTo(33, -33); c.stroke();
    path(c, [[33, -49], [42, -35], [33, -22], [24, -35]], '#8ff4ff', '#dcfdff');
    ellipse(c, 26, 3, 8, 7, '#a8e9f9');
    c.strokeStyle = '#b8f9ff88'; c.lineWidth = 2; c.beginPath(); c.moveTo(39, -35); c.lineTo(52, -36 + Math.sin(time * 12) * 6); c.stroke();
  } else if (o.id === 'gas') {
    // V3: a small orange flame rising from hot sticky mud, holding Gas↑.
    ellipse(c, 0, 30, 48, 12, '#7e4937'); ellipse(c, 0, 26, 43, 11, '#c9783e');
    for (let i = 0; i < 3; i++) ellipse(c, (i - 1) * 23, 24 + Math.sin(time * 3 + i) * 2, 8, 4, '#f2ac50');
    const flicker = Math.sin(time * 13) * 4;
    path(c, [[-24, 22], [-31, -1], [-15, -13], [-9, -38 - flicker], [3, -22], [15, -43 + flicker], [19, -15], [31, -3], [23, 23]], '#ee893c', '#ffce78');
    path(c, [[-13, 20], [-15, 2], [-4, -16], [1, -5], [10, -18], [15, 3], [12, 21]], '#ffd96e');
    face(c, '#7f422c', 3, 9);
    c.strokeStyle = '#8f573a'; c.lineWidth = 3; c.beginPath(); c.moveTo(30, 25); c.lineTo(39, -15); c.stroke();
    rounded(c, 21, -29, 37, 21, 3, '#fff0b5', '#ba713d'); c.fillStyle = '#895031'; c.font = '900 11px sans-serif'; c.textAlign = 'center'; c.fillText('Gas↑', 39, -15);
  } else if (o.id === 'whale') {
    c.translate(0, Math.sin(time * 3) * 4); ellipse(c, -2, -1, 39, 26, '#72a9ec'); ellipse(c, -5, 8, 33, 14, '#bde7ff');
    path(c, [[26, -2], [44, -22], [48, -7], [42, 2], [51, 17], [32, 13]], '#4c82cb', '#a5d4ff');
    path(c, [[-5, 7], [7, 32], [19, 26], [14, 6]], '#497fc7', '#a5d4ff'); ellipse(c, -25, -5, 4, 5, '#14345e'); ellipse(c, -26, -7, 1.3, 1.3, '#fff');
    c.strokeStyle = '#3471af'; c.lineWidth = 2; c.beginPath(); c.arc(-25, 7, 9, .1, 1.7); c.stroke();
    c.strokeStyle = '#b4efff'; c.lineWidth = 3; c.beginPath(); c.moveTo(-7, -25); c.quadraticCurveTo(-8, -49, -21, -41); c.moveTo(-7, -25); c.quadraticCurveTo(-5, -47, 7, -43); c.stroke();
    for (let i = 0; i < 3; i++) { c.strokeStyle = '#b5e8ff80'; c.beginPath(); c.ellipse(-4, 30 + i * 6, 42 + i * 6, 5, 0, .15, Math.PI - .15); c.stroke(); }
  } else if (o.id === 'bear') {
    ellipse(c, 0, 13, 30, 30, '#817c93'); ellipse(c, -19, 33, 12, 10, '#656579'); ellipse(c, 19, 33, 12, 10, '#656579');
    ellipse(c, -19, -29, 11, 11, '#928b9c'); ellipse(c, 19, -29, 11, 11, '#928b9c'); ellipse(c, 0, -15, 29, 27, '#9a93a4');
    ellipse(c, 0, -5, 18, 13, '#d3c9cd'); ellipse(c, -11, -19, 3, 4, '#4b4057'); ellipse(c, 11, -19, 3, 4, '#4b4057'); ellipse(c, 0, -7, 6, 4, '#4b4057');
    c.save(); c.translate(26, -1 + Math.sin(time * 3) * 6); c.rotate(-.3); ellipse(c, 0, 0, 21, 24, '#716b80'); ellipse(c, 0, 6, 13, 12, '#b9a7b5');
    for (let i = 0; i < 3; i++) path(c, [[-13 + i * 12, -15], [-9 + i * 12, -26], [-4 + i * 12, -13]], '#f2e7dc'); c.restore();
  } else if (o.id === 'liquidation') {
    // V3: a row of red-eyed metal robots scanning a laser grid.
    for (let i = 0; i < 3; i++) {
      const dx = (i - 1) * 27, dy = i === 1 ? -13 : -3;
      c.save(); c.translate(dx, dy + Math.sin(time * 3 + i) * 3); c.scale(i === 1 ? .9 : .67, i === 1 ? .9 : .67);
      rounded(c, -17, -20, 34, 28, 5, '#8694b3', '#d4e4fa'); rounded(c, -12, -13, 24, 10, 3, '#253450');
      ellipse(c, -6, -8, 3, 3, '#ff637b'); ellipse(c, 6, -8, 3, 3, '#ff637b');
      rounded(c, -12, 11, 24, 20, 4, '#64718c', '#adbed5'); rounded(c, -19, 12, 7, 15, 2, '#4a5672'); rounded(c, 12, 12, 7, 15, 2, '#4a5672');
      path(c, [[-6, 32], [0, 41 + Math.sin(time * 20) * 4], [6, 32]], '#8ee5ff'); c.restore();
    }
    c.strokeStyle = '#ff617ea0'; c.lineWidth = 1.8;
    for (let i = 0; i < 3; i++) { c.beginPath(); c.moveTo(-39 + i * 25, -14); c.lineTo(43 - i * 25, 40); c.moveTo(-42, 14 + i * 10); c.lineTo(42, 14 + i * 10); c.stroke(); }
  }
}

export function drawObstacle(c, obstacle, x, y, size, time) {
  const o = { ...HAZARD_BY_ID[obstacle.id], ...obstacle };
  const phase = Number.isFinite(o.ahead) ? hazardPhase(o) : 'approach';
  c.save(); c.translate(x, y);
  if (phase === 'dissolve') {
    const dissolve = Math.max(0, Math.min(1, (1.5 - o.ahead) / 9.5));
    c.globalAlpha *= 1 - dissolve; c.translate(0, -size * dissolve * .3); c.scale(1 - dissolve * .32, 1 - dissolve * .32);
    c.strokeStyle = o.color || '#dbceff'; c.lineWidth = 1.5;
    for (let i = 0; i < 5; i++) { const a = i / 5 * Math.PI * 2; c.beginPath(); c.moveTo(Math.cos(a) * size * (.3 + dissolve * .7), Math.sin(a) * size * (.3 + dissolve * .7)); c.lineTo(Math.cos(a) * size * (.4 + dissolve * .7), Math.sin(a) * size * (.4 + dissolve * .7)); c.stroke(); }
  }
  if (phase === 'hit') {
    const attack = Math.max(0, Math.min(1, (8 - o.ahead) / 6.5));
    if (o.impact === 'crush') c.translate(0, -size * (1 - attack) * .25);
    if (o.impact === 'launch') c.translate(0, -Math.sin(attack * Math.PI) * size * .1);
    c.scale(1 + attack * .07, 1 + attack * .07);
  }
  if (o.behavior === 'weather') drawWeather(c, o, 0, 0, size, time);
  if (artwork[o.id]) {
    c.save();
    ellipse(c, 0, size * 0.45, size * 0.4, size * 0.08, '#080b2355');
    c.rotate(o.id === 'hole' ? time * 0.3 : Math.sin(time * 2) * 0.045);
    c.drawImage(artwork[o.id], -size * 0.78, -size * 0.78, size * 1.56, size * 1.56); c.restore(); c.restore(); return;
  }
  c.save(); c.scale(size / 100, size / 100);
  ellipse(c, 0, 33, 39, 8, '#060b2c70');
  if (o.id === 'btc') {
    c.rotate(Math.sin(time * 3) * 0.14); ellipse(c, 5, 0, 33, 36, '#a85c22'); ellipse(c, 0, -3, 33, 36, '#ffd878');
    c.strokeStyle = '#c38a33'; c.lineWidth = 3; c.stroke(); ellipse(c, 0, -3, 25, 28, '#e9aa45');
    path(c, [[-27, -24], [-34, -42], [-12, -31]], '#ffdf9a'); path(c, [[12, -31], [34, -42], [27, -24]], '#ffdf9a');
    c.fillStyle = '#8a411d'; c.font = 'bold 34px sans-serif'; c.textAlign = 'center'; c.fillText('B', 0, 13);
    c.strokeStyle = '#62331d'; c.lineWidth = 4; c.beginPath(); c.moveTo(-20, -20); c.lineTo(-7, -15); c.moveTo(7, -15); c.lineTo(20, -20); c.stroke();
  } else if (o.id === 'eth') {
    path(c, [[-39, 23], [-28, -18], [-12, -7], [0, -53], [22, -12], [31, -23], [42, 27], [0, 37]], '#927ce8', '#ded4ff');
    path(c, [[0, -53], [0, 37], [-12, -7]], '#cfc4ff'); path(c, [[0, -53], [22, -12], [0, 4]], '#b0abff');
    ellipse(c, -9, 12, 4, 3, '#242449'); ellipse(c, 12, 12, 4, 3, '#242449');
  } else if (o.id === 'bnb') {
    rounded(c, -34, -35, 68, 68, 9, '#e8b93f', '#ffe999'); rounded(c, -27, -28, 54, 53, 6, '#ffd767');
    for (const dx of [-27, 22]) for (const dy of [-29, 22]) rounded(c, dx, dy, 7, 7, 2, '#927039');
    ellipse(c, -13, -5, 5, 6, '#3d3c45'); ellipse(c, 13, -5, 5, 6, '#3d3c45'); rounded(c, -9, 12, 18, 4, 2, '#88662a');
    path(c, [[-36, -32], [-21, -45], [35, -45], [34, -35]], '#fff1a5');
  } else if (o.id === 'ghost') {
    c.translate(0, Math.sin(time * 4) * 7); c.beginPath(); c.moveTo(-32, 29); c.bezierCurveTo(-50, -49, 44, -56, 33, 14); c.lineTo(30, 36); c.lineTo(13, 24); c.lineTo(0, 38); c.lineTo(-15, 25); c.closePath(); c.fillStyle = '#84f3d9dd'; c.fill();
    ellipse(c, -12, -7, 5, 8, '#163451'); ellipse(c, 12, -7, 5, 8, '#163451'); ellipse(c, 0, 14, 5, 6, '#326e7b');
  } else if (o.id === 'hole') {
    c.rotate(time * 1.7); for (let i = 0; i < 5; i++) { c.rotate(0.65); c.strokeStyle = ['#a391ff', '#f2a5ff', '#7954ca'][i % 3]; c.lineWidth = 4; c.beginPath(); c.ellipse(0, 0, 40 - i * 5, 22 - i * 3, 0, 0.3, 5.5); c.stroke(); } ellipse(c, 0, 0, 13, 13, '#100c29');
  } else if (o.id === 'spike' || !HAZARD_BY_ID[o.id]) {
    path(c, [[-37, 30], [-22, -11], [-13, 15], [2, -54], [17, 12], [28, -25], [40, 30]], '#ff6f99', '#ffc5db');
    path(c, [[2, -54], [2, 31], [-13, 15]], '#ffafc8');
  } else drawNewHazard(c, o, time);
  c.restore(); c.restore();
}

function drawTelegraph(c, o, w, h, time) {
  if (o.passed || o.ahead < 0 || o.ahead > (o.warningDistance || 56)) return;
  const phase = hazardPhase(o), hot = phase === 'hit';
  const p = project(w, h, Math.max(0, o.ahead), o.lane - 1);
  const width = Math.max(9, w * (.025 + p.scale * .19));
  const height = Math.max(3, h * (.006 + p.scale * .018));
  const color = hot ? '#ff899e' : o.color || '#d9c4ff';
  c.save(); c.translate(p.x, p.y); c.strokeStyle = color; c.fillStyle = color;
  c.globalAlpha = (hot ? .7 : .32) + Math.sin(time * (hot ? 17 : 6)) * .1;
  c.lineWidth = hot ? 2.5 : 1.5;
  if (o.behavior === 'slow') {
    c.beginPath(); c.ellipse(0, 0, width * .55, height, 0, 0, Math.PI * 2); c.fill();
    c.globalAlpha *= .7;
    c.beginPath(); c.ellipse(0, 0, width * .77, height * 1.8, 0, 0, Math.PI * 2); c.stroke();
  } else if (o.behavior === 'sweep') {
    c.setLineDash([width * .12, width * .08]); c.beginPath(); c.moveTo(-width * .65, 0); c.lineTo(width * .65, 0); c.stroke(); c.setLineDash([]);
    const direction = o.sweepDirection || (o.lane === 0 ? 1 : -1);
    path(c, [[direction * width * .66, 0], [direction * width * .39, -height], [direction * width * .39, height]], color);
  } else {
    c.beginPath(); c.ellipse(0, 0, width * .6, height * 1.2, 0, 0, Math.PI * 2); c.stroke();
    if (hot) { c.beginPath(); c.ellipse(0, 0, width * .8, height * 1.8, 0, 0, Math.PI * 2); c.stroke(); }
    if (o.behavior === 'weather') {
      c.beginPath(); c.moveTo(-width * .3, -height * 3); c.lineTo(-width * .1, -height); c.moveTo(width * .3, -height * 3); c.lineTo(width * .1, -height); c.stroke();
    }
  }
  if (hot) {
    c.globalAlpha = .85;
    const markSize = Math.max(8, width * .15);
    path(c, [[0, -height * 3.4 - markSize], [markSize, -height * 3.4 + markSize * .7], [-markSize, -height * 3.4 + markSize * .7]], color);
    c.fillStyle = '#24192e'; c.font = `900 ${markSize * 1.15}px sans-serif`; c.textAlign = 'center'; c.fillText('!', 0, -height * 3.4 + markSize * .38);
  }
  c.restore();
}

export class GameArt {
  constructor(canvas) {
    this.canvas = canvas; this.c = canvas.getContext('2d');
    this.resize = () => {
      const rect = canvas.getBoundingClientRect(); const ratio = Math.min(devicePixelRatio || 1, 2);
      canvas.width = Math.round(rect.width * ratio); canvas.height = Math.round(rect.height * ratio); this.ratio = ratio;
      this.w = rect.width; this.h = rect.height;
      const slot = document.querySelector('.hero-space')?.getBoundingClientRect();
      this.heroSlot = slot && slot.height > 0 ? { y: slot.top - rect.top + slot.height * 0.49, height: slot.height } : null;
    };
    this.observer = new ResizeObserver(this.resize); this.observer.observe(canvas); this.resize();
  }
  render(engine, time) {
    const { c, w, h, ratio } = this; if (!w || !h) return;
    const effect = engine.effect;
    const effectP = effectProgress(effect);
    const worldTime = (engine.time ?? 0) + (engine.state === 'ended' && effectP < 1 ? Number(effect.elapsed) || 0 : 0);
    const rocket = engine.rocketActive ?? engine.energy > .85;
    const rRules = engine.rules || {};
    // 速度感：0=巡航起步，1=极速；速度线密度/亮度/长度随速度爬升。
    const speedPct = Math.max(0, Math.min(1, (engine.speed - (rRules.baseSpeed || 0)) / Math.max(1, (rRules.maxSpeed || 1) - (rRules.baseSpeed || 0))));
    c.setTransform(ratio, 0, 0, ratio, 0, 0);
    const sceneIndex = Math.max(0, Math.min(2, engine.sceneIndex ?? Math.floor(engine.distance / ((engine.rules?.maxDistance || 500) / 3)))); const scene = SCENES[sceneIndex];
    const background = artwork[['city', 'exchange', 'ocean'][sceneIndex]];
    if (background) {
      // —— 背景合成缓存（2026-10-28 性能优化）：天空渐变 + 背景图 + 暗角一次性画进离屏画布，
      // 之后每帧只做一次 blit。此前每帧创建 2 个渐变对象并做 3 次全屏填充，是低端机掉帧的主因。
      const bgKey = `${sceneIndex}|${Math.round(w)}|${Math.round(h)}|${ratio}`;
      if (this.bgKey !== bgKey) {
        this.bgKey = bgKey;
        const margin = w * .03; this.bgMargin = margin; // 左右各留 3% 给视差位移
        const cache = document.createElement('canvas');
        cache.width = Math.max(2, Math.round((w + margin * 2) * ratio));
        cache.height = Math.max(2, Math.round(h * ratio));
        const g = cache.getContext('2d');
        g.setTransform(ratio, 0, 0, ratio, 0, 0);
        const cw = w + margin * 2;
        const grad = g.createLinearGradient(0, 0, 0, h); grad.addColorStop(0, scene.top); grad.addColorStop(1, scene.bottom);
        g.fillStyle = grad; g.fillRect(0, 0, cw, h);
        cover(g, background, cw, h * 1.025);
        const shade = g.createLinearGradient(0, 0, 0, h); shade.addColorStop(0, '#0a071b70'); shade.addColorStop(0.35, '#15112600'); shade.addColorStop(1, '#0b10208c');
        g.fillStyle = shade; g.fillRect(0, 0, cw, h);
        this.bg = cache;
      }
      c.drawImage(this.bg, (engine.visualLane - 1) * -w * .012 - this.bgMargin, 0, w + this.bgMargin * 2, h);
    }
    if (!background) {
    const grad = c.createLinearGradient(0, 0, 0, h); grad.addColorStop(0, scene.top); grad.addColorStop(1, scene.bottom); c.fillStyle = grad; c.fillRect(0, 0, w, h);
    const glow = c.createRadialGradient(w * 0.7, h * 0.22, 0, w * 0.7, h * 0.22, w * 0.7); glow.addColorStop(0, sceneIndex === 2 ? '#74f9dd30' : '#9a6aff40'); glow.addColorStop(1, '#8866ff00'); c.fillStyle = glow; c.fillRect(0, 0, w, h);
    for (let i = 0; i < 75; i++) {
      const x = ((Math.sin(i * 127.1) + 1) * 0.5 * w); const y = ((Math.cos(i * 79.7) + 1) * 0.5 * h * 0.64 + time * (i % 3 + 1)) % (h * 0.65);
      ellipse(c, x, y, i % 7 === 0 ? 1.7 : 0.8, i % 7 === 0 ? 1.7 : 0.8, `rgba(218,221,255,${0.25 + (Math.sin(time + i) + 1) * 0.25})`);
    }
    // 远景星球与光环。
    c.save(); c.translate(w * 0.82, h * 0.22); c.rotate(-0.4);
    const planet = c.createLinearGradient(-30, -30, 30, 30); planet.addColorStop(0, '#deb9ff'); planet.addColorStop(1, '#65549c');
    ellipse(c, 0, 0, w * 0.065, w * 0.065, planet); c.strokeStyle = '#d5c3ff50'; c.lineWidth = 3; c.beginPath(); c.ellipse(0, 0, w * 0.11, w * 0.025, 0, 0, Math.PI * 2); c.stroke(); c.restore();
    const horizon = h * 0.48;
    // 中景：悬浮城市、行情屏幕、海上灯塔。
    for (let i = 0; i < 13; i++) {
      const bw = w / 17; const bx = i * w / 12 - bw / 2; const bh = 25 + (Math.sin(i * 4.1) + 1) * 30;
      if (sceneIndex === 2) {
        c.strokeStyle = '#72e5ee33'; c.lineWidth = 1; c.beginPath(); c.moveTo(bx, horizon + Math.sin(time + i) * 4); c.lineTo(bx + bw * 2, horizon + Math.sin(time + i) * 4); c.stroke();
      } else {
        rounded(c, bx, horizon - bh, bw, bh, 3, sceneIndex ? '#142f4c' : '#272653', '#878be522');
        for (let j = 0; j < 4; j++) rounded(c, bx + 5, horizon - bh + 8 + j * 12, bw - 10, 3, 1, j % 2 ? '#c9a3ff33' : '#72eedd55');
        if (sceneIndex === 1) { c.strokeStyle = i % 2 ? '#ff8faa' : '#70e5c1'; c.beginPath(); c.moveTo(bx + 3, horizon - 10); c.lineTo(bx + bw / 2, horizon - bh + 10); c.lineTo(bx + bw - 2, horizon - 20); c.stroke(); }
      }
    }
    }
    c.save();
    if (!engine.reducedMotion && effect && effectP < 1 && ['crush', 'launch'].includes(effect.kind)) {
      const shake = Math.sin((effect.elapsed || 0) * 85) * 3 * (1 - effectP);
      c.translate(shake, shake * .55);
    }
    drawWorld(c, w, h, engine.distance, sceneIndex);
    if (engine.state === 'lobby') {
      // 首页大角色与轨道漂浮碎晶。
      const slot = this.heroSlot;
      const heroY = slot ? slot.y : h * 0.49;
      const heroSize = slot ? Math.min(w * 0.55, slot.height * 0.67) : Math.min(w * 0.5, 200);
      drawHero(c, w * 0.5, heroY, Math.max(45, heroSize), time);
      drawObstacle(c, { id: 'eth' }, w * 0.14, heroY + 15, Math.min(39, heroSize * 0.25), time);
      drawObstacle(c, { id: 'btc' }, w * 0.87, heroY - 28, Math.min(41, heroSize * 0.25), time);
      for (let i = 0; i < 4; i++) { const x = w * (0.22 + i * 0.19); const y = h * 0.62 + Math.sin(time * 2 + i) * 5; path(c, [[x, y - 4], [x + 4, y], [x, y + 4], [x - 4, y]], '#c2baff'); }
    } else {
      // Campaign collectibles: bright, readable crystals share the same road projection.
      for (const crystal of engine.collectibles || []) {
        if (crystal.collected || crystal.ahead > 65 || crystal.ahead < -4) continue;
        const cp = project(w, h, crystal.ahead, crystal.lane - 1);
        const cs = Math.max(5, 8 + cp.scale * w * .075);
        c.save(); c.translate(cp.x, cp.y - cs * 1.6); c.rotate(worldTime * 2.4);
        c.globalAlpha = Math.max(.2, Math.min(1, 1 - Math.max(0, -crystal.ahead) / 6));
        path(c, [[0, -cs], [cs * .55, 0], [0, cs], [-cs * .55, 0]], '#d1c1ff', '#f3edff', 1.2);
        c.globalAlpha = .32; ellipse(c, 0, 0, cs * 1.45, cs * 1.45, '#a6f7dd'); c.restore();
      }
      const py = h * 0.83; const heroX = w * (0.22 + engine.visualLane * 0.28);
      for (const o of [...engine.obstacles].sort((a, b) => b.ahead - a.ahead)) {
        if (o.ahead > 65) continue;
        const hazard = { ...HAZARD_BY_ID[o.id], ...o };
        const p = Math.max(0, Math.min(1.12, 1 - o.ahead / 65)); const scale = p * p;
        const ground = project(w, h, o.ahead);
        const y = ground.y - (10 + scale * w * .19) * .45;
        const x = w * 0.5 + (o.lane - 1) * w * (0.046 + scale * 0.234);
        const size = 10 + scale * w * 0.19;
        drawTelegraph(c, hazard, w, h, worldTime);
        drawObstacle(c, hazard, x, y, size, worldTime);
        if (scale > 0.15 && !o.passed) {
          const label = hazardPhase(hazard) === 'hit' ? `! ${o.name}` : o.name;
          const fontSize = Math.max(10, Math.min(13, size * .15));
          c.font = `600 ${fontSize}px sans-serif`; c.textAlign = 'center';
          const labelWidth = c.measureText(label).width + 16;
          rounded(c, x - labelWidth / 2, y - size * .75 - fontSize, labelWidth, fontSize + 8, 5, '#17182edb');
          c.fillStyle = hazardPhase(hazard) === 'hit' ? '#ffb4c5' : '#f4eaff'; c.fillText(label, x, y - size * .75 + 1);
        }
      }
      c.save();
      // 'none' 也会让部分浏览器走滤镜慢路径，默认皮肤直接跳过
      if (engine.skinFilter && engine.skinFilter !== 'none') c.filter = engine.skinFilter;
      if (!engine.reducedMotion && effect && effectP < 1) applyHeroImpact(c, effect, heroX, h * .88, Math.min(w * .23, 110));
      if (artwork.runCycle) drawRunner(c, artwork.runCycle, heroX, h * .88, Math.min(w * .15, h * .12, 68), engine.distance, engine.lane - engine.visualLane, rocket || speedPct > .7);
      else drawHero(c, heroX, py, Math.min(w * .23, 110), worldTime, rocket, engine.state === 'running');
      c.restore();
      if (!engine.reducedMotion && effect && effectP < 1) drawImpact(c, effect, heroX, h * .88, Math.min(w * .23, 110), HAZARD_BY_ID[effect.obstacle]?.color);
      // 赛车速度感：速度线密度/亮度/长度随速度爬升，越快越有贴脸冲刺的压迫感。
      if (!engine.reducedMotion && engine.state === 'running' && (speedPct > .12 || rocket)) {
        const intensity = Math.min(1, speedPct + (rocket ? .5 : 0));
        const count = Math.round(6 + intensity * 18);
        c.strokeStyle = `rgba(213,180,255,${(.16 + intensity * .42).toFixed(2)})`;
        c.lineWidth = 1.4 + intensity * 1.8;
        for (let i = 0; i < count; i++) {
          const side = i % 2 ? 1 : -1;
          const y = (engine.distance * (16 + intensity * 22) + i * 71) % h;
          c.beginPath(); c.moveTo(w / 2 + side * w * (0.36 + intensity * 0.05), y);
          c.lineTo(w / 2 + side * w * (0.46 + intensity * 0.05), y + 26 + intensity * 46); c.stroke();
        }
      }
    }
    c.restore();
    if (engine.state !== 'lobby') drawWeatherScreen(c, engine.weather, w, h, worldTime);
  }
  destroy() { this.observer.disconnect(); }
}
