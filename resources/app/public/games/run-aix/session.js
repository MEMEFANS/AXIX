// 只读平台登录态与余额，永远不请求钱包连接、签名、授权或转账。
export class WebsiteSession {
  constructor(onChange) { this.onChange = onChange; this.revision = 0; }
  async refresh() {
    const revision = ++this.revision;
    clearTimeout(this.retryTimer); this.retryTimer = null;
    this.controller?.abort(); this.controller = new AbortController();
    const signal = this.controller.signal;
    // 2026-10-28：登录态直接以平台会话 API（cookie）为准，不再依赖父页的钱包全局对象——
    // 之前嵌入态下父页对象刷新/断连的瞬间会被误判成未登录，反复弹"去登录"。
    this.onChange({ status: 'loading' });
    const timeout = setTimeout(() => this.controller?.signal === signal && this.controller.abort(), 7000);
    try {
      const response = await fetch('/api/a-token/profile', { credentials: 'same-origin', cache: 'no-store', signal });
      if (revision !== this.revision) return;
      if (response.status === 401 || response.status === 403) return this.onChange({ status: 'guest' });
      if (!response.ok) throw new Error('balance unavailable');
      const profile = await response.json();
      if (revision !== this.revision) return;
      const value = String(profile.balances?.A ?? '');
      if (!/^\d+(\.\d+)?$/.test(value) || !/^0x[0-9a-f]{40}$/i.test(profile.wallet || '')) throw new Error('invalid profile');
      this.onChange({ status: 'ready', address: profile.wallet, balance: value });
    } catch {
      if (revision !== this.revision) return;
      this.onChange({ status: 'unavailable' });
      // 2026-10-28：失败后 4 秒自动重试（部署重启等瞬时不可用可秒级自愈），成功前不叠加多个重试
      this.retryTimer ||= setTimeout(() => { this.retryTimer = null; if (revision === this.revision) this.refresh(); }, 4000);
    }
    finally { clearTimeout(timeout); }
  }
  start() {
    if (this.listener) return;
    this.listener = () => this.refresh();
    try { window.parent.addEventListener('walletstatechange', this.listener); } catch {}
    window.addEventListener('focus', this.listener);
    this.interval = setInterval(() => this.refresh(), 30000);
    this.refresh();
  }
  stop() {
    ++this.revision; this.controller?.abort(); clearTimeout(this.retryTimer); clearInterval(this.interval);
    try { window.parent.removeEventListener('walletstatechange', this.listener); } catch {}
    window.removeEventListener('focus', this.listener);
    this.listener = null;
  }
}
