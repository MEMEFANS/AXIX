(function (root) {
  'use strict';
  const abs = value => value < 0n ? -value : value;
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function units(value, decimals = 6) {
    const match = String(value ?? '').match(/^(-?)(\d+)(?:\.(\d*))?$/);
    if (!match || (match[3] || '').length > decimals) return null;
    return (match[1] ? -1n : 1n) * BigInt(match[2] + (match[3] || '').padEnd(decimals, '0'));
  }
  function raw(row, name, formatted, decimals = 6) {
    if (row[name] != null && /^-?\d+$/.test(String(row[name]))) return BigInt(row[name]);
    return units(row[formatted], decimals);
  }
  function money(value, signed = false) {
    if (value == null) return '—';
    const cents = (abs(value) + 5000n) / 10000n;
    const number = `${(cents / 100n).toLocaleString('en-US')}.${String(cents % 100n).padStart(2, '0')}`;
    return `${value < 0n && cents ? '−' : signed && cents ? '+' : ''}${number}`;
  }
  function quantity(value) {
    if (value == null) return '—';
    const fraction = String(abs(value) % 100000000n).padStart(8, '0').replace(/0+$/, '');
    return `${(abs(value) / 100000000n).toLocaleString('en-US')}${fraction ? '.' + fraction : ''}`;
  }
  const tone = value => value == null || value === 0n ? '' : value > 0n ? 'up' : 'down';

  // Reconstruct signed positions from the current position backwards. An opening
  // outside the returned history has unknown fees until that position is closed.
  // This is presentation only: stored pnl/netPnl and wallet balances are untouched.
  function analyze(profile) {
    const result = new Map(), groups = new Map();
    for (const fill of profile?.fills || []) {
      if (fill.product !== 'perp') continue;
      if (!groups.has(fill.symbol)) groups.set(fill.symbol, []);
      groups.get(fill.symbol).push(fill);
    }
    for (const [symbol, items] of groups) {
      const rows = [...items].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
      const position = profile.perps?.[symbol];
      let size = position ? raw(position, 'sizeUnits', 'size', 8) : null;
      const parsed = rows.map(fill => ({ fill, amount:raw(fill, 'sizeUnits', 'size', 8), fee:raw(fill, 'feeUnits', 'fee'), pnl:raw(fill, 'pnlUnits', 'pnl') }));
      const timestamps = rows.map(row => Date.parse(row.createdAt));
      // Older servers don't supply an execution sequence for equal timestamps.
      // Do not invent a fee allocation when the execution order is ambiguous.
      if (size == null || timestamps.some(time => !Number.isFinite(time)) || new Set(timestamps).size !== timestamps.length
          || parsed.some(row => row.amount == null || row.amount <= 0n || row.fee == null || row.fee < 0n || row.pnl == null || !['buy','sell'].includes(row.fill.side))) continue;
      for (const row of parsed) size -= row.fill.side === 'buy' ? row.amount : -row.amount;
      let openingFees = size === 0n ? 0n : null;
      for (const { fill, amount, fee, pnl } of parsed) {
        const delta = fill.side === 'buy' ? amount : -amount;
        const opposite = size !== 0n && (size > 0n) !== (delta > 0n);
        const closeSize = opposite ? (abs(size) < amount ? abs(size) : amount) : 0n;
        const openSize = amount - closeSize;
        let closeFee = 0n, allocatedOpenFee = null;
        if (closeSize) {
          // perpTrade rounds each leg up independently, including reversal orders.
          const price = raw(fill, 'priceUnits', 'price');
          closeFee = openSize && price != null ? ((closeSize * price / 100000000n) * 4n + 9999n) / 10000n : fee;
          if (closeFee > fee) closeFee = fee;
          allocatedOpenFee = openingFees == null ? null : openingFees * closeSize / abs(size);
          if (openingFees != null) openingFees -= allocatedOpenFee;
        }
        const action = closeSize
          ? (size > 0n ? '卖出平多' : '买入平空') + (openSize ? (delta > 0n ? ' / 开多' : ' / 开空') : '')
          : (delta > 0n ? '买入开多' : '卖出开空');
        result.set(fill.id, { action:fill.liquidation ? (size > 0n ? '强平多仓' : '强平空仓') : action,
          closeSize, openSize, closeFee, allocatedOpenFee,
          closeNet:closeSize && allocatedOpenFee != null ? pnl - closeFee - allocatedOpenFee : null });
        size += delta;
        if (size === 0n || (opposite && openSize)) openingFees = 0n;
        if (openSize && openingFees != null) openingFees += fee - closeFee;
      }
    }
    return result;
  }

  function summary(profile, symbol) {
    const pos = profile?.perps?.[symbol];
    if (!pos) return '';
    const gross = raw(pos, 'realizedPnlUnits', 'realizedPnl');
    const fees = raw(pos, 'feeUnits', 'totalFee');
    const funding = raw(pos, 'fundingPnlUnits', 'fundingPnl');
    if ([gross, fees, funding].some(value => value == null)) return '';
    const net = gross - fees + funding;
    return `<section class="th-summary" aria-label="${escape(symbol)} 合约累计收益">
      <div class="th-summary-top"><span>${escape(symbol)}/USDT · 累计净收益</span><small>USDT</small></div>
      <strong class="th-total ${tone(net)}">${money(net, true)}</strong>
      <div class="th-summary-metrics"><div><span>已实现毛盈亏</span><b>${money(gross, true)}</b></div><div><span>交易手续费</span><b>${money(fees)}</b></div><div><span>资金费用净额</span><b>${money(funding, true)}</b></div></div>
      <details class="th-explanation"><summary>收益计算说明</summary><p>累计净收益 = 已实现毛盈亏 − 交易手续费 + 资金费用净额。手续费包含未平仓已支付的开仓费；未实现盈亏不计入。</p><p>单笔平仓净收益已扣除对应开仓费及平仓费；资金费用在上方累计统计中单独计入。</p></details>
    </section>`;
  }

  function render(profile, { view = 'fills', product = 'perp', symbol = 'BTC', formatPrice } = {}) {
    const analysis = analyze(profile);
    const fillMap = new Map((profile?.fills || []).map(fill => [fill.id, fill]));
    const clientMap = new Map((profile?.fills || []).filter(fill => fill.clientOrderId).map(fill => [fill.clientOrderId, fill]));
    const records = (view === 'history' ? profile?.orderHistory : profile?.fills) || [];
    const filtered = records.filter(row => row.product === product && row.symbol === symbol);
    const field = (label, content, cls = '') => `<div class="th-field ${cls}"><dt>${label}</dt><dd>${content}</dd></div>`;
    const cards = filtered.map(row => {
      const fill = view === 'fills' ? row : fillMap.get(row.id) || clientMap.get(row.clientOrderId);
      const detail = fill ? analysis.get(fill.id) : null;
      const action = detail?.action || (product === 'perp' && row.reduceOnly
        ? (row.side === 'buy' ? '买入平空' : '卖出平多') : (row.side === 'buy' ? '买入' : '卖出'));
      const fee = fill ? raw(fill, 'feeUnits', 'fee') : null;
      const size = raw(fill || row, 'sizeUnits', 'size', 8);
      const priceValue = fill?.price ?? row.price ?? row.limitPrice ?? row.triggerPrice;
      const rawPrice = raw(fill || row, 'priceUnits', 'price');
      const price = priceValue != null && formatPrice ? escape(formatPrice(symbol, priceValue)) : money(rawPrice);
      const timeValue = fill?.createdAt || row.filledAt || row.createdAt;
      const date = new Date(timeValue);
      const time = Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('zh-CN', {year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false});
      const type = {market:'市价',limit:'限价',trigger:'条件',liquidation:'强平'}[row.type] || (fill?.liquidation ? '强平' : '成交');
      const status = {filled:'已成交',cancelled:'已撤销',rejected:'已拒绝'}[row.status] || '已成交';
      let pnl = '';
      if (product === 'perp' && fill) {
        if (detail?.closeSize) {
          const known = detail.closeNet != null;
          pnl = `<div class="th-pnl"><span>平仓净收益 <small>USDT</small></span><strong class="${tone(detail.closeNet)}">${money(detail.closeNet, true)}</strong></div>
            <details class="th-breakdown"><summary>${known ? '已扣开平仓手续费 · 查看明细' : '开仓记录不完整 · 查看已知明细'}</summary><dl>
              ${field('本次平仓数量', `${quantity(detail.closeSize)} ${escape(symbol)}`)}
              ${field('平仓毛盈亏', `${money(raw(fill, 'pnlUnits', 'pnl'), true)} USDT`)}
              ${field('对应开仓手续费', `${money(detail.allocatedOpenFee)}${known ? ' USDT' : ''}`)}
              ${field('本次平仓手续费', `${money(detail.closeFee)} USDT`)}
            </dl><p>平仓净收益不含资金费用；资金费用已计入累计净收益。</p></details>`;
        } else if (detail) {
          pnl = '<div class="th-open-note">开仓成交 · 手续费已扣除，平仓后结算收益</div>';
        } else {
          pnl = `<div class="th-open-note">成交毛盈亏 ${money(raw(fill, 'pnlUnits', 'pnl'), true)} USDT · 开平仓明细暂不可核实</div>`;
        }
      }
      return `<article class="th-card"><header><div class="th-market"><strong>${escape(symbol)}/USDT</strong><small>${product === 'perp' ? '永续' : '现货'}</small></div><span class="th-action ${row.side === 'buy' ? 'up' : 'down'}">${action}</span></header>
        <div class="th-meta"><time>${escape(time)}</time><span>${type}${view === 'history' ? ' · ' + status : ''}</span></div>
        <dl class="th-fields">${field(fill ? '成交价格（USDT）' : '委托价格（USDT）', price)}${field(fill ? '成交数量' : '委托数量', `${quantity(size)} <small>${escape(symbol)}</small>`)}${field('手续费（USDT）', money(fee))}${field('成交金额（USDT）', fill && rawPrice != null && size != null ? money(abs(size) * rawPrice / 100000000n) : '—')}</dl>${pnl}</article>`;
    }).join('');
    return `<div class="trade-history">${product === 'perp' ? summary(profile, symbol) : ''}<div class="th-list-heading"><span>${escape(symbol)}/USDT · ${view === 'history' ? '历史委托' : '成交历史'}</span><small>最近 ${filtered.length} 条</small></div><div class="th-list">${cards || '<div class="terminal-empty">暂无记录</div>'}</div></div>`;
  }
  root.TradeHistory = { analyze, render, units, money };
})(globalThis);
