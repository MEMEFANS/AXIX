import crypto from 'node:crypto';
import { formatUnits } from 'ethers';
import { A_TOKEN_DECIMALS, USDT_DECIMALS } from './a-token-service.js';

// 卖出最低门槛：100 AIX（买入不限制）
const MIN_SELL_A = 100n * 10n ** BigInt(A_TOKEN_DECIMALS);

// ─────────────────────────────────────────────────────────────
// A 币委托撮合服务（P2P 模式 v2）
//
// 核心规则：**买必须有人卖，卖必须有人买** —— 平台资金池不再兜底承接。
//   - 下单（市价/限价）→ 立即冻结资金 → 尝试吃对手方 OPEN 挂单
//   - 吃不满的剩余部分自动转为委托，等待对手方来成交
//     · 买单剩余 = 「委托求购」，冻结 USDT（计入顶部求购额度展示）
//     · 卖单剩余 = 「挂牌待售」，冻结 A
//   - 撮合触发点：新单进入 / K线价格变动 tick / 管理后台强制撮合
//
// 价格优先级：卖单价低者优先、买单价高者优先。
//   同价档内：买单按金额大者优先（大额买家先成交）；
//   卖单默认按挂单时间先来先成交（不按金额大小插队，大单小单都能优先卖给大额买家）；
//   每 N 次撮合尝试中有 C 次改为「小额轮」：买、卖都按金额小者优先，让小卖单偶尔配给小买单。
// 成交价取**先挂一方**的限价（maker 定价）。
// 成交条件：B.限价 >= S.限价，且至少一侧已被市场价格越过
//           （S.price <= 现价 或 B.price >= 现价）—— 保证平台调控价格能驱动旧挂单成交。
//
// 手续费口径（均由卖方承担，按投入量收取）：
//   卖家想卖出 n 个 A，冻结 n；手续费 = 消耗投入 × feeRate，净额 = 消耗投入 − 手续费：
//   例：50% 费率卖 1000 个 A → 手续费 500、净额 500 进入成交，卖家实收 净额 × 成交价。
//   手续费 50% 销毁、50% 进 A10 分红池。
//   买单零手续费，USDT 全额支付给卖家。
//
// 挂单即冻结（debit）；撤单原路退回；部分成交按比例核销；铸币/储备金在 P2P 结算中不动。
// ─────────────────────────────────────────────────────────────

const BPS = 10000n;
// 灰尘阈值：剩余量小于该值即视为「不可再成交的尾差」（挂单列表里会显示为 0）。
// 注意 decimals：USDT 6 位（0.001 USDT = 1e3）、AIX 18 位（0.001 AIX = 1e15）
const DUST_A = 10n ** 15n;     // 0.001 AIX
const DUST_USDT = 10n ** 3n;   // 0.001 USDT
const makeId = prefix => `${prefix}_${crypto.randomBytes(8).toString('hex')}`;

// 小额轮分布：每 window 次撮合尝试中有 count 次走「小额优先」，用 Bresenham 方式均匀铺开。
// 例：window=10 / count=3 → 第 4、7、10 次尝试照顾小额；window=10 / count=4 → 第 3、5、8、10 次。
export function smallFirstAt(seq, window = 10, count = 3) {
  const w = Math.max(1, Math.floor(Number(window) || 10));
  const k = Math.min(w, Math.max(0, Math.floor(Number(count) || 0)));
  if (k <= 0) return false;
  const phase = (((Math.floor(Number(seq) || 0) - 1) % w) + w) % w;
  return Math.floor((phase + 1) * k / w) !== Math.floor(phase * k / w);
}

