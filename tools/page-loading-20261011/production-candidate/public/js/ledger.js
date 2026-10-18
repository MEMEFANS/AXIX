let ledgerRequestSeq = 0, ledgerLoading = false;
async function loadLedger(reset = true) {
  if (ledgerLoading && !reset) return;
  ledgerLoading = true;
  const seq = ++ledgerRequestSeq, wallet = window.Portal?.walletKey();
  const exchange = $('ledger-exchange').value;
  if (reset) { ledgerOffset = 0; $('ledger-body').innerHTML = '<tr><td class="empty-row" colspan="9">正在读取账本…</td></tr>'; }
  try {
    const data = await Portal.readJSON(`/api/ledger?exchange=${encodeURIComponent(exchange)}&offset=${ledgerOffset}&limit=${ledgerLimit}`);
    if (seq !== ledgerRequestSeq || wallet !== Portal.walletKey() || exchange !== $('ledger-exchange').value) return;
    const rows = data.items.map((record) => {
      const kind = record.kind === 'recovery' ? '回收' : record.kind === 'close' || record.closing ? '平仓' : '开仓';
      const side = record.side === 'buy' ? '买' : '卖';
      return `<tr><td data-label="时间">${tradeTime(record.t)}</td><td data-label="交易所">${escapeHtml(ledgerExchangeName[record.exchange] || record.exchange)}</td><td data-label="市场">${escapeHtml(record.market || '—')}</td><td data-label="类型">${kind}</td><td data-label="方向"><span class="pill ${record.side === 'buy' ? 'pill-buy' : 'pill-sell'}">${side}</span></td><td data-label="成交价">${fmt(record.price, 8)}</td><td data-label="数量">${fmt(record.size, 8)}</td><td data-label="手续费">${record.fee == null ? '—' : fmt(record.fee, 4)}</td><td data-label="净盈亏">${tradeMoneyHtml(record.realizedPnl)}</td></tr>`;
    }).join('');
    if (reset) $('ledger-body').innerHTML = rows || '<tr><td class="empty-row" colspan="9">暂无成交记录</td></tr>';
    else $('ledger-body').insertAdjacentHTML('beforeend', rows);
    ledgerOffset += data.items.length;
    $('ledger-more').style.display = ledgerOffset < data.total ? '' : 'none';
    const s = data.summary;
    $('ledger-records').textContent = s.records;
    $('ledger-completed').textContent = s.completed;
    $('ledger-winrate').textContent = s.winRate == null ? '—' : `${fmt(s.winRate, 2)}%`;
    $('ledger-winloss').textContent = `胜 ${s.wins} / 负 ${s.losses}`;
    $('ledger-pnl').innerHTML = tradeMoneyHtml(s.realizedPnl);
    $('ledger-fees').textContent = fmt(s.fees, 4);
  } catch (error) {
    if (seq !== ledgerRequestSeq || wallet !== Portal.walletKey()) return;
    $('ledger-body').innerHTML = `<tr><td class="empty-row down" colspan="9">${escapeHtml(error.message)}</td></tr>`;
  } finally { if (seq === ledgerRequestSeq) ledgerLoading = false; }
}
function exportLedger() {
  const exchange = $('ledger-exchange').value;
  const link = document.createElement('a');
  link.href = `/api/ledger/export.csv?exchange=${encodeURIComponent(exchange)}`;
  link.click();
}
