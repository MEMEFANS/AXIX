// 只读网站登录态与余额，永远不请求钱包连接、签名、授权或转账。
export class WebsiteSession {
  constructor(onChange) { this.onChange = onChange; this.revision = 0; }
  async refresh() {
    const revision = ++this.revision;
    this.controller?.abort(); this.controller = new AbortController();
    const signal = this.controller.signal;
    let websiteProfile, embedded = false;
    try { if (window.parent !== window) { embedded = true; websiteProfile = window.parent.currentWalletProfile; } } catch {}
    if (embedded && !websiteProfile?.authenticated) return this.onChange({ status: 'guest' });
    this.onChange({ status: 'loading', address: embedded ? websiteProfile.address : undefined });
    const timeout = setTimeout(() => this.controller?.signal === signal && this.controller.abort(), 7000);
    try {
      const response = await fetch('/api/a-token/profile', { credentials: 'same-origin', cache: 'no-store', signal });
      if (revision !== this.revision) return;
      if (response.status === 401 || response.status === 403) return this.onChange({ status: 'guest' });
      if (!response.ok) throw new Error('balance unavailable');
      const profile = await response.json();
      if (revision !== this.revision) return;
      let current;
      try { if (window.parent !== window) current = window.parent.currentWalletProfile; } catch {}
      if (embedded && (!current?.authenticated || (current.address || '').toLowerCase() !== String(profile.wallet || '').toLowerCase())) {
        return this.onChange({ status: 'guest' });
      }
      const value = String(profile.balances?.A ?? '');
      if (!/^\d+(\.\d+)?$/.test(value) || !/^0x[0-9a-f]{40}$/i.test(profile.wallet || '')) throw new Error('invalid profile');
      this.onChange({ status: 'ready', address: profile.wallet, balance: value });
    } catch { if (revision === this.revision) this.onChange({ status: 'unavailable' }); }
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
    ++this.revision; this.controller?.abort(); clearInterval(this.interval);
    try { window.parent.removeEventListener('walletstatechange', this.listener); } catch {}
    window.removeEventListener('focus', this.listener);
    this.listener = null;
  }
}