export function createATokenOrderService({ aTokenService, database, teamService, referralService, clock = () => Date.now(), matchSmallFirstWindow = 10, matchSmallFirstCount = 3 }) {
  const at = aTokenService;
  const db = database;

  // 撮合优先级（价格为主键，买卖价交叉仍是硬性成交条件）：
  //   买单：同价档内始终「小额优先」（挂单金额小者先成交，金额相同再按挂单时间）——2026-10-23 用户确认
  //   卖单：同价档内默认按挂单时间先来先成交；
  //   每 SMALL_FIRST_WINDOW 次撮合尝试中有 SMALL_FIRST_COUNT 次改为「小额轮」，卖单也按金额小者优先。
  const SMALL_FIRST_WINDOW = Math.max(1, Math.floor(Number(matchSmallFirstWindow) || 10));
  const SMALL_FIRST_COUNT = Math.min(SMALL_FIRST_WINDOW, Math.max(0, Math.floor(Number(matchSmallFirstCount) || 0)));
  let matchAttemptSeq = 0;

  // 手续费分配规则（按用户规则）：
  //   卖方手续费 = 成交量 × feeBps（阶梯：直推 0~1→50%, 2~3→40%, 4~5→30%, 6~7→20%, 8~9→10%, ≥10→3%）
  //   手续费去向：50% 销毁 + 50% 进 A10 团队分红池（A10 用户日结均分）
  //   分红池（divRateBps）= 0：团队分润由 A10 池统一承担，不再单设分红池
  const BURN_RATE_BPS_DEFAULT = 5000n;   // 销毁：手续费的 50%
  const DIV_RATE_BPS_DEFAULT  = 0n;      // 分红池：0%（A10 池承担团队分润）
  const FEE_RATE_BPS_DEFAULT  = 5000n;   // 默认卖方合计 50% 手续费

  // 直推人数 → 卖方手续费率（bps）；规则：2→40% 4→30% 6→20% 8→10% 10→3%（含 10）
  function feeBpsByDirectCount(n) {
    const cnt = Number(n) || 0;
    if (cnt >= 10) return 300n;
    if (cnt >= 8)  return 1000n;
    if (cnt >= 6)  return 2000n;
    if (cnt >= 4)  return 3000n;
    if (cnt >= 2)  return 4000n;
    return FEE_RATE_BPS_DEFAULT;
  }

  // 后台费率覆盖（service_settings.a_token_fee_overrides）：指定地址直接用配置费率（bps），优先于直推阶梯
  function feeOverrideBpsOf(wallet) {
    try {
      const raw = db.getSetting?.('a_token_fee_overrides');
      if (!raw) return null;
      const bps = Number(JSON.parse(raw)?.wallets?.[String(wallet || '').toLowerCase()]);
      return Number.isFinite(bps) && bps >= 0 && bps <= 10000 ? BigInt(Math.floor(bps)) : null;
    } catch { return null; }
  }

  function minerDirectCountOf(wallet) {
    try { return referralService?.minerDirectCount?.(String(wallet || '').toLowerCase()) ?? 0; }
    catch { return 0; }
  }

  function feeRates(wallet) {
    const meta = at.getPoolMeta();
    // 卖方手续费：后台覆盖（a_token_fee_overrides）优先，其次直推阶梯（用户规则）：
    // 0~1→50%, 2~3→40%, 4~5→30%, 6~7→20%, 8~9→10%, ≥10→3%
    const fee = feeOverrideBpsOf(wallet) ?? feeBpsByDirectCount(minerDirectCountOf(wallet));
    return {
      fee,
      // 销毁 = 手续费的 50%；A10 池 = 手续费的 50%（不再单设分红池）
      burn: BURN_RATE_BPS_DEFAULT,
      div:  DIV_RATE_BPS_DEFAULT,
      a10:  BURN_RATE_BPS_DEFAULT,   // A10 池比例 = 手续费的 50%
    };
  }

  // ─────────────────────────────────────────────────────────────
  //  把订单里冻结的钱原路退回（撤单/系统升级退款用）
  // ─────────────────────────────────────────────────────────────
  function _refundLocked(order) {
    const wallet = String(order.wallet || '').toLowerCase();
    if (!wallet) return;
    if (BigInt(order.input_usdt_units || '0') > 0n) {
      at.creditUsdt(wallet, BigInt(order.input_usdt_units));
    }
    if (BigInt(order.input_a_units || '0') > 0n) {
      at.creditA(wallet, BigInt(order.input_a_units));
      // 撤单返还已占用的可卖额度（旧单未占用过额度时 used 归零，不会凭空发放额度）
      try { db.refundATokenSellQuota?.(wallet, BigInt(order.input_a_units)); } catch {}
    }
  }

  // 服务启动迁移（仅一次）：P2P 撮合上线前的存量 OPEN 单按旧口径结算，
  // 与新规则不兼容 → 自动撤单退款。
  // 判定依据：旧订单的 payload 里没有 feeRateBps（新撮合时代所有订单都会写入费率快照），
  // 避免每次重启都把正常挂着的委托撤掉
  function _migrateLegacyOpenOrders() {
    let cancelled = 0;
    try {
      for (const o of db.listATokenOpenOrders()) {
        try {
          let payload = {};
          try { payload = JSON.parse(o.payload_json || '{}') || {}; } catch {}
          if (payload.feeRateBps !== undefined) continue;   // 新撮合时代的订单，跳过
          _refundLocked(o);
          const t = clock();
          db.markATokenOrderCancelled(o.id, { cancelledAt: t, updatedAt: t, reason: 'system_upgrade:p2p_match' });
          cancelled += 1;
        } catch {}
      }
    } catch {}
    if (cancelled > 0) console.log(`[A币撮合] 系统升级：${cancelled} 笔旧版挂单已自动撤单退款`);
  }
  _migrateLegacyOpenOrders();

  // ─────────────────────────────────────────────────────────────
  //  挂单报价：限价单预览（不冻结、不入库）
  // ─────────────────────────────────────────────────────────────
  function quoteLimitOrder({ side, priceUsdt, amount, wallet = '' }) {
    const price = at.parseUsdt(priceUsdt, '限价');
    if (price <= 0n) throw new Error('限价必须大于 0');
    const priceStr = formatUnits(price, USDT_DECIMALS);

    if (side === 'buy') {
      // 买单零手续费：USDT 全额参与撮合，按限价折算可获得 A
      const usdt = at.parseUsdt(amount, '支付 USDT 数量');
      if (usdt <= 0n) throw new Error('支付 USDT 数量必须大于 0');
      const aReceive = at.usdtToA(usdt, price);
      if (aReceive <= 0n) throw new Error('购买数量过小，请增加 USDT 数量');
      return {
        side:'buy', orderType:'limit', priceUsdt:priceStr,
        usdtIn:formatUnits(usdt, USDT_DECIMALS),
        aOut:formatUnits(aReceive, A_TOKEN_DECIMALS),
        amountUsdt:formatUnits(usdt, USDT_DECIMALS),
        feeRateBps:0, feePct:'0%',
        hint:`冻结 ${formatUnits(usdt, USDT_DECIMALS)} USDT · 限价 ${priceStr} 可买入约 ${formatUnits(aReceive, A_TOKEN_DECIMALS)} AIX · 买方 0 手续费`,
      };
    }

    const rates = feeRates(wallet);   // 直推阶梯费率：0~1→50%, 2~3→40%, 4~5→30%, 6~7→20%, 8~9→10%, ≥10→3%
    const directCnt = minerDirectCountOf(wallet);

    // sell：冻结 = 卖出数量本身；手续费按投入量的费率比例划扣
    // 预估：费 = n × fee，净额 = n − 费（费率快照与成交时一致）
    const a = at.parseA(amount, '卖出 A 数量');
    const feeA = a * rates.fee / BPS;           // 手续费 = 投入量 × 费率
    const netA = a - feeA;                       // 净额 = 投入量 − 手续费
    const burnA = feeA / 2n;                    // 销毁 = 手续费 50%
    const a10A  = feeA - burnA;                  // A10 池 = 手续费 50%
    const divA = 0n;                             // 不再单设分红池
    const usdtOut = at.aToUsdt(netA, price);
    return {
      side: 'sell', orderType: 'limit', priceUsdt: priceStr,
      aIn: formatUnits(a, A_TOKEN_DECIMALS),
      lockedA: formatUnits(a, A_TOKEN_DECIMALS),
      usdtOut: formatUnits(usdtOut, USDT_DECIMALS),
      netA: formatUnits(netA, A_TOKEN_DECIMALS),
      feeA: formatUnits(feeA, A_TOKEN_DECIMALS),
      burnA: formatUnits(burnA, A_TOKEN_DECIMALS),
      dividendA: formatUnits(a10A, A_TOKEN_DECIMALS),
      feeRateBps: Number(rates.fee),
      directCount: directCnt,
      feePct: (Number(rates.fee) / 100).toFixed(0) + '%',
      hint: `只冻结卖出数量 ${formatUnits(a, A_TOKEN_DECIMALS)} A；当前有效直推 ${directCnt} 人 → 手续费 ${(Number(rates.fee) / 100).toFixed(0)}%（按投入量收取，50%销毁 + 50%进A10分红池），预计实收约 ${formatUnits(usdtOut, USDT_DECIMALS)} USDT`,
    };
  }

  // ─────────────────────────────────────────────────────────────
  //  下单：市价 / 限价 → 冻结资金 → 尝试撮合 → 未成交部分转委托
  // ─────────────────────────────────────────────────────────────
  function placeOrder({ wallet, side, orderType = 'market', priceUsdt, amount }) {
    if (side !== 'buy' && side !== 'sell') throw new Error('side 必须是 buy 或 sell');
    wallet = String(wallet || '').toLowerCase();
    if (!wallet) throw new Error('钱包地址必填');
    orderType = String(orderType).toLowerCase();
    if (orderType !== 'market' && orderType !== 'limit') throw new Error(`orderType 暂不支持：${orderType}`);

    const now0 = clock();
    const currentPrice = at.getPriceUsdtUnits();
    if (currentPrice <= 0n) throw new Error('当前价格无效，暂不能下单');

    // 市价单的"愿意成交价"锚定现价；限价单使用用户指定限价
    const limitPriceRaw = orderType === 'limit'
      ? at.parseUsdt(priceUsdt, '限价')
      : currentPrice;
    if (limitPriceRaw <= 0n) throw new Error('限价必须大于 0');
    const rates = feeRates(wallet);   // 卖方按直推阶梯费率（下单时快照进 payload，撮合按快照结算）

    let inputUsdtUnits = 0n;
    let inputAUnits = 0n;

    if (side === 'buy') {
      const usdt = at.parseUsdt(amount, '支付 USDT 数量');
      if (usdt <= 0n) throw new Error('支付 USDT 数量必须大于 0');
      if (at.balanceUsdt(wallet) < usdt) throw new Error('USDT 可用余额不足');
      const aReceive = at.usdtToA(usdt, limitPriceRaw);
      if (aReceive <= 0n) throw new Error('购买数量过小，请增加 USDT 数量');
      at.debitUsdt(wallet, usdt);                    // 冻结（全额 USDT，买方免手续费）
      inputUsdtUnits = usdt;
    } else {
      // sell：只冻结卖出数量本身；手续费在成交时按投入量比例划扣
      // （净额归卖家、费用部分走销毁/A10 池）——100% 可用余额可直接挂满
      const a = at.parseA(amount, '卖出 A 数量');
      if (at.balanceA(wallet) < a) {
        throw new Error(`A 币可用余额不足：需 ${formatUnits(a, A_TOKEN_DECIMALS)} A`);
      }
      if (a < MIN_SELL_A) throw new Error(`AIX 卖出最低 ${formatUnits(MIN_SELL_A, A_TOKEN_DECIMALS)} 个起，买入不限制`);
      // 2026-10-25：只有质押释放的产出（本金滴灌+利息）才可以卖，其他来源的 AIX 不能挂卖
      const quotaSnapshot = db.getATokenSellQuota(wallet);
      const quotaAvailable = BigInt(quotaSnapshot.releasedUnits) - BigInt(quotaSnapshot.usedUnits);
      if (quotaAvailable < a) {
        const avail = quotaAvailable > 0n ? quotaAvailable : 0n;
        throw new Error(`可用额度不足：只有质押释放的产出可以卖出，当前可用 ${formatUnits(avail, A_TOKEN_DECIMALS)} AIX`);
      }
      at.debitA(wallet, a);
      db.consumeATokenSellQuota(wallet, a);
      inputAUnits = a;
    }

    const orderId = makeId('aor');
    db.insertATokenOrderRow({
      id: orderId, wallet, side, orderType,
      orderPriceUsdtUnits: limitPriceRaw.toString(),
      inputUsdtUnits: inputUsdtUnits.toString(),
      inputAUnits: inputAUnits.toString(),
      status: 'OPEN',
      createdAt: now0, updatedAt: now0,
      payload: {
        orderType,
        feeRateBps: Number(rates.fee),
        burnRateBps: Number(rates.burn),
        divRateBps: Number(rates.div),
      },
    });

    // 新单立即参与撮合（吃对手方 / 被对手方吃由后续轮询处理）
    const fills = new Map();
    _matchPass(fills);

    const latest = db.getATokenOrder(orderId);
    const myFill = fills.get(orderId);
    const remainUsdt = BigInt(latest?.input_usdt_units || '0');
    const remainA = BigInt(latest?.input_a_units || '0');
    const isFilled = latest?.status === 'FILLED';

    const base = {
      ok: true, orderId, orderType, side,
      orderStatus: isFilled ? 'FILLED' : 'OPEN',
      priceUsdt: formatUnits(BigInt(latest?.order_price_usdt_units || limitPriceRaw), USDT_DECIMALS),
      lockedUsdt: formatUnits(remainUsdt, USDT_DECIMALS),
      lockedA: formatUnits(remainA, A_TOKEN_DECIMALS),
      createdAt: now0,
    };

    if (!myFill) return base;

    if (side === 'buy') {
      return {
        ...base,
        usdtPaid: myFill.usdtPaid,
        aReceived: myFill.aReceived,
        avgPrice: myFill.avgPrice || null,
        partialFilled: !isFilled && myFill.count > 0,
      };
    }
    return {
      ...base,
      aSold: myFill.aSold,
      usdtReceived: myFill.usdtReceived,
      feeA: myFill.feeA,
      avgPrice: myFill.avgPrice || null,
      partialFilled: !isFilled && myFill.count > 0,
    };
  }

  // ─────────────────────────────────────────────────────────────
  //  撮合引擎：交叉撮合所有 OPEN 订单（买卖互为对手方）
  //  fills: Map<orderId, fillDetail> 用于把本次撮合明细回传给下单者
  // ─────────────────────────────────────────────────────────────
  function _matchPass(fills = new Map()) {
    const currentPrice = at.getPriceUsdtUnits();
    if (currentPrice <= 0n) return { matched: 0, skipped: 0, errors: [] };

    let openRows = db.listATokenOpenOrders();
    const errors = [];
    let matchedCount = 0;
    let skipped = 0;
    let guard = 0;

    // 灰尘单清理：剩余量已小到无法再成交任何有效单位（列表里显示 0），
    // 原路退回冻结并关闭订单（CANCELLED），避免永远"挂单中"并每轮产生 0 数量的成交记录。
    for (const r of openRows) {
      try {
        if (String(r.status || '') !== 'OPEN') continue;
        const isBuy = String(r.side) === 'buy';
        const rem = BigInt((isBuy ? r.input_usdt_units : r.input_a_units) || '0');
        if (rem > 0n && rem >= (isBuy ? DUST_USDT : DUST_A)) continue;
        _refundLocked(r);
        const t = clock();
        db.markATokenOrderCancelled(r.id, { cancelledAt: t, updatedAt: t, reason: 'dust_cleanup' });
        r.status = 'CANCELLED';
      } catch {}
    }

    // 市价单转委托后，委托价跟随当前币价刷新（限价单保持用户指定价不变）
    {
      const nowM = clock();
      for (const r of openRows) {
        if (String(r.status) !== 'OPEN' || String(r.order_type) !== 'market') continue;
        if (BigInt(r.order_price_usdt_units || '0') === currentPrice) continue;
        db.updateATokenOrderMarketPrice(r.id, { priceUsdtUnits: currentPrice.toString(), updatedAt: nowM });
        r.order_price_usdt_units = currentPrice.toString();
      }
    }

    while (guard++ < 200) {
      openRows = openRows.filter(r => r.status === 'OPEN'
        && BigInt(r.input_usdt_units || '0') >= 0n
        && BigInt(r.input_a_units || '0') >= 0n);

      // 卖单侧的小额轮：每 SMALL_FIRST_WINDOW 次尝试中有 SMALL_FIRST_COUNT 次
      const smallFirst = smallFirstAt(++matchAttemptSeq, SMALL_FIRST_WINDOW, SMALL_FIRST_COUNT);
      const cmpAmt = (x, y) => (x < y ? -1 : x > y ? 1 : 0);
      const byTime = (a, b) => Number(a.created_at) - Number(b.created_at);

      // 买单：同价档内始终「小额优先」（金额小者先成交，2026-10-23 用户确认：AIX 优先卖给小额订单），
      //       同金额再按挂单时间
      const buys = openRows.filter(r => String(r.side) === 'buy' && BigInt(r.input_usdt_units || '0') > 0n)
        .sort((a, b) => {
          const pb = BigInt(b.order_price_usdt_units) - BigInt(a.order_price_usdt_units); // 价高优先
          if (pb !== 0n) return pb > 0n ? 1 : -1;
          const c = cmpAmt(BigInt(a.input_usdt_units || '0'), BigInt(b.input_usdt_units || '0'));
          return c !== 0 ? c : byTime(a, b);
        });
      // 卖单：同价档内默认轮按挂单时间先来先成交（不按金额插队）；
      //       小额轮按金额小者优先（小卖单优先配小买单）
      const sells = openRows.filter(r => String(r.side) === 'sell' && BigInt(r.input_a_units || '0') > 0n)
        .sort((a, b) => {
          const ps = BigInt(a.order_price_usdt_units) - BigInt(b.order_price_usdt_units); // 价低优先
          if (ps !== 0n) return ps > 0n ? 1 : -1;
          if (!smallFirst) return byTime(a, b);
          const c = cmpAmt(BigInt(a.input_a_units || '0'), BigInt(b.input_a_units || '0'));
          return c !== 0 ? c : byTime(a, b);
        });

      // 本轮找到第一对可成交组合
      let pair = null;
      outer:
      for (const s of sells) {
        const sPrice = BigInt(s.order_price_usdt_units);
        for (const b of buys) {
          const bWallet = String(b.wallet).toLowerCase();
          const sWallet = String(s.wallet).toLowerCase();
          if (bWallet === sWallet) continue;                       // 防自成交
          const bPrice = BigInt(b.order_price_usdt_units);
          if (bPrice < sPrice) break outer;                        // 买价不够高，后面更贵
          const touchedByMarket = sPrice <= currentPrice || bPrice >= currentPrice;
          if (!touchedByMarket) continue;
          pair = [b, s];
          break outer;
        }
      }
      if (!pair) break;

      try {
        const done = _settleMatch(pair[0], pair[1], currentPrice, fills);
        if (done) matchedCount += 1; else skipped += 1;
      } catch (err) {
        skipped += 1;
        errors.push(`撮合 pair 失败（跳过）：${err?.message || String(err)}`);
        break;                                                     // 防御异常死循环
      }
    }

    return { matched: matchedCount, skipped, errors, trades: Array.from(fills.keys()).length };
  }

  // ─────────────────────────────────────────────────────────────
  //  执行一对买卖的成交（支持部分成交）
  //  判定已在 _matchPass 完成：bPrice >= sPrice 且受市场价格驱动
  // ─────────────────────────────────────────────────────────────
  function _settleMatch(buyRaw, sellRaw, currentPrice, fills) {
    const now = clock();
    const bRemainUsdt = BigInt(buyRaw.input_usdt_units || '0');
    const sRemainA = BigInt(sellRaw.input_a_units || '0');
    if (bRemainUsdt <= 0n || sRemainA <= 0n) return false;

    const bWallet = String(buyRaw.wallet || '').toLowerCase();
    const sWallet = String(sellRaw.wallet || '').toLowerCase();
    if (!bWallet || !sWallet || bWallet === sWallet) return false;

    // 成交价 = 先挂一方的限价（maker 定价）
    const execPrice = Number(buyRaw.created_at) <= Number(sellRaw.created_at)
      ? BigInt(buyRaw.order_price_usdt_units)
      : BigInt(sellRaw.order_price_usdt_units);
    if (execPrice <= 0n) return false;

    // 卖方手续费费率（挂单时快照）：手续费 = 消耗投入 × 费率，净额 = 消耗投入 − 手续费
    let payload = {};
    try { payload = JSON.parse(sellRaw.payload_json || '{}') || {}; } catch {}
    const feeBps = BigInt(payload.feeRateBps || Number(FEE_RATE_BPS_DEFAULT));
    const netDiv = BPS - feeBps;                 // 净额占消耗投入的比例 = 1 − 费率

    // 本次成交数量：受买方剩余 USDT 与卖方剩余投入（冻结额 × 净额占比）双重约束
    let aFill = at.usdtToA(bRemainUsdt, execPrice);
    const aFillCap = sRemainA * netDiv / BPS;
    if (aFill > aFillCap) aFill = aFillCap;
    if (aFill <= 0n) return false;

    let usdtFill = at.aToUsdt(aFill, execPrice);
    if (usdtFill <= 0n) return false;
    if (usdtFill > bRemainUsdt) {
      // 反向换算产生的边界误差：按买方实际剩余收紧
      aFill = at.usdtToA(bRemainUsdt, execPrice);
      usdtFill = at.aToUsdt(aFill, execPrice);
      if (usdtFill <= 0n || usdtFill > bRemainUsdt) return false;
    }

    // 卖单投入扣减 = 净额折算回含费口径：消耗 = 净额 ÷ (1 − 费率)
    let sellConsume = aFill * BPS / netDiv;
    let sellRemainAfter = sRemainA - sellConsume;
    // 保守兜底：若因舍入导致卖方剩余透支，则缩减本次成交
    if (sellRemainAfter < 0n) {
      aFill = aFill + sellRemainAfter;              // 回退透支量（净额层面近似修正）
      if (aFill <= 0n) return false;
      usdtFill = at.aToUsdt(aFill, execPrice);
      if (usdtFill <= 0n || usdtFill > bRemainUsdt) return false;
      sellConsume = aFill * BPS / netDiv;
    }
    const feeFinal = sellConsume - aFill;           // 手续费 = 消耗投入 × 费率
    // 手续费去向（固定规则，不受销毁开关影响）：50% 销毁 + 50% 进 A10 团队分红池
    // 销毁开关（burnEnabled）只控制「每日固定补足销毁」
    const burnFinal = feeFinal / 2n;                // 销毁 = 手续费 50%
    const a10Final  = feeFinal - burnFinal;          // A10 池 = 手续费 50%
    const sellAfterFinal = sRemainA - sellConsume;

    // 买方剩余扣减
    const buyRemainAfter = bRemainUsdt - usdtFill;

    const groupId = makeId('amt');

    // 1) 买家收 A（冻结的 USDT 直接核销给卖家）
    at.creditA(bWallet, aFill);
    // 2) 卖家收 USDT（其冻结的 A 中净额部分转移给买家）
    at.creditUsdt(sWallet, usdtFill);
    // 3) 手续费划扣：50% 销毁
    if (burnFinal > 0n) at.burn(burnFinal, 'p2p_match', 'P2P 卖方手续费销毁');
    // 4) A10 池：手续费 50% 进池（日结均分 A10 用户）
    if (a10Final > 0n) {
      try { teamService?.distributeToA10Pool(a10Final, groupId, Date.now()); } catch {}
    }
    // 5) 成交量统计
    at.addVolume(aFill, usdtFill);

    // 写双方成交记录（各自视角）
    const priceStr = formatUnits(execPrice, USDT_DECIMALS);
    db.insertATokenTradeRow({
      id: makeId('att'), wallet: bWallet, side: 'buy',
      priceUsdtUnits: execPrice.toString(),
      sizeUnits: aFill.toString(),
      amountUsdtUnits: usdtFill.toString(),
      feeUnits: '0', burnUnits: '0', dividendUnits: '0',
      createdAt: now,
      payload: { source: 'p2p_match', matchGroupId: groupId, orderId: buyRaw.id, counterOrderId: sellRaw.id, priceUsdt: priceStr },
    });
    db.insertATokenTradeRow({
      id: makeId('att'), wallet: sWallet, side: 'sell',
      priceUsdtUnits: execPrice.toString(),
      sizeUnits: aFill.toString(),
      amountUsdtUnits: usdtFill.toString(),
      feeUnits: feeFinal.toString(),
      burnUnits: burnFinal.toString(),
      dividendUnits: a10Final.toString(),
      createdAt: now,
      payload: { source: 'p2p_match', matchGroupId: groupId, orderId: sellRaw.id, counterOrderId: buyRaw.id, priceUsdt: priceStr },
    });

    // 更新两张订单的剩余冻结额度；剩余量低于灰尘阈值即视为该单已完成（尾差原路退回），
    // 否则最后一点点尾差会留成"挂单中"，下一轮被灰尘清理误标记为「已撤单」
    const buyDone = buyRemainAfter < DUST_USDT;
    const sellDone = sellAfterFinal < DUST_A;
    db.updateATokenOrderInputs(buyRaw.id, {
      inputUsdtUnits: buyDone ? '0' : buyRemainAfter.toString(),
      inputAUnits: '0', updatedAt: now,
    });
    db.updateATokenOrderInputs(sellRaw.id, {
      inputUsdtUnits: '0',
      inputAUnits: sellDone ? '0' : sellAfterFinal.toString(),
      updatedAt: now,
    });
    if (buyDone) {
      if (buyRemainAfter > 0n) at.creditUsdt(bWallet, buyRemainAfter);   // 尾差（灰尘）原路退回
      db.markATokenOrderFilled(buyRaw.id, {
        fillPriceUsdtUnits: execPrice.toString(), fillTradeId: groupId, filledAt: now, updatedAt: now,
      });
    }
    if (sellDone) {
      if (sellAfterFinal > 0n) at.creditA(sWallet, sellAfterFinal);       // 尾差（灰尘）原路退回
      db.markATokenOrderFilled(sellRaw.id, {
        fillPriceUsdtUnits: execPrice.toString(), fillTradeId: groupId, filledAt: now, updatedAt: now,
      });
    }

    // 内存行同步（供本轮继续撮合 & 成交明细回传）
    buyRaw.status = buyDone ? 'FILLED' : 'OPEN';
    buyRaw.input_usdt_units = buyDone ? '0' : buyRemainAfter.toString();
    sellRaw.status = sellDone ? 'FILLED' : 'OPEN';
    sellRaw.input_a_units = sellDone ? '0' : sellAfterFinal.toString();

    // 下单响应明细累计
    const fmtU = u => formatUnits(u, USDT_DECIMALS);
    const fmtA2 = u => formatUnits(u, A_TOKEN_DECIMALS);
    // 累计用 BigInt 求和后再格式化：展示字段是带小数的字符串，若回读 BigInt('12.5') 会抛错
    // 并导致整轮撮合被 break 中断，故一律只对 sumUnits / sumUsdt / sumFee 等 BigInt 累加。
    const accBuy = fills.get(buyRaw.id) || {
      aReceived: '0', usdtPaid: '0', count: 0, sumUnits: 0n, sumUsdt: 0n,
    };
    accBuy.sumUnits += aFill; accBuy.sumUsdt += usdtFill; accBuy.count += 1;
    accBuy.aReceived = fmtA2(accBuy.sumUnits);
    accBuy.usdtPaid = fmtU(accBuy.sumUsdt);
    accBuy.avgPrice = accBuy.sumUnits > 0n ? fmtU(accBuy.sumUsdt * 1_000000000000000000n / accBuy.sumUnits, USDT_DECIMALS) : null;
    fills.set(buyRaw.id, accBuy);

    const accSell = fills.get(sellRaw.id) || {
      aSold: '0', usdtReceived: '0', feeA: '0', count: 0, sumUnits: 0n, sumUsdt: 0n, sumFee: 0n,
    };
    accSell.sumUnits += aFill; accSell.sumUsdt += usdtFill; accSell.sumFee += feeFinal; accSell.count += 1;
    accSell.aSold = fmtA2(accSell.sumUnits);
    accSell.usdtReceived = fmtU(accSell.sumUsdt);
    accSell.feeA = fmtA2(accSell.sumFee || 0n);
    accSell.avgPrice = accSell.sumUnits > 0n ? fmtU(accSell.sumUsdt * 1_000000000000000000n / accSell.sumUnits, USDT_DECIMALS) : null;
    fills.set(sellRaw.id, accSell);

    return true;
  }

  // ─────────────────────────────────────────────────────────────
  //  公开撮合入口（K线 tick / 管理后台手动触发）
  // ─────────────────────────────────────────────────────────────
  function matchOpenOrders() {
    return _matchPass(new Map());
  }

  // ─────────────────────────────────────────────────────────────
  //  我的冻结：OPEN 委托占用中的 USDT / A（资产条展示「可用 + 冻结中」）
  // ─────────────────────────────────────────────────────────────
  function myLocks(wallet) {
    const locks = db.sumATokenLockedByWallet(String(wallet || '').toLowerCase());
    return {
      usdt: formatUnits(BigInt(locks.usdtUnits), USDT_DECIMALS),
      a: formatUnits(BigInt(locks.aUnits), A_TOKEN_DECIMALS),
    };
  }

  // ─────────────────────────────────────────────────────────────
  //  委托簿深度：求购总额（顶部「委托求购额度」展示数据源）
  // ─────────────────────────────────────────────────────────────
  function depth() {
    let openBuyUsdtUnits = 0n;
    let openBuyCount = 0n;
    let openSellANet = 0n;
    let openSellCount = 0n;
    try {
      for (const r of db.listATokenOpenOrders()) {
        if (String(r.side) === 'buy') {
          const u = BigInt(r.input_usdt_units || '0');
          if (u > 0n) { openBuyUsdtUnits += u; openBuyCount += 1n; }
        } else {
          const net = _sellNetA(r);
          if (net > 0n) { openSellANet += net; openSellCount += 1n; }
        }
      }
    } catch {}
    return {
      openBuyUsdt: formatUnits(openBuyUsdtUnits, USDT_DECIMALS),
      openBuyCount: Number(openBuyCount),
      openSellCount: Number(openSellCount),
      openSellA: formatUnits(openSellANet, A_TOKEN_DECIMALS),
    };
  }

  // 卖单可成交给买家的净 A（冻结额按该单手续费率折算：净额 = 冻结 × (1 − 费率)）
  function _sellNetA(row) {
    const frozen = BigInt(row.input_a_units || '0');
    if (frozen <= 0n) return 0n;
    let feeBps = FEE_RATE_BPS_DEFAULT;
    try {
      const p = JSON.parse(row.payload_json || '{}') || {};
      if (p.feeRateBps != null) feeBps = BigInt(p.feeRateBps);
    } catch {}
    return frozen * (BPS - feeBps) / BPS;
  }

  // ─────────────────────────────────────────────────────────────
  //  真实 P2P 盘口：按价位聚合（同价同向合并为一档，不含地址）
  //   bids 价高在前 / asks 价低在前；每档附带 top（金额降序前 5 笔明细）
  // ─────────────────────────────────────────────────────────────
  function orderbook({ limit = 20 } = {}) {
    // 按价位聚合：同价同向委托合并为一档；每档附带 top：按金额降序的前 5 笔明细（前端展开显示）
    const bidMap = new Map();   // price -> { price, a, usdt, top: [] }
    const askMap = new Map();
    try {
      for (const r of db.listATokenOpenOrders()) {
        if (String(r.status) !== 'OPEN') continue;
        const price = BigInt(r.order_price_usdt_units || '0');
        if (price <= 0n) continue;
        if (String(r.side) === 'buy') {
          const u = BigInt(r.input_usdt_units || '0');
          if (u <= 0n) continue;
          const row = bidMap.get(price) || { price, a: 0n, usdt: 0n, top: [] };
          const a = at.usdtToA(u, price);
          row.a += a;
          row.usdt += u;
          row.top.push({ a, usdt: u });
          bidMap.set(price, row);
        } else if (String(r.side) === 'sell') {
          const netA = _sellNetA(r);
          if (netA <= 0n) continue;
          const u = at.aToUsdt(netA, price);
          const row = askMap.get(price) || { price, a: 0n, usdt: 0n, top: [] };
          row.a += netA;
          row.usdt += u;
          row.top.push({ a: netA, usdt: u });
          askMap.set(price, row);
        }
      }
    } catch {}
    const bidRows = [...bidMap.values()];
    const askRows = [...askMap.values()];

    const fmtRow = r => ({
      price: formatUnits(r.price, USDT_DECIMALS),
      size: formatUnits(r.a, A_TOKEN_DECIMALS),
      usdt: formatUnits(r.usdt, USDT_DECIMALS),
      count: (r.top || []).length,
      top: (r.top || [])
        .sort((x, y) => (y.usdt > x.usdt ? 1 : y.usdt < x.usdt ? -1 : 0))
        .slice(0, 5)
        .map(t => ({ size: formatUnits(t.a, A_TOKEN_DECIMALS), usdt: formatUnits(t.usdt, USDT_DECIMALS) })),
    });
    // bids 价高在前；asks 价低在前（最优报价在前；JS sort 稳定，同价保持提交先后）
    const byPriceDesc = (x, y) => x.price > y.price ? -1 : x.price < y.price ? 1 : 0;
    const byPriceAsc  = (x, y) => x.price > y.price ? 1 : x.price < y.price ? -1 : 0;
    bidRows.sort(byPriceDesc);
    askRows.sort(byPriceAsc);
    const bids = bidRows.slice(0, limit).map(fmtRow);
    const asks = askRows.slice(0, limit).map(fmtRow);
    return {
      bids, asks,
      bestBid: bids[0]?.price || null,
      bestAsk: asks[0]?.price || null,
      markPrice: formatUnits(at.getPriceUsdtUnits(), USDT_DECIMALS),
    };
  }

  // ─────────────────────────────────────────────────────────────
  //  挂单明细：逐笔列出当前 OPEN 委托（不包含钱包地址，公开可看）
  //  买单展示：挂单价 / 委托 USDT 金额 / 按挂单价可买 AIX 数量
  //  卖单展示：挂单价 / 委托卖出 AIX 数量（含费冻结额）/ 可成交净 A / 折合 USDT
  // ─────────────────────────────────────────────────────────────
  function openOrders({ limit = 50 } = {}) {
    const rows = [];
    // 挂单中的市价单「委托价跟随现价」：展示用当前币价，不依赖撮合轮刷新（限价单用用户指定价）
    const livePrice = at.getPriceUsdtUnits();
    try {
      for (const r of db.listATokenOpenOrders()) {
        if (String(r.status) !== 'OPEN') continue;
        const isMarket = String(r.order_type || 'market') === 'market';
        const price = isMarket && livePrice > 0n ? livePrice : BigInt(r.order_price_usdt_units || '0');
        if (price <= 0n) continue;
        const isBuy = String(r.side) === 'buy';
        if (isBuy) {
          const remainUsdt = BigInt(r.input_usdt_units || '0');
          if (remainUsdt <= 0n) continue;
          rows.push({
            side:'buy',
            orderType:String(r.order_type || 'market'),
            priceUsdt:formatUnits(price, USDT_DECIMALS),
            amountUsdt:formatUnits(remainUsdt, USDT_DECIMALS),
            sizeA:formatUnits(at.usdtToA(remainUsdt, price), A_TOKEN_DECIMALS),
            createdAt:Number(r.created_at),
          });
        } else {
          const remainA = BigInt(r.input_a_units || '0');
          if (remainA <= 0n) continue;
          const netA = _sellNetA(r);
          rows.push({
            side:'sell',
            orderType:String(r.order_type || 'market'),
            priceUsdt:formatUnits(price, USDT_DECIMALS),
            sizeA:formatUnits(remainA, A_TOKEN_DECIMALS),
            netA:formatUnits(netA, A_TOKEN_DECIMALS),
            amountUsdt:formatUnits(at.aToUsdt(netA, price), USDT_DECIMALS),
            createdAt:Number(r.created_at),
          });
        }
      }
    } catch {}
    // 买盘价高在前、卖盘价低在前；同价新单在前
    rows.sort((a, b) => {
      if (a.side !== b.side) return a.side === 'buy' ? -1 : 1;
      if (a.priceUsdt !== b.priceUsdt) {
        const cmp = Number(a.priceUsdt) - Number(b.priceUsdt);
        return a.side === 'buy' ? -cmp : cmp;
      }
      return b.createdAt - a.createdAt;
    });
    return {
      count:rows.length,
      buys:rows.filter(r => r.side === 'buy').slice(0, limit),
      sells:rows.filter(r => r.side === 'sell').slice(0, limit),
    };
  }

  // ─────────────────────────────────────────────────────────────
  //  撤单：OPEN 订单 → 冻结原路退回 + 状态改 CANCELLED
  // ─────────────────────────────────────────────────────────────
  function cancelOrder({ wallet, orderId, reason = 'user_cancelled' }) {
    wallet = String(wallet || '').toLowerCase();
    if (!wallet) throw new Error('钱包地址必填');
    const order = db.getATokenOrder(String(orderId));
    if (!order) throw new Error('订单不存在');
    if (String(order.wallet || '').toLowerCase() !== wallet) throw new Error('非本人订单，无法撤单');
    if (order.status !== 'OPEN') throw new Error(`订单状态为 ${order.status}，仅 OPEN 状态可撤单`);

    const now = clock();
    _refundLocked(order);
    const info = db.markATokenOrderCancelled(order.id, { cancelledAt: now, updatedAt: now, reason });
    if (!info.changes) throw new Error('撤单失败，订单可能已成交/撤单');
    return {
      ok: true, orderId: order.id, orderStatus: 'CANCELLED',
      refundUsdt: order.input_usdt_units ? formatUnits(BigInt(order.input_usdt_units), USDT_DECIMALS) : '0',
      refundA: order.input_a_units ? formatUnits(BigInt(order.input_a_units), A_TOKEN_DECIMALS) : '0',
      cancelledAt: now,
    };
  }

  // ─────────────────────────────────────────────────────────────
  //  我的委托列表
  // ─────────────────────────────────────────────────────────────
  function myOrders({ wallet, limit = 100 }) {
    wallet = String(wallet || '').toLowerCase();
    if (!wallet) return [];
    // 一次拉取该钱包成交流水，按 orderId 聚合累计成交量。
    // 订单表 input_a_units/input_usdt_units 是“剩余冻结量”，成交后归零，不能当作委托/成交数量展示
    const fillAgg = new Map();
    try {
      for (const t of db.listATokenTradesByWallet(wallet, 5000)) {
        const oid = String(t.payload?.orderId || '');
        if (!oid) continue;
        const cur = fillAgg.get(oid) || { a: 0n, usdt: 0n };
        cur.a += BigInt(t.sizeUnits || '0');
        cur.usdt += BigInt(t.amountUsdtUnits || '0');
        fillAgg.set(oid, cur);
      }
    } catch {}
    return db.listATokenOrdersByWallet(wallet, limit)
      .map(r => mapOrderToReadable(r, fillAgg.get(r.id)));
  }

  // ─────────────────────────────────────────────────────────────
  //  小工具：DB 行 → 人类可读字段
  // ─────────────────────────────────────────────────────────────
  function mapOrderToReadable(r, agg = null) {
    // 挂单中（OPEN）的市价单「委托价跟随现价」：直接按当前币价展示，
    // 不依赖撮合轮刷新（撮合由 K 线 tick 驱动，manual 模式下不会跑）。
    // 限价单保持用户指定价；已结束（FILLED/CANCELLED）的市价单保留历史价。
    const liveMarketPrice = String(r.status) === 'OPEN' && String(r.order_type) === 'market'
      ? at.getPriceUsdtUnits() : 0n;
    return {
      orderId: r.id,
      wallet: r.wallet,
      side: r.side,
      orderType: r.order_type,
      orderStatus: r.status,
      orderPriceUsdt: liveMarketPrice > 0n
        ? formatUnits(liveMarketPrice, USDT_DECIMALS)
        : (r.order_price_usdt_units ? formatUnits(BigInt(r.order_price_usdt_units), USDT_DECIMALS) : null),
      inputUsdt: formatUnits(BigInt(r.input_usdt_units || '0'), USDT_DECIMALS),
      inputA: formatUnits(BigInt(r.input_a_units || '0'), A_TOKEN_DECIMALS),
      // 累计成交量（多次部分成交聚合）；FILLED 订单的委托量应看这里，input* 已归零
      filledA: formatUnits(BigInt(agg?.a || 0n), A_TOKEN_DECIMALS),
      filledUsdt: formatUnits(BigInt(agg?.usdt || 0n), USDT_DECIMALS),
      fillPriceUsdt: r.fill_price_usdt_units ? formatUnits(BigInt(r.fill_price_usdt_units), USDT_DECIMALS) : null,
      tradeId: r.fill_trade_id || null,
      createdAt: Number(r.created_at),
      updatedAt: Number(r.updated_at),
      filledAt: r.filled_at ? Number(r.filled_at) : null,
      cancelledAt: r.cancelled_at ? Number(r.cancelled_at) : null,
      cancelReason: r.cancel_reason || null,
    };
  }

  function stats() {
    return {
      openOrders: db.countATokenOrdersByStatus('OPEN'),
      filledOrders: db.countATokenOrdersByStatus('FILLED'),
      cancelledOrders: db.countATokenOrdersByStatus('CANCELLED'),
    };
  }

  // 卖出手续费档案：后台覆盖优先，其次阶梯费率 + 激活矿机的直推人数（供报价/前端展示）
  function sellFeeProfile(wallet) {
    const directCount = minerDirectCountOf(wallet);
    const fee = feeOverrideBpsOf(wallet) ?? feeBpsByDirectCount(directCount);
    return { feeRateBps: Number(fee), feePct: (Number(fee) / 100).toFixed(0) + '%', directCount };
  }

  // 可卖额度（2026-10-25）：只有质押释放的产出可以卖；挂单占用、撤单返还
  function sellQuota(wallet) {
    const q = db.getATokenSellQuota(String(wallet || '').toLowerCase());
    const released = BigInt(q.releasedUnits);
    const used = BigInt(q.usedUnits);
    const available = released > used ? released - used : 0n;
    return {
      released: formatUnits(released, A_TOKEN_DECIMALS),
      used: formatUnits(used, A_TOKEN_DECIMALS),
      available: formatUnits(available, A_TOKEN_DECIMALS),
      releasedUnits: released.toString(),
      usedUnits: used.toString(),
      availableUnits: available.toString(),
    };
  }

  return {
    placeOrder, cancelOrder, myOrders,
    quoteLimitOrder, matchOpenOrders, orderbook, openOrders, depth, stats, myLocks, sellFeeProfile, sellQuota,
  };
}
