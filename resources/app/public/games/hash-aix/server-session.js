// 哈希星盘服务端会话（2026-10-27）：资金与随机源全部在服务端（/api/hash-aix/*），
// 本类只负责状态编排：open（可押注）→ locked（已押注，揭晓动画）→ revealed。
// 公平性承诺（serverSeedHash）由 /state 在押注前公布，局后随记录揭示明文。
import { RULES } from './core.js?v=20261028c';

export class ServerSession {
  constructor({ now = Date.now } = {}) {
    this._now = now;
    this.state = null;      // /state 响应：balanceA、fairness、stats、recent、区间配置
    this.pending = null;    // { record, locksAt, revealsAt }
    this.history = [];      // 最近记录（新→旧）
    this.stats = { turnoverA: '0', bets: 0, recentBets: 0, wins: 0, stakedA: '0', payoutA: '0', netA: '0' };
    this.ready = false;
    this.unavailable = false; // 平台接口不可用（纯静态预览/网络故障）
    this.lastError = null;
    this._busy = 0;
  }
  get busy() { return this._busy > 0; }
  get phase() {
    if (!this.pending) return this.ready ? 'open' : 'idle';
    return this._now() >= this.pending.revealsAt ? 'revealed' : 'locked';
  }
  get current() { return this.pending?.record || null; }
  get countdownMs() { return this.pending ? Math.max(0, this.pending.revealsAt - this._now()) : 0; }
  get nextNonce() { return this.pending ? this.pending.record.nonce + 1 : Number(this.state?.fairness?.nonce) || 1; }
  get nextCommitment() { return this.pending ? this.pending.record.serverSeedHash : this.state?.fairness?.serverSeedHash || ''; }

  async load() {
    try {
      const [stateRes, historyRes] = await Promise.all([
        fetch('/api/hash-aix/state', { credentials: 'same-origin', cache: 'no-store' }),
        fetch('/api/hash-aix/history', { credentials: 'same-origin', cache: 'no-store' }),
      ]);
      if (stateRes.status === 401 || stateRes.status === 403) return { ok: false, error: 'auth' };
      if (!stateRes.ok || !historyRes.ok) throw new Error('bad-status');
      this.state = await stateRes.json();
      const history = await historyRes.json();
      this.history = history.records || [];
      this.stats = { turnoverA: history.turnoverA || '0', bets: history.bets || 0, recentBets: history.recentBets || 0,
        wins: history.wins || 0, stakedA: history.stakedA || '0', payoutA: history.payoutA || '0', netA: history.netA || '0' };
      this.ready = true; this.unavailable = false; this.lastError = null;
      return { ok: true };
    } catch {
      this.unavailable = true; this.ready = false;
      return { ok: false, error: 'unavailable' };
    }
  }

  async wager(choice, stakeA, clientSeed) {
    this._busy++;
    try {
      const response = await fetch('/api/hash-aix/bet', {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ choice, stakeA, clientSeed }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        this.lastError = data.error || '押注未完成，请稍后重试。';
        return { ok: false, error: data.code || 'bet-failed', message: this.lastError };
      }
      const now = this._now();
      this.pending = { record: data.record, locksAt: now, revealsAt: now + RULES.quickRevealMs };
      this.state = { ...this.state, balanceA: data.balanceA, fairness: data.next };
      this.history.unshift(data.record);
      this.history = this.history.slice(0, 50);
      return { ok: true, record: data.record };
    } catch {
      return { ok: false, error: 'network', message: '网络异常，押注未完成。' };
    } finally { this._busy--; }
  }

  // 静默刷新余额/统计/历史（揭晓后调用，不阻塞 UI）
  async refreshStats() {
    try {
      const response = await fetch('/api/hash-aix/history', { credentials: 'same-origin', cache: 'no-store' });
      if (!response.ok) return;
      const history = await response.json();
      this.history = history.records || this.history;
      this.stats = { turnoverA: history.turnoverA || '0', bets: history.bets || 0, recentBets: history.recentBets || 0,
        wins: history.wins || 0, stakedA: history.stakedA || '0', payoutA: history.payoutA || '0', netA: history.netA || '0' };
      if (this.state) this.state.stats = this.stats;
    } catch { /* 静默失败，下次揭晓再试 */ }
  }

  beginRound() { this.pending = null; }
}
