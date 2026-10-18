import assert from 'node:assert/strict';
import '../public/js/trade-history.js';
const { analyze, render, units, money } = globalThis.TradeHistory;
const fill = (id, side, size, price, fee, pnl = '0', extra = {}) => ({
  id, side, symbol:'BTC', product:'perp', size, price, fee, pnl,
  createdAt:new Date(Date.UTC(2026,8,10,0,0,Number(id.replace(/\D/g, '')))).toISOString(), ...extra,
});
const profile = (fills, size = '0', other = {}) => ({ fills, perps:{BTC:{size,realizedPnl:'109.9',totalFee:'62.61196',fundingPnl:'0'}}, ...other });
const open = fill('f1','buy','1','78210','31.284');
const close = fill('f2','sell','1','78319.9','31.32796','109.9',{reduceOnly:true});
const sample = profile([close, open]);
let result = analyze(sample);
assert.equal(result.get('f1').action, '买入开多');
assert.equal(result.get('f1').closeNet, null);
assert.equal(result.get('f2').action, '卖出平多');
assert.equal(result.get('f2').closeNet, 47288040n);
let html = render(sample);
assert.ok(html.includes('+47.29'));
assert.ok(html.includes('31.33'));
assert.ok(html.includes('31.28'));
assert.ok(!html.includes('78.57'));
assert.ok(!html.includes('−31.28'));
assert.ok(html.includes('开仓成交'));
assert.ok(html.includes('平仓净收益'));

// Weighted opening fees are released pro-rata on partial closes; the final close
// consumes the remainder so splitting a position never loses fee precision.
const partial = profile([
  fill('f1','buy','1','100','0.04'), fill('f2','buy','1','120','0.048'),
  fill('f3','sell','0.5','130','0.026','10'), fill('f4','sell','1.5','140','0.084','45'),
]);
result = analyze(partial);
assert.equal(result.get('f3').allocatedOpenFee,22000n);
assert.equal(result.get('f4').allocatedOpenFee,66000n);
assert.equal(result.get('f3').closeNet + result.get('f4').closeNet,54802000n);

// One sell may both close a long and open a short. Attribute only the closing
// part of that execution's fee to the closed long, then carry the rest forward.
const reverse = profile([
  fill('f1','buy','1','100','0.04'), fill('f2','sell','2','110','0.088','10'),
  fill('f3','buy','1','100','0.04','10'),
]);
result = analyze(reverse);
assert.equal(result.get('f2').action,'卖出平多 / 开空');
assert.equal(result.get('f2').closeNet,9916000n);
assert.equal(result.get('f3').action,'买入平空');
assert.equal(result.get('f3').closeNet,9916000n);

// Missing opening fills must never be treated as a zero-cost opening.
result = analyze(profile([close]));
assert.equal(result.get('f2').closeNet,null);
assert.equal(result.get('f2').action,'卖出平多');
assert.ok(render(profile([close])).includes('开仓记录不完整'));
result = analyze(profile([fill('f1','sell','1','100','0.04','0'),fill('f2','buy','1','90','0.036'),fill('f3','sell','1','95','0.038','5')]));
assert.equal(result.get('f3').closeNet,4926000n);
assert.equal(analyze(profile([open,{...close,createdAt:open.createdAt}])).size,0);

// Small fee dust must be consumed exactly on the last partial close.
result = analyze(profile([fill('f1','buy','3','1','0.000001'),fill('f2','sell','1','1','0.000001'),fill('f3','sell','2','1','0.000001')]));
assert.equal(result.get('f2').allocatedOpenFee,0n);
assert.equal(result.get('f3').allocatedOpenFee,1n);

// A liquidation is a close, and a losing close keeps its negative sign.
result = analyze(profile([open,{...close,pnl:'-20',liquidation:true}]));
assert.equal(result.get('f2').action,'强平多仓');
assert.equal(result.get('f2').closeNet,-82611960n);
assert.equal(money(-1n,true),'0.00');
assert.equal(money(47288040n,true),'+47.29');
assert.equal(units('1.0000001'),null);

// Only the chosen product/market is shown. Spot fees are not presented as PnL.
const spot = {...open,id:'s1',product:'spot'};
html=render(profile([open,close,spot]));
assert.ok(html.includes('最近 2 条'));
html=render(profile([spot]),{product:'spot'});
assert.ok(!html.includes('累计净收益'));
assert.ok(!html.includes('平仓净收益'));
const cancelled = {...open,id:'cancelled',clientOrderId:'absent',status:'cancelled',type:'limit',limitPrice:'70000'};
html=render({...sample,orderHistory:[cancelled,{...close,status:'filled'}]},{view:'history'});
assert.ok(html.includes('已撤销'));
assert.ok(html.includes('委托价格'));
assert.ok(html.includes('+47.29'));

// Funding appears in the cumulative summary once, not in each close card.
html=render(profile([open,close],'0',{perps:{BTC:{size:'0',realizedPnl:'109.9',totalFee:'62.61196',fundingPnl:'-1'}}}));
assert.ok(html.includes('+46.29'));
assert.ok(html.includes('+47.29'));
console.log('trade history presentation: reconciliation, partial close, reversal, short, liquidation, missing history, funding, spot and cancelled orders passed');
