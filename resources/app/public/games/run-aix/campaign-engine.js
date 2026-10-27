// A non-economic, replayable campaign runner built on the existing road
// simulation. It deliberately does not call chooseOutcome or PracticeStore.
import { RunnerEngine } from './engine.js?v=20261027c';
import { getLevel, createCampaignCatalog } from './campaign.js?v=20261027c';

const finite = value => Number.isFinite(value);

export class CampaignEngine extends RunnerEngine {
  constructor({ level = 'level-1', random = Math.random, onEvent = () => {}, catalog } = {}) {
    const selected = typeof level === 'string' ? getLevel(level) : level;
    if (!selected?.rules || typeof selected.id !== 'string') throw new RangeError('闯关关卡不存在。');
    let self;
    super({
      random, rules: selected.rules, catalog: createCampaignCatalog(selected, catalog),
      onEvent: (name, data) => {
        if (self) self.#handleCoreEvent(name, data);
        else onEvent(name, data);
      },
    });
    self = this;
    this.level = selected;
    this.levelId = selected.id;
    // 场景交由 art.js 按进度自动切换（星空 → 交易所 → 海域）。
    this.sceneIndex = null;
    this._campaignOnEvent = onEvent;
    // 一击即死：地狱航线只给一条命，碰上即终局。
    this.maxHearts = 1;
    this.hearts = this.maxHearts;
    this.hits = 0;
    this.dodges = 0;
    this.combo = 0;
    this.bestCombo = 0;
    this._updating = false;
    this._pendingEnd = null;
    this._ending = false;
  }

  #emit(name, data) { this._campaignOnEvent(name, data); }

  #handleCoreEvent(name, data) {
    // The classic checkpoint opens a financial take/continue modal. Campaign
    // checkpoints are automatic milestones, so never forward that event under
    // the classic name.
    if (name === 'checkpoint') {
      this.continue();
      this.#emit('campaignCheckpoint', { levelId: this.levelId, distance: this.distance });
      return;
    }
    if (name === 'dodge') {
      this.dodges += 1;
      // 赛车式擦身（near-miss）：换道后 0.45 秒内，障碍从相邻车道贴身飞过 → 额外 +2 连击。
      const gap = Math.abs(this.visualLane - data.lane);
      if (gap >= .56 && gap < 1.55 && this.time - (this.lastMoveAt ?? -9) < .45) {
        this.nearMisses += 1;
        this.combo += 2;
        this.bestCombo = Math.max(this.bestCombo, this.combo);
        this.#emit('nearMiss', { obstacle: data, nearMisses: this.nearMisses, combo: this.combo });
      }
      this.combo += 1;
      this.bestCombo = Math.max(this.bestCombo, this.combo);
    }
    if (name === 'impact' && ['weather', 'slow'].includes(data?.behavior)) {
      // 地狱模式没有软碰撞：天气与减速带同样致命，碰上即终局。
      this.end('collision', data);
      return;
    }
    this.#emit(name, data);
  }

  start() {
    if (!super.start(1)) return false;
    Object.assign(this, {
      level: this.level,
      levelId: this.level.id,
      maxHearts: 1,
      hearts: 1,
      hits: 0,
      dodges: 0,
      nearMisses: 0,
      combo: 0,
      bestCombo: 0,
      _pendingEnd: null,
      _updating: false,
      _ending: false,
    });
    return true;
  }

  update(delta) {
    if (!finite(delta) || delta <= 0) return;
    if (['lobby', 'paused', 'ended'].includes(this.state)) return;
    if (this.state === 'running') this._updating = true;
    try { super.update(delta); }
    finally { this._updating = false; }
    if (this._pendingEnd) {
      const { reason, obstacle } = this._pendingEnd;
      this._pendingEnd = null;
      this.#finish(reason, obstacle);
    }
  }

  end(reason, obstacle) {
    // _ending 防重入：impact() 会再发一次碰撞事件，soft 碰撞拦截若再调
    // end() 就会无限递归（栈溢出后异常被帧循环吞掉，表现为碰撞不死）。
    if (!['running', 'checkpoint'].includes(this.state) || this._ending) return;
    if (reason === 'collision' && obstacle) {
      obstacle.passed = true;
      this.hits += 1;
      this.combo = 0;
      this.hearts = 0;
      this._ending = true;
      try { this.impact(obstacle); } finally { this._ending = false; }
    }
    // RunnerEngine ends during its update; commit after the frame completes.
    if (this._updating) { this._pendingEnd = { reason, obstacle }; return; }
    this.#finish(reason, obstacle);
  }

  #finish(reason) {
    this.state = 'ended';
    this.rocketActive = false;
    this.speed = 0;
    const completed = reason !== 'collision' && this.distance >= this.rules.maxDistance;
    if (completed) this.distance = this.rules.maxDistance;
    this.result = Object.freeze({
      id: this.id,
      date: Date.now(),
      levelId: this.levelId,
      distance: Math.floor(this.distance),
      completed,
      // 一击即死模式下没有收集维度：活着抵达终点即三星。
      stars: completed ? 3 : 0,
      reason: reason === 'collision' ? 'collision' : 'finish',
      hits: this.hits,
      dodges: this.dodges,
      nearMisses: this.nearMisses,
      elapsed: Math.round(this.time * 1000) / 1000,
      bestCombo: this.bestCombo,
      hearts: this.hearts,
      maxHearts: this.maxHearts,
    });
    this.#emit('end', this.result);
  }

  // Campaign checkpoints always continue. The classic take action has no
  // counterpart in an adventure level.
  take() {}
}

