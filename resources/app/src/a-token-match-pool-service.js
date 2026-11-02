import crypto from 'node:crypto';
import { formatUnits } from 'ethers';
import { A_TOKEN_DECIMALS, USDT_DECIMALS } from './a-token-service.js';

// ─────────────────────────────────────────────────────────────
// AIX 匹配池（2026-10-31）
//
// 规则（用户已确认）：
//   · 质押产出 = 匹配额度（原可卖额度账本），匹配额度不能直接挂卖；
//   · 涡轮额度 = USDT 按 AIX 实时价格折算购买（1 USDT 买等值 AIX 的涡轮额度）；
//   · 进池必须 1:1 配比（匹配额度 : 涡轮额度），出池 = 两者相加 → 可用额度；
//   · 锁定时长：首次使用匹配池后开始计时，每过一天新放入的锁定时长 +24h
//     （第1天 24h、第2天 48h …… 第30天起封顶 720h），无论是否使用每日都递增；
//   · 到期后 AIX（可用额度）发放到资产账户，卖出只消耗可用额度。
//
// 资金口径：
//   · 购买涡轮额度的 USDT 从用户站内 USDT 账本扣除，转入平台归集地址（TURBO_COLLECT_WALLET）；
//   · 匹配/涡轮/可用均为额度账本（非代币），到期只发放可卖权限，AIX 代币本身不动。
// ─────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const MAX_DURATION_HOURS = 720;                 // 封顶 720 小时（第 30 天起）
const MIN_TURBO_USDT = 10n ** BigInt(USDT_DECIMALS); // 单次最少购买 1 USDT
const A_UNIT = 10n ** BigInt(A_TOKEN_DECIMALS);
// 涡轮额度 USDT 归集地址：仅平台收款记账，不属任何真实用户。
const TURBO_COLLECT_WALLET = '0x0000000000000000000000000000000000007db0';

