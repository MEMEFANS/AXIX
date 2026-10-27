// 原创程序合成配乐：112 BPM，琶音、低音、底鼓、踩镲；无外部版权音源。
import { HAZARD_BY_ID } from './hazards.js';

export class GameAudio {
  constructor() { this.enabled = false; this.step = 0; this.revision = 0; this.suspended = false; this.destroyed = false; }
  async toggle() {
    if (this.destroyed) return false;
    this.enabled = !this.enabled;
    await this.sync();
    return this.enabled;
  }
  async sync() {
    const revision = ++this.revision;
    clearInterval(this.timer); this.timer = undefined;
    const play = this.enabled && !this.suspended && !this.destroyed;
    try {
      if (play) {
        this.context ||= new (window.AudioContext || window.webkitAudioContext)();
        await this.context.resume();
        if (revision !== this.revision || this.destroyed) return;
        this.next = this.context.currentTime + 0.04;
        this.timer = setInterval(() => this.schedule(), 45);
      } else if (this.context?.state !== 'closed') await this.context?.suspend();
    } catch { if (revision === this.revision) { this.enabled = false; clearInterval(this.timer); } }
  }
  tone(frequency, at, duration, type = 'sine', volume = 0.04, endFrequency) {
    if (!this.context || !this.enabled) return;
    const c = this.context, osc = c.createOscillator(), gain = c.createGain();
    osc.type = type; osc.frequency.setValueAtTime(frequency, at);
    if (endFrequency) osc.frequency.exponentialRampToValueAtTime(endFrequency, at + duration);
    gain.gain.setValueAtTime(0.0001, at); gain.gain.exponentialRampToValueAtTime(volume, at + 0.008); gain.gain.exponentialRampToValueAtTime(0.0001, at + duration);
    osc.connect(gain); gain.connect(c.destination); osc.start(at); osc.stop(at + duration + 0.01);
    osc.onended = () => { osc.disconnect(); gain.disconnect(); };
  }
  noise(at, duration = .15, volume = .03, cutoff = 1800) {
    if (!this.context || !this.enabled) return;
    const c = this.context, frames = Math.max(1, Math.floor(c.sampleRate * duration));
    const buffer = c.createBuffer(1, frames, c.sampleRate), samples = buffer.getChannelData(0);
    for (let i = 0; i < frames; i++) samples[i] = (Math.random() * 2 - 1) * (1 - i / frames);
    const source = c.createBufferSource(), filter = c.createBiquadFilter(), gain = c.createGain();
    source.buffer = buffer; filter.type = 'lowpass'; filter.frequency.value = cutoff;
    gain.gain.setValueAtTime(volume, at); gain.gain.exponentialRampToValueAtTime(.0001, at + duration);
    source.connect(filter); filter.connect(gain); gain.connect(c.destination); source.start(at); source.stop(at + duration);
    source.onended = () => { source.disconnect(); filter.disconnect(); gain.disconnect(); };
  }
  schedule() {
    if (!this.enabled || this.context.state !== 'running') return;
    // 恢复后台挂起后不补播已过时的音符。
    if (this.next < this.context.currentTime - 0.2) this.next = this.context.currentTime + 0.02;
    while (this.next < this.context.currentTime + 0.15) {
      const progression = [48, 44, 51, 46]; const root = progression[Math.floor(this.step / 16) % 4];
      const note = root + [12, 19, 24, 19, 15, 19, 24, 27][this.step % 8];
      const hz = n => 440 * 2 ** ((n - 69) / 12);
      this.tone(hz(note), this.next, 0.19, 'triangle', 0.026);
      if (this.step % 4 === 0) { this.tone(130, this.next, 0.15, 'sine', 0.09, 40); this.tone(hz(root - 12), this.next, 0.3, 'triangle', 0.055); }
      if (this.step % 2) this.tone(6500, this.next, 0.025, 'square', 0.006, 3000);
      this.next += 60 / 112 / 4; this.step++;
    }
  }
  effect(name, payload = {}) {
    if (!this.enabled || this.context?.state !== 'running') return;
    const t = this.context.currentTime;
    const id = typeof payload === 'string' ? payload : payload?.id || payload?.obstacle || '';
    const hazard = { ...HAZARD_BY_ID[id], ...(typeof payload === 'object' && payload) };
    if (name === 'warning') {
      if (id === 'ltc') {
        this.tone(320, t, .18, 'triangle', .035, 1600); this.noise(t, .16, .025, 3200); return;
      }
      if (id === 'sol') {
        [690, 345, 780, 260].forEach((note, i) => this.tone(note, t + i * .045, .035, 'square', .02)); return;
      }
      if (id === 'xrp' || id === 'whale') {
        this.noise(t, .32, .035, id === 'xrp' ? 1700 : 950); this.tone(id === 'xrp' ? 360 : 160, t, .28, 'sine', .025, 240); return;
      }
      if (id === 'doge' || id === 'bear') {
        const base = id === 'doge' ? 190 : 95;
        [0, .15].forEach(offset => { this.tone(base, t + offset, .09, 'sawtooth', .025, base * .6); this.noise(t + offset, .06, .015, 800); }); return;
      }
      if (id === 'usdt' || id === 'dai') {
        [1100, 1470, 1760].forEach((note, i) => this.tone(note, t + i * .065, .22, 'sine', .021));
        if (id === 'usdt') this.noise(t + .03, .3, .02, 4500); return;
      }
      if (id === 'gas') {
        [120, 175, 110].forEach((note, i) => this.tone(note, t + i * .08, .13, 'sine', .035, note * 1.8)); this.noise(t, .2, .015, 600); return;
      }
      if (id === 'liquidation') {
        [0, .12, .24].forEach(offset => this.tone(1350, t + offset, .075, 'sawtooth', .017, 450)); return;
      }
      // Each creature gets its own pitch; behavior adds an audible direction/texture.
      const seed = [...id].reduce((sum, char) => sum + char.charCodeAt(0), 0), base = 420 * 2 ** ((seed % 9) / 12);
      if (hazard.behavior === 'sweep') {
        this.tone(base, t, .11, 'triangle', .035, base * 1.5);
        this.tone(base * 1.5, t + .11, .1, 'triangle', .03, base);
      } else if (hazard.behavior === 'weather') {
        [1, 1.25, 1.5].forEach((ratio, i) => this.tone(base * ratio, t + i * .045, .18, 'sine', .023));
      } else if (hazard.behavior === 'slow') {
        this.tone(base * .65, t, .2, 'sine', .035, base * .45); this.noise(t + .04, .12, .015, 650);
      } else {
        this.tone(base, t, .09, 'square', .018); this.tone(base, t + .14, .09, 'square', .018);
      }
    }
    if (name === 'impact' || name === 'stumble') {
      const kind = hazard.impact || hazard.kind || 'trip';
      if (id === 'sol') [760, 200, 540].forEach((note, i) => this.tone(note, t + i * .055, .045, 'square', .025));
      if (id === 'xrp' || id === 'whale') this.noise(t, .4, .05, 1800);
      if (id === 'gas') this.noise(t, .3, .04, 450);
      if (id === 'liquidation') this.tone(1850, t, .28, 'sawtooth', .025, 160);
      if (kind === 'crush') {
        this.tone(120, t, .3, 'sine', .13, 35); this.tone(210, t, .12, 'square', .025, 70); this.noise(t, .18, .055, 1600);
      } else if (kind === 'trip') {
        this.tone(270, t, .13, 'triangle', .06, 110); this.tone(155, t + .14, .15, 'triangle', .045, 65); this.noise(t, .1, .025, 850);
      } else if (kind === 'spin') {
        for (let i = 0; i < 5; i++) this.tone(900 * 2 ** (-i / 4), t + i * .075, .2, 'sine', .04, 180 + i * 20);
      } else if (kind === 'freeze') {
        [1300, 1650, 2200].forEach((frequency, i) => this.tone(frequency, t + i * .055, .3, 'sine', .026)); this.noise(t, .2, .035, 6000);
      } else if (kind === 'launch') {
        this.tone(170, t, .34, 'triangle', .065, 1500); this.noise(t, .25, .03, 2200);
      }
    }
    if (name === 'dissolve' || name === 'dodge') {
      this.tone(750, t, .11, 'sine', .02, 1250); this.noise(t, .08, .008, 4000);
    }
    if (name === 'rocket') this.tone(170, t, .4, 'sawtooth', .025, 900);
    if (name === 'nearMiss') { this.tone(1500, t, .18, 'sawtooth', .026, 380); this.noise(t, .13, .026, 5500); }
    if (name === 'weather') this.noise(t, .45, .02, 1700);
    if (name === 'tap') this.tone(300 + Math.random() * 80, t, 0.04, 'sine', 0.022, 150);
    if (name === 'move') this.tone(400, t, 0.1, 'triangle', 0.025, 800);
    if (name === 'countdown') this.tone(560, t, 0.1, 'sine', 0.06);
    if (['go', 'checkpoint', 'win'].includes(name)) [523, 659, 784, 1047].forEach((n, i) => this.tone(n, t + i * 0.09, 0.25, 'triangle', 0.055));
    if (name === 'lose') this.tone(300, t, 0.5, 'triangle', 0.07, 65);
  }
  async suspend() { this.suspended = true; await this.sync(); }
  async resume() { if (this.destroyed) return; this.suspended = false; await this.sync(); }
  destroy() {
    this.destroyed = true; this.enabled = false; ++this.revision; clearInterval(this.timer);
    if (this.context?.state !== 'closed') this.context?.close().catch(() => {});
  }
}
