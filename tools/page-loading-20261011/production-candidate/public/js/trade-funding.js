// 资金费率倒计时模块：仅合约模式显示，每秒更新 HH:MM:SS（费率为每 8 小时结算一次，与币安一致）
window.TradeFunding = (() => {
  let nextFundingAt = 0;
  let fundingRate = 0;
  let timer = null;

  function pad(n) { return String(n).padStart(2, '0'); }

  function render() {
    const statEl = document.getElementById('trade-funding-stat');
    if (!statEl) return;
    if (!nextFundingAt) {
      statEl.hidden = true;
      return;
    }
    statEl.hidden = false;
    const remaining = Math.max(0, nextFundingAt - Date.now());
    const h = Math.floor(remaining / 3600000);
    const m = Math.floor((remaining % 3600000) / 60000);
    const s = Math.floor((remaining % 60000) / 1000);
    const rateEl = document.getElementById('trade-funding-rate');
    const cdEl = document.getElementById('trade-funding-countdown');
    if (rateEl) rateEl.textContent = `${(fundingRate * 100).toFixed(4)}%`;
    if (cdEl) cdEl.textContent = `${pad(h)}:${pad(m)}:${pad(s)}`;
  }

  function start() {
    if (timer) return;
    render();
    timer = setInterval(render, 1000);
  }

  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
    const statEl = document.getElementById('trade-funding-stat');
    if (statEl) statEl.hidden = true;
  }

  function update(profile) {
    const risk = profile?.risk;
    if (!risk) return;
    nextFundingAt = Number(risk.nextFundingAt) || 0;
    fundingRate = Number(risk.fundingRate) || 0;
    if (timer) render();
  }

  function setProduct(product) {
    if (product === 'perp') start();
    else stop();
  }

  return { update, setProduct };
})();