const makeId = prefix => `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
const fmtA = units => { try { return formatUnits(BigInt(units || '0'), A_TOKEN_DECIMALS); } catch { return '0'; } };
const fmtU = units => { try { return formatUnits(BigInt(units || '0'), USDT_DECIMALS); } catch { return '0'; } };

export function createATokenMatchPoolService({ aTokenService, database, clock = () => Date.now() }) {
  const at = aTokenService;
  const db = database;

  // 锁定时长（小时）：首次使用起每过一天 +24h，封顶 720h
  // 2026-11-03 修正：按「北京时间自然日」计第几天（首次使用当天=第 1 天，跨日即第 2 天），
  // 不再用「满 24 小时」滚动窗口 — 否则首次使用 23 小时后再次进池仍按 24h 计算。
  const DAY_TZ_OFFSET_MS = 8 * 60 * 60 * 1000;
  const dayIndexOf = (firstAt, now) => {
    const day = t => Math.floor((Number(t) + DAY_TZ_OFFSET_MS) / DAY_MS);
    return Math.max(1, day(now) - day(firstAt) + 1);
  };
  function durationHoursFor(firstPoolAt, now = clock()) {
    const first = Number(firstPoolAt) || 0;
    if (first <= 0) return 24;
    const dayIndex = dayIndexOf(first, now);
    return Math.min(dayIndex * 24, MAX_DURATION_HOURS);
  }

  // ── 涡轮额度报价：USDT → 等值 AIX 涡轮额度（按实时价）──
  function quoteTurbo(usdtAmount) {
    const usdt = at.parseUsdt(usdtAmount, '购买 USDT 数量');
    if (usdt < MIN_TURBO_USDT) throw new Error(`单次最少购买 ${fmtU(MIN_TURBO_USDT)} USDT 的涡轮额度`);
    const price = at.getPriceUsdtUnits();
    if (price <= 0n) throw new Error('当前价格无效，暂不能购买');
    const turbo = at.usdtToA(usdt, price);
    if (turbo <= 0n) throw new Error('购买数量过小，请增加 USDT 数量');
    return {
      usdtIn: fmtU(usdt),
      turboOut: fmtA(turbo),
      priceUsdt: fmtU(price),
      hint: `按实时价 $${fmtU(price)}：${fmtU(usdt)} USDT ≈ ${fmtA(turbo)} AIX 涡轮额度`,
    };
  }

  // ── 购买涡轮额度：扣站内 USDT → 平台归集地址，涡轮额度入账 ──
  // requestId 幂等：同一请求重复提交直接返回首次结果，不重复扣款
  function buyTurbo({ wallet, usdtAmount, requestId }) {
    wallet = String(wallet || '').toLowerCase();
    const reqId = String(requestId || '').trim();
    if (reqId) {
      const dup = db.getATokenTurboPurchase(wallet, reqId);
      if (dup) {
        return {
          usdtIn: fmtU(dup.usdtUnits), turboOut: fmtA(dup.turboUnits), priceUsdt: fmtU(dup.priceUnits),
          turboBalance: fmtA(db.getATokenTurboQuota(wallet).units), purchaseId: dup.id, idempotent: true,
        };
      }
    }
    const usdt = at.parseUsdt(usdtAmount, '购买 USDT 数量');
    if (usdt < MIN_TURBO_USDT) throw new Error(`单次最少购买 ${fmtU(MIN_TURBO_USDT)} USDT 的涡轮额度`);
    if (at.balanceUsdt(wallet) < usdt) throw new Error('USDT 可用余额不足');
    const price = at.getPriceUsdtUnits();
    if (price <= 0n) throw new Error('当前价格无效，暂不能购买');
    const turbo = at.usdtToA(usdt, price);
    if (turbo <= 0n) throw new Error('购买数量过小，请增加 USDT 数量');
    at.debitUsdt(wallet, usdt);
    try { at.creditUsdt(TURBO_COLLECT_WALLET, usdt); }
    catch (e) {
      try { at.creditUsdt(wallet, usdt); } catch (e2) { console.error(`[匹配池] ${wallet} 购买涡轮退款失败，需人工处理:`, e2?.message || e2); }
      throw e;
    }
    const purchaseId = makeId('atp');
    if (reqId) {
      const inserted = db.insertATokenTurboPurchase({
        id: purchaseId, wallet, requestId: reqId,
        usdtUnits: usdt.toString(), turboUnits: turbo.toString(), priceUnits: price.toString(),
        createdAt: clock(),
      });
      if (!inserted) {   // 并发下另一请求已入库：回吐刚扣的 USDT，按首次结果返回
        try { at.debitUsdt(TURBO_COLLECT_WALLET, usdt); at.creditUsdt(wallet, usdt); }
        catch (e) { console.error(`[匹配池] ${wallet} 重复购买回吐失败，需人工处理:`, e?.message || e); }
        const dup = db.getATokenTurboPurchase(wallet, reqId);
        if (dup) {
          return {
            usdtIn: fmtU(dup.usdtUnits), turboOut: fmtA(dup.turboUnits), priceUsdt: fmtU(dup.priceUnits),
            turboBalance: fmtA(db.getATokenTurboQuota(wallet).units), purchaseId: dup.id, idempotent: true,
          };
        }
        throw new Error('购买请求冲突，请稍后重试');
      }
    }
    db.addATokenTurboQuota(wallet, turbo);
    // 2026-11-02 一键购买涡轮额度也累计进交易大厅 24h 成交量（AIX 量 + USDT 额）
    try { at.addVolume(turbo, usdt); }
    catch (e) { console.error(`[匹配池] ${wallet} 一键购买成交量累加失败:`, e?.message || e); }
    return {
      usdtIn: fmtU(usdt),
      turboOut: fmtA(turbo),
      priceUsdt: fmtU(price),
      turboBalance: fmtA(db.getATokenTurboQuota(wallet).units),
      purchaseId,
    };
  }

  // ── 按 AIX 数量反推 USDT 成本（向上取整到 0.000001 USDT，平台不吃小数亏）──
  function costForA(aixAmount) {
    const a = at.parseA(aixAmount, '购买 AIX 数量');
    if (a <= 0n) throw new Error('购买数量必须大于 0');
    const price = at.getPriceUsdtUnits();
    if (price <= 0n) throw new Error('当前价格无效，暂不能购买');
    const usdt = (a * price + A_UNIT - 1n) / A_UNIT;
    if (usdt < MIN_TURBO_USDT) {
      throw new Error(`按实时价折算最少购买约 ${fmtA(at.usdtToA(MIN_TURBO_USDT, price))} AIX（≈${fmtU(MIN_TURBO_USDT)} USDT）`);
    }
    return { a, usdt, price, aixStr: fmtA(a), usdtStr: fmtU(usdt), priceStr: fmtU(price) };
  }

  // ── 涡轮额度报价：AIX 数量 → 应付 USDT（按实时价）──
  function quoteTurboByA(aixAmount) {
    const c = costForA(aixAmount);
    return {
      aixIn: c.aixStr,
      usdtOut: c.usdtStr,
      priceUsdt: c.priceStr,
      hint: `按实时价 $${c.priceStr}：${c.aixStr} AIX 涡轮额度 ≈ 支付 ${c.usdtStr} USDT`,
    };
  }

  // ── 按 AIX 数量购买涡轮额度：扣站内 USDT（签名时锁定金额）→ 平台归集地址，涡轮额度精确入账 ──
  // requestId 幂等：同一请求重复提交直接返回首次结果，不重复扣款
  function buyTurboByA({ wallet, aixAmount, usdtUnits, requestId }) {
    wallet = String(wallet || '').toLowerCase();
    const reqId = String(requestId || '').trim();
    if (reqId) {
      const dup = db.getATokenTurboPurchase(wallet, reqId);
      if (dup) {
        return {
          aixIn: fmtA(dup.turboUnits), usdtIn: fmtU(dup.usdtUnits), turboOut: fmtA(dup.turboUnits),
          priceUsdt: fmtU(dup.priceUnits),
          turboBalance: fmtA(db.getATokenTurboQuota(wallet).units), purchaseId: dup.id, idempotent: true,
        };
      }
    }
    const c = costForA(aixAmount);
    // 签名消息里锁定的金额必须与本次实时计算一致（报价到签名之间价格跳动则拒绝，让用户重签）
    if (usdtUnits !== undefined && String(usdtUnits) !== c.usdt.toString()) {
      throw new Error('价格已变动，请刷新报价后重新确认');
    }
    if (at.balanceUsdt(wallet) < c.usdt) throw new Error('USDT 可用余额不足');
    at.debitUsdt(wallet, c.usdt);
    try { at.creditUsdt(TURBO_COLLECT_WALLET, c.usdt); }
    catch (e) {
      try { at.creditUsdt(wallet, c.usdt); } catch (e2) { console.error(`[匹配池] ${wallet} 购买涡轮退款失败，需人工处理:`, e2?.message || e2); }
      throw e;
    }
    const purchaseId = makeId('atp');
    if (reqId) {
      const inserted = db.insertATokenTurboPurchase({
        id: purchaseId, wallet, requestId: reqId,
        usdtUnits: c.usdt.toString(), turboUnits: c.a.toString(), priceUnits: c.price.toString(),
        createdAt: clock(),
      });
      if (!inserted) {   // 并发下另一请求已入库：回吐刚扣的 USDT，按首次结果返回
        try { at.debitUsdt(TURBO_COLLECT_WALLET, c.usdt); at.creditUsdt(wallet, c.usdt); }
        catch (e) { console.error(`[匹配池] ${wallet} 重复购买回吐失败，需人工处理:`, e?.message || e); }
        const dup = db.getATokenTurboPurchase(wallet, reqId);
        if (dup) {
          return {
            aixIn: fmtA(dup.turboUnits), usdtIn: fmtU(dup.usdtUnits), turboOut: fmtA(dup.turboUnits),
            priceUsdt: fmtU(dup.priceUnits),
            turboBalance: fmtA(db.getATokenTurboQuota(wallet).units), purchaseId: dup.id, idempotent: true,
          };
        }
        throw new Error('购买请求冲突，请稍后重试');
      }
    }
    db.addATokenTurboQuota(wallet, c.a);
    return {
      aixIn: c.aixStr,
      usdtIn: c.usdtStr,
      turboOut: c.aixStr,
      priceUsdt: c.priceStr,
      turboBalance: fmtA(db.getATokenTurboQuota(wallet).units),
      purchaseId,
    };
  }

  // ── 放入匹配池：匹配额度 + 涡轮额度 1:1 锁入，到期出 2× 可用额度 ──
  function enterPool({ wallet, amount }) {
    wallet = String(wallet || '').toLowerCase();
    const a = at.parseA(amount, '放入数量');
    // 匹配额度（原可卖额度账本）可用 = released - used
    const matchQuota = db.getATokenSellQuota(wallet);
    const matchAvailable = BigInt(matchQuota.releasedUnits) - BigInt(matchQuota.usedUnits);
    if (matchAvailable < a) {
      const avail = matchAvailable > 0n ? matchAvailable : 0n;
      throw new Error(`匹配额度不足：当前可用 ${fmtA(avail)} AIX（质押释放产出计入匹配额度）`);
    }
    const turbo = BigInt(db.getATokenTurboQuota(wallet).units);
    if (turbo < a) {
      throw new Error(`涡轮额度不足：需 1:1 配比 ${fmtA(a)} AIX 涡轮额度，当前 ${fmtA(turbo > 0n ? turbo : 0n)} AIX，可用 USDT 购买或在 AIX 交易大厅买入获得`);
    }
    const now = clock();
    const state = db.touchATokenMatchPoolState(wallet, now);   // 首次使用落锚，之后每日 +24h
    const durationHours = durationHoursFor(state.firstPoolAt, now);
    db.consumeATokenSellQuota(wallet, a);                      // 匹配额度消耗（不可撤销）
    db.consumeATokenTurboQuota(wallet, a);                     // 涡轮额度消耗
    const entry = db.insertATokenMatchPoolEntry({
      id: makeId('amp'), wallet,
      matchUnits: a.toString(), turboUnits: a.toString(),
      totalUnits: (a * 2n).toString(),
      durationHours, createdAt: now, maturesAt: now + durationHours * HOUR_MS,
      status: 'locked', releasedAt: 0,
    });
    return presentEntry(entry);
  }

  function presentEntry(entry) {
    const now = clock();
    const remainMs = entry.status === 'locked' ? Math.max(0, Number(entry.maturesAt) - now) : 0;
    return {
      id: entry.id,
      matchA: fmtA(entry.matchUnits),
      turboA: fmtA(entry.turboUnits),
      totalA: fmtA(entry.totalUnits),
      durationHours: entry.durationHours,
      createdAt: entry.createdAt,
      maturesAt: entry.maturesAt,
      remainMs,
      status: entry.status,
      releasedAt: entry.releasedAt || 0,
    };
  }

  // ── 到期释放：total_units → 可用额度（原子标记防重，定时任务每轮扫全量）──
  function releaseDue(limit = 200) {
    const now = clock();
    let released = 0;
    for (const entry of db.listDueATokenMatchPoolEntries(now, limit)) {
      if (!db.markATokenMatchPoolEntryReleased(entry.id, now)) continue;  // 已被并发释放
      try {
        db.addATokenUsableQuota(entry.wallet, BigInt(entry.totalUnits));
        released += 1;
      } catch (e) {
        console.error(`[匹配池] ${entry.id} 可用额度发放失败（条目已标记释放，需人工补发）:`, e?.message || e);
      }
    }
    return released;
  }

  // ── 我的匹配池总览：先懒释放本人到期条目，再返回配额 + 条目 + 状态 ──
  function overview(wallet) {
    wallet = String(wallet || '').toLowerCase();
    // 懒释放：本人到期条目立即结算（全局定时任务兜底其他情况）
    const now = clock();
    for (const entry of db.listDueATokenMatchPoolEntries(now, 500)) {
      if (String(entry.wallet).toLowerCase() !== wallet) continue;
      if (!db.markATokenMatchPoolEntryReleased(entry.id, now)) continue;
      try { db.addATokenUsableQuota(wallet, BigInt(entry.totalUnits)); }
      catch (e) { console.error(`[匹配池] ${entry.id} 懒释放发放失败:`, e?.message || e); }
    }
    const matchQuota = db.getATokenSellQuota(wallet);
    const matchReleased = BigInt(matchQuota.releasedUnits);
    const matchUsed = BigInt(matchQuota.usedUnits);
    const usableQuota = db.getATokenUsableQuota(wallet);
    const usableReleased = BigInt(usableQuota.releasedUnits);
    const usableUsed = BigInt(usableQuota.usedUnits);
    const state = db.getATokenMatchPoolState(wallet);
    const started = state.firstPoolAt > 0;
    return {
      matchQuota: {
        released: fmtA(matchReleased),
        used: fmtA(matchUsed),
        available: fmtA(matchReleased > matchUsed ? matchReleased - matchUsed : 0n),
      },
      turboQuota: fmtA(db.getATokenTurboQuota(wallet).units),
      usableQuota: {
        released: fmtA(usableReleased),
        used: fmtA(usableUsed),
        available: fmtA(usableReleased > usableUsed ? usableReleased - usableUsed : 0n),
      },
      firstPoolAt: state.firstPoolAt || 0,
      started,
      dayIndex: started ? dayIndexOf(state.firstPoolAt, now) : 0,
      nextDurationHours: durationHoursFor(started ? state.firstPoolAt : now, now),
      maxDurationHours: MAX_DURATION_HOURS,
      priceUsdt: fmtU(at.getPriceUsdtUnits()),
      entries: db.listATokenMatchPoolEntries(wallet, 100).map(presentEntry),
      purchases: db.listATokenTurboPurchases(wallet, 20).map(p => ({
        id: p.id, usdtIn: fmtU(p.usdtUnits), turboOut: fmtA(p.turboUnits),
        priceUsdt: fmtU(p.priceUnits), createdAt: p.createdAt,
      })),
    };
  }

  return { quoteTurbo, buyTurbo, quoteTurboByA, buyTurboByA, costForA, enterPool, overview, releaseDue, durationHoursFor, TURBO_COLLECT_WALLET };
}
