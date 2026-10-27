// Eight authored poses. Distance drives gait, so pauses and speed changes stay in sync.
export const RUN_FRAMES = 8;
export function runFrame(distance) { return Math.floor(Math.max(0, distance) / 5.6 * RUN_FRAMES) % RUN_FRAMES; }
export function drawRunner(c, sheet, x, ground, size, distance, lean = 0, sprint = false) {
  const frame = runFrame(distance), sw = sheet.naturalWidth / 4, sh = sheet.naturalHeight / 2;
  c.save(); c.translate(x, ground);
  c.fillStyle = '#080b2866'; c.beginPath(); c.ellipse(0, 0, size * .43, size * .09, 0, 0, Math.PI * 2); c.fill();
  if (sprint) {
    const glow = c.createRadialGradient(0, -size * .4, 0, 0, -size * .4, size);
    glow.addColorStop(0, '#ffe9a980'); glow.addColorStop(1, '#b88aff00');
    c.fillStyle = glow; c.fillRect(-size, -size * 1.5, size * 2, size * 2);
  }
  c.rotate(lean * .16);
  // Cell baseline is fixed; never resize individual limbs or wobble the whole pose.
  c.drawImage(sheet, frame % 4 * sw, Math.floor(frame / 4) * sh, sw, sh,
    -size * .65, -size * 1.98, size * 1.3, size * 2.6);
  c.restore();
}
