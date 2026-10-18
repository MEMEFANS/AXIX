import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { formatUnits, getAddress, isAddress, parseUnits } from 'ethers';
import { openDatabase } from './database.js';
import { splitStakePayment } from './a-token-income.js';

const ASSET_DECIMALS = 8;
export const MAX_PERP_LEVERAGE = 100;
export const PLATFORM_SYMBOLS = ['BTC', 'ETH', 'BNB', 'SOL', 'XRP', 'DOGE'];
export function setPlatformSymbols(symbols) {
  const next = [...new Set((Array.isArray(symbols) ? symbols : []).map(value => String(value || '').trim().toUpperCase()))]
    .filter(symbol => /^[A-Z0-9]{2,12}$/.test(symbol) && symbol !== 'USDT');
  if (!next.length) throw new Error('平台至少需要一个可交易代币');
  PLATFORM_SYMBOLS.splice(0, PLATFORM_SYMBOLS.length, ...next);
  return PLATFORM_SYMBOLS.slice();
}
const USDT_DECIMALS = 6;
const PRICE_DECIMALS = 6;
const A_DECIMALS = 18; // A 币为独立 18 位小数账本（与 ASSET_DECIMALS 平台账本无关）
// 钱包资金账本各币原生精度（wallet-service assets）：并入 8 位平台台账前必须换算，否则 ETH/BNB(18位) 会放大 1e10 倍
const WALLET_ASSET_DECIMALS = { BTC: 8, ETH: 18, BNB: 18, USDT: 6 };
const walletUnitsToSpotDecimals = (symbol, rawUnits) => {
  try {
    const units = BigInt(rawUnits);
    const dec = WALLET_ASSET_DECIMALS[String(symbol || '').toUpperCase()];
    if (!dec || dec === ASSET_DECIMALS) return units;
    return dec > ASSET_DECIMALS ? units / (10n ** BigInt(dec - ASSET_DECIMALS)) : units * (10n ** BigInt(ASSET_DECIMALS - dec));
  } catch { return 0n; }
};
const STAKING_APY = 0.04;
const MAINTENANCE_BPS = 50n;
// A 币现价提供者（server 启动后注入），用于把 OPEN 卖单锁定的 A 折算进总资产
let aTokenPriceProvider = null;
const LIQUIDATION_FEE_BPS = 50n;
// 资金费率每 8 小时结算一次（与币安一致；旧版误按 1 小时结算，快了 8 倍）
const FUNDING_INTERVAL_MS = 8 * 60 * 60_000;
const FUNDING_BPS_PER_INTERVAL = 1n;
const YEAR_MS = 365 * 24 * 60 * 60_000;
const abs = value => value < 0n ? -value : value;
const nowIso = () => new Date().toISOString();
const id = prefix => `${prefix}_${crypto.randomBytes(8).toString('hex')}`;

function addressKey(value) {
  if (!isAddress(String(value || ''))) throw new Error('无效的钱包地址');
  return getAddress(String(value)).toLowerCase();
}
function units(value, decimals, label, allowZero = false) {
  let result;
  try { result = parseUnits(String(value ?? '').trim(), decimals); }
  catch { throw new Error(`${label}格式不正确`); }
  if (allowZero ? result < 0n : result <= 0n) throw new Error(`${label}${allowZero ? '不能为负数' : '必须大于 0'}`);
  return result;
}
const feeUnits = (notional, bps) => (notional * BigInt(bps) + 9_999n) / 10_000n;
const notionalUnits = (size, price) => abs(size) * price / 10n ** BigInt(ASSET_DECIMALS);
const emptyPosition = () => ({ sizeUnits:'0', entryPriceUnits:'0', marginUnits:'0', realizedPnlUnits:'0', feeUnits:'0', fundingPnlUnits:'0', leverage:1, marginMode:'isolated' });
const normalizeMarginMode = value => String(value || 'isolated').toLowerCase() === 'cross' ? 'cross' : 'isolated';
const normalizeLeverage = value => Math.min(Math.max(Math.trunc(Number(value) || 1), 1), MAX_PERP_LEVERAGE);
function marketSymbol(value) {
  const symbol = String(value || 'BTC').trim().toUpperCase();
  if (!PLATFORM_SYMBOLS.includes(symbol)) throw new Error('暂不支持该交易币种');
  return symbol;
}

export function createPlatformService({ dataRoot, walletService }) {
  const root = path.resolve(dataRoot || '.');
  const stateFile = path.join(root, 'platform-accounts.json');
  const database = walletService.database || openDatabase(root);
  const fresh = () => ({ version:4, accounts:{}, orders:[], fills:[], audit:[], insuranceFundUnits:'0', badDebtUnits:'0', lastFundingAt:Date.now(), lastFundingAtBySymbol:{} });
  let state = fresh();
  let activeTransaction = null;
  let referralRewardsService = null;
  function setReferralService(service) { referralRewardsService = service || null; }
  let pointsService = null;
  function setPointsService(service) { pointsService = service || null; }
  // Hyperliquid 式刷量剔除：窗口内同钱包同品种反向成交视为对敲，返回对手 fill（强平单不参与判定）
  function findWashMatch(address, product, symbol, side, ts) {
    if (!pointsService) return null;
    const window = Number(pointsService.rules?.wash_window_ms) || 120_000;
    const addr = String(getAddress(address)).toLowerCase();
    for (let i = state.fills.length - 1; i >= 0; i--) {
      const f = state.fills[i];
      const t = Date.parse(f.createdAt);
      if (!(Number.isFinite(t) && ts - t <= window)) break;
      if (f.liquidation) continue;
      if (String(f.address).toLowerCase() === addr && f.product === product && f.symbol === symbol && f.side !== side) return f;
    }
    return null;
  }
  function failCorruptLedger() {
    try {
      fs.copyFileSync(stateFile, path.join(root, `platform-accounts.corrupt-${Date.now()}.json`));
    } catch { /* best effort */ }
    throw new Error('平台交易账本损坏，已停止启动以防止持仓被重置');
  }
  try {
    if (database.hasPlatformData()) {
      state = database.loadPlatformState();
    } else if (fs.existsSync(stateFile)) {
      const parsed = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid root');
      if (parsed.accounts !== undefined && (!parsed.accounts || typeof parsed.accounts !== 'object' || Array.isArray(parsed.accounts))) throw new Error('invalid accounts');
      for (const field of ['orders', 'fills', 'audit']) {
        if (parsed[field] !== undefined && !Array.isArray(parsed[field])) throw new Error(`invalid ${field}`);
      }
      for (const field of ['insuranceFundUnits', 'badDebtUnits']) {
        if (parsed[field] !== undefined && !/^\d+$/.test(String(parsed[field]))) throw new Error(`invalid ${field}`);
      }
      if (parsed.lastFundingAt !== undefined && (!Number.isFinite(Number(parsed.lastFundingAt)) || Number(parsed.lastFundingAt) <= 0)) {
        throw new Error('invalid lastFundingAt');
      }
      state = { ...fresh(), ...parsed };
      for (const symbol of PLATFORM_SYMBOLS) if (!state.lastFundingAtBySymbol[symbol]) state.lastFundingAtBySymbol[symbol] = Number(state.lastFundingAt) || Date.now();
    }
    if (!database.hasPlatformData()) database.replacePlatformState(state);
  }
  catch {
    failCorruptLedger();
  }

  // onlyKeys：事务内只可能改动被 account() 触碰过的账户（各 setter 写入时已逐字段校验，未触碰账户不会变化），
  // 传入触碰集合即可把每事务的全量 O(账户数) 正则扫描降为 O(触碰数)；启动/独立写路径仍传空做全量校验。
  function assertState(onlyKeys = null) {
    // onlyKeys 传集合（含空集合）时只校验被触碰账户；空集合表示本事务没有账户被触碰，账户层免检。
    // 仅显式传 null/undefined（启动加载或事务外独立写路径）时才做全量 O(账户数) 校验。
    const scoped = onlyKeys == null
      ? Object.values(state.accounts)
      : [...onlyKeys].map(key => state.accounts[key]).filter(Boolean);
    for (const user of scoped) {
      if (!/^\d+$/.test(String(user?.strategyBalanceUnits ?? ''))) throw new Error('平台策略余额状态无效');
      if (!user.spot || typeof user.spot !== 'object' || Array.isArray(user.spot)) throw new Error('现货余额结构无效');
      for (const value of Object.values(user.spot)) if (!/^\d+$/.test(String(value))) throw new Error('现货余额状态无效');
      if (!user.perps || typeof user.perps !== 'object' || Array.isArray(user.perps)) throw new Error('永续持仓结构无效');
      if (!user.internalStrategies || typeof user.internalStrategies !== 'object' || Array.isArray(user.internalStrategies)) {
        throw new Error('内部策略账户状态无效');
      }
      for (const strategy of Object.values(user.internalStrategies)) {
        for (const field of ['capitalUnits', 'cashUnits', 'inventoryUnits', 'realizedPnlUnits', 'lastPriceUnits', 'badDebtUnits']) {
          if (!/^-?\d+$/.test(String(strategy?.[field] ?? ''))) throw new Error(`内部策略 ${field} 状态无效`);
        }
      }
      for (const position of Object.values(user.perps)) {
        if (!/^\d+$/.test(String(position?.marginUnits ?? ''))) throw new Error('合约保证金状态无效');
      }
      for (const field of ['principalUnits', 'rewardUnits', 'rewardRemainder']) {
        if (!/^\d+$/.test(String(user?.staking?.[field] ?? ''))) throw new Error(`质押 ${field} 状态无效`);
      }
    }
    for (const order of state.orders.filter(item => item.status === 'open')) {
      if (!/^\d+$/.test(String(order.reservedUnits ?? ''))) throw new Error('挂单冻结资金状态无效');
    }
    if (!/^\d+$/.test(String(state.insuranceFundUnits ?? ''))) throw new Error('保险基金状态无效');
    if (!/^\d+$/.test(String(state.badDebtUnits ?? ''))) throw new Error('坏账状态无效');
  }
  function save() {
    assertState(activeTransaction?.touched || null);
    if (activeTransaction) {
      activeTransaction.dirty = true;
      return;
    }
    database.replacePlatformState(state);
  }
  function transact(operation) {
    if (activeTransaction) return operation();
    // 性能：旧实现每次事务都 structuredClone(整个账本：全部账户+挂单+成交流水+审计) 做回滚快照，
    // 这是进程最大的 CPU/GC 热点。正常提交路径根本用不到快照；而落库(replaceLedgerStates/replacePlatformState)
    // 是单事务原子提交，事务期间不会半写，因此失败时直接从 SQLite 重新载入上一个已提交状态，与内存快照回滚等价。
    const walletUpdate = walletService.beginAtomicUpdate?.() || null;
    activeTransaction = { dirty:false, touched:new Set() };
    try {
      const result = operation();
      // 无账户被触碰、也未落脏（绝大多数未命中成交/爆仓的高频标记价 tick）时状态不可能改变，跳过自检。
      if (activeTransaction.dirty || walletUpdate?.isDirty() || activeTransaction.touched.size > 0) {
        assertState(activeTransaction.touched);
      }
      if (activeTransaction.dirty || walletUpdate?.isDirty()) {
        if (walletUpdate) database.replaceLedgerStates(walletUpdate.exportState(), state);
        else database.replacePlatformState(state);
      }
      walletUpdate?.finish();
      return result;
    } catch (error) {
      try { state = database.loadPlatformState(); } catch { /* 重载失败时维持抛出原事务错误，交由上层处理 */ }
      try { walletUpdate?.rollback(); } catch { /* 钱包侧重载失败不掩盖原始错误 */ }
      throw error;
    } finally {
      activeTransaction = null;
    }
  }
  function audit(address, type, details = {}) {
    state.audit.push({ id:id('evt'), address:address ? getAddress(address) : null, type, createdAt:nowIso(), ...details });
    if (state.audit.length > 20_000) state.audit.splice(0, state.audit.length - 20_000);
  }
  function account(address) {
    const key = addressKey(address);
    if (activeTransaction) activeTransaction.touched.add(key);
    if (!state.accounts[key]) {
      // SQLite 里可能已经有这个账户（例如 AI 托管 batch 仅写了 platform_accounts），
      // 先尝试从 DB 懒加载，避免新建的空壳把 ai-managed 状态覆盖。
      const existing = database.loadPlatformAccount?.(address);
      if (existing && typeof existing === 'object' && !Array.isArray(existing)) {
        state.accounts[key] = existing;
        if (!state.accounts[key].address) state.accounts[key].address = getAddress(address);
      } else {
        state.accounts[key] = { address:getAddress(address), spot:{}, perps:{}, strategyBalanceUnits:'0', internalStrategies:{}, staking:{ principalUnits:'0', rewardUnits:'0', rewardRemainder:'0', updatedAt:Date.now() } };
      }
    }
    const user = state.accounts[key];
    user.address = getAddress(address);
    if (!user.spot || typeof user.spot !== 'object' || Array.isArray(user.spot)) user.spot = {};
    if (user.spotBtcUnits !== undefined && user.spot.BTC === undefined) user.spot.BTC = String(user.spotBtcUnits);
    delete user.spotBtcUnits;
    if (!user.perps || typeof user.perps !== 'object' || Array.isArray(user.perps)) user.perps = {};
    if (user.perp && user.perps.BTC === undefined) user.perps.BTC = user.perp;
    delete user.perp;
    for (const symbol of PLATFORM_SYMBOLS) {
      if (user.spot[symbol] === undefined) user.spot[symbol] = '0';
      if (!/^\d+$/.test(String(user.spot[symbol]))) throw new Error(`${symbol} 现货余额状态无效`);
      if (!user.perps[symbol]) user.perps[symbol] = emptyPosition();
      const position = user.perps[symbol];
      for (const field of ['sizeUnits', 'entryPriceUnits', 'marginUnits', 'realizedPnlUnits', 'feeUnits', 'fundingPnlUnits']) {
        if (position[field] === undefined) position[field] = '0';
        if (!/^-?\d+$/.test(String(position[field]))) throw new Error(`${symbol} 永续 ${field} 状态无效`);
      }
      if (BigInt(position.marginUnits) < 0n || BigInt(position.entryPriceUnits) < 0n) throw new Error(`${symbol} 永续持仓状态无效`);
      position.leverage = normalizeLeverage(position.leverage);
      position.marginMode = normalizeMarginMode(position.marginMode);
    }
    if (user.strategyBalanceUnits === undefined) user.strategyBalanceUnits = '0';
    else if (!/^\d+$/.test(String(user.strategyBalanceUnits))) throw new Error('策略余额状态无效');
    if (user.internalStrategies === undefined) user.internalStrategies = {};
    else if (!user.internalStrategies || typeof user.internalStrategies !== 'object' || Array.isArray(user.internalStrategies)) throw new Error('内部策略账户状态无效');
    if (user.staking === undefined) user.staking = {};
    else if (!user.staking || typeof user.staking !== 'object' || Array.isArray(user.staking)) throw new Error('质押账户结构无效');
    for (const field of ['principalUnits', 'rewardUnits', 'rewardRemainder']) {
      if (user.staking[field] === undefined) user.staking[field] = '0';
      else if (!/^\d+$/.test(String(user.staking[field]))) throw new Error(`质押 ${field} 状态无效`);
    }
    if (user.staking.updatedAt === undefined) user.staking.updatedAt = Date.now();
    else if (!Number.isFinite(Number(user.staking.updatedAt)) || Number(user.staking.updatedAt) <= 0) throw new Error('质押结算时间无效');
    return user;
  }
  try {
    for (const [key, user] of Object.entries(state.accounts)) {
      if (!user || typeof user !== 'object' || Array.isArray(user)) throw new Error('invalid account');
      account(user.address || key);
    }
    for (const order of state.orders) if (!order.symbol) order.symbol = 'BTC';
    for (const fill of state.fills) if (!fill.symbol) fill.symbol = 'BTC';
    if (!state.version || state.version < 4) {
      // v4：资金费率结算间隔由错误的 1 小时修正为 8 小时（币安标准）。
      // 退还在仓持仓按旧规则多收/多付的资金费，并重置结算计时，避免启动后按新间隔一次性补扣。
      let refundTotal = 0n;
      for (const user of Object.values(state.accounts)) {
        for (const position of Object.values(user.perps || {})) {
          if (BigInt(position.sizeUnits || '0') === 0n) continue;
          const fundingPnl = BigInt(position.fundingPnlUnits || '0');
          if (fundingPnl === 0n) continue;
          const refund = -fundingPnl; // 多头 pnl 为负 → 退回保证金；空头 pnl 为正 → 扣回
          const nextMargin = BigInt(position.marginUnits || '0') + refund;
          position.marginUnits = (nextMargin < 0n ? 0n : nextMargin).toString();
          position.fundingPnlUnits = '0';
          refundTotal += refund;
        }
      }
      const nextFund = BigInt(state.insuranceFundUnits || '0') - refundTotal;
      state.insuranceFundUnits = (nextFund < 0n ? 0n : nextFund).toString();
      const now = Date.now();
      state.lastFundingAt = now;
      state.lastFundingAtBySymbol = {};
      for (const symbol of PLATFORM_SYMBOLS) state.lastFundingAtBySymbol[symbol] = now;
    }
    state.version = 4;
    assertState();
    database.replacePlatformState(state);
  } catch {
    failCorruptLedger();
  }
  function accrue(staking) {
    const now = Date.now();
    const elapsed = Math.max(0, now - Number(staking.updatedAt || now));
    const principal = BigInt(staking.principalUnits || '0');
    const denominator = 100n * BigInt(YEAR_MS);
    const numerator = BigInt(staking.rewardRemainder || '0') + principal * BigInt(elapsed) * 4n;
    const reward = numerator / denominator;
    staking.rewardRemainder = (numerator % denominator).toString();
    if (reward > 0n) staking.rewardUnits = (BigInt(staking.rewardUnits || '0') + reward).toString();
    staking.updatedAt = now;
    return reward > 0n;
  }
  function recordFill(address, data) {
    const fill = { id:id('fill'), address:getAddress(address), createdAt:nowIso(), ...data };
    state.fills.push(fill);
    if (state.fills.length > 10_000) state.fills.splice(0, state.fills.length - 10_000);
    return fill;
  }
  function chargeInsurance(amount) {
    const fund = BigInt(state.insuranceFundUnits || '0');
    const debt = BigInt(state.badDebtUnits || '0');
    if (amount >= 0n) {
      const repayment = amount < debt ? amount : debt;
      state.badDebtUnits = (debt - repayment).toString();
      state.insuranceFundUnits = (fund + amount - repayment).toString();
    } else {
      const loss = -amount, covered = loss < fund ? loss : fund;
      state.insuranceFundUnits = (fund - covered).toString();
      state.badDebtUnits = (debt + loss - covered).toString();
    }
  }

  function spotTrade(address, { symbol:inputSymbol, side, size, price, feeBps = 5, reservedUnits = 0n, clientOrderId = '', requestHash = '' }) {
    const symbol = marketSymbol(inputSymbol), user = account(address), quantity = units(size, ASSET_DECIMALS, `${symbol} 数量`), px = units(price, PRICE_DECIMALS, '成交价格');
    const notional = notionalUnits(quantity, px), fee = feeUnits(notional, feeBps);
    if (side === 'buy') {
      const required = notional + fee;
      const debit = required > reservedUnits ? required - reservedUnits : 0n;
      if (debit > walletService.balanceUnits(address, 'USDT')) throw new Error('平台账户余额不足');
      if (debit > 0n) walletService.debitBalance(address, 'USDT', debit);
      else if (reservedUnits > required) walletService.creditBalance(address, 'USDT', reservedUnits - required);
      user.spot[symbol] = (BigInt(user.spot[symbol]) + quantity).toString();
    } else if (side === 'sell') {
      if (!reservedUnits) {
        const current = BigInt(user.spot[symbol]); if (current < quantity) throw new Error(`${symbol} 现货余额不足`);
        user.spot[symbol] = (current - quantity).toString();
      }
      walletService.creditBalance(address, 'USDT', notional - fee);
    } else throw new Error('交易方向无效');
    chargeInsurance(side === 'buy' ? notional + fee : -(notional - fee));
    const fill = recordFill(address, { symbol, product:'spot', side, sizeUnits:quantity.toString(), priceUnits:px.toString(), feeUnits:fee.toString(), pnlUnits:'0', clientOrderId, requestHash });
    referralRewardsService?.distributeTradingFee(address, fee, fill.id, Date.parse(fill.createdAt));
    const fillTs = Date.parse(fill.createdAt);
    const washFill = pointsService ? findWashMatch(address, 'spot', symbol, side, fillTs) : null;
    pointsService?.onTradingFill(address, 'spot', notional.toString(), {
      symbol, side, refId:fill.id, ts:fillTs,
      washMatch: washFill ? { refId:washFill.id, notionalUnits:notionalUnits(BigInt(washFill.sizeUnits), BigInt(washFill.priceUnits)).toString(), ts:Date.parse(washFill.createdAt) } : null,
    });
    audit(address, 'spot_fill', { fillId:fill.id }); save(); return fill;
  }

  function perpTrade(address, { symbol:inputSymbol, side, size, price, leverage, marginMode = 'isolated', reduceOnly = false, reservedUnits = 0n, clientOrderId = '', requestHash = '' }) {
    const symbol = marketSymbol(inputSymbol), user = account(address), lev = normalizeLeverage(leverage);
    const quantity = units(size, ASSET_DECIMALS, `${symbol} 数量`), px = units(price, PRICE_DECIMALS, '成交价格');
    const delta = side === 'buy' ? quantity : side === 'sell' ? -quantity : 0n; if (!delta) throw new Error('交易方向无效');
    const position = user.perps[symbol], oldSize = BigInt(position.sizeUnits), oldEntry = BigInt(position.entryPriceUnits), oldMargin = BigInt(position.marginUnits);
    const oldLeverage = normalizeLeverage(position.leverage);
    const requestedMarginMode = normalizeMarginMode(marginMode), activeMarginMode = oldSize ? normalizeMarginMode(position.marginMode) : requestedMarginMode;
    if (reduceOnly && (!oldSize || (oldSize > 0n) === (delta > 0n) || abs(delta) > abs(oldSize))) {
      throw new Error('只减仓订单不能反向开仓或超过当前持仓');
    }
    let newSize = oldSize + delta, newEntry = oldEntry, newMargin = oldMargin, newLeverage = oldSize ? oldLeverage : lev;
    let realized = 0n, debit = 0n, credit = 0n, insuranceSettlement = 0n, totalFee = 0n;
    if (oldSize === 0n || (oldSize > 0n) === (delta > 0n)) {
      const activeLeverage = oldSize ? oldLeverage : lev;
      const openNotional = notionalUnits(delta, px), margin = openNotional / BigInt(activeLeverage), fee = feeUnits(openNotional, 4);
      debit = margin + fee;
      totalFee = fee;
      newEntry = oldSize === 0n ? px : (abs(oldSize) * oldEntry + abs(delta) * px) / abs(newSize); newMargin += margin;
    } else {
      const closeSize = abs(delta) < abs(oldSize) ? abs(delta) : abs(oldSize), closeNotional = notionalUnits(closeSize, px), closeFee = feeUnits(closeNotional, 4);
      totalFee = closeFee;
      realized = closeSize * (px - oldEntry) * (oldSize > 0n ? 1n : -1n) / 10n ** BigInt(ASSET_DECIMALS);
      const released = oldMargin * closeSize / abs(oldSize), settlement = released + realized - closeFee;
      if (settlement > 0n) credit += settlement;
      newMargin -= released;
      if (settlement < 0n) {
        const deficit = -settlement;
        const remainingOldPosition = abs(delta) < abs(oldSize);
        const marginAbsorbed = remainingOldPosition && newMargin > 0n
          ? (deficit < newMargin ? deficit : newMargin)
          : 0n;
        newMargin -= marginAbsorbed;
        insuranceSettlement = -(deficit - marginAbsorbed);
      }
      if (abs(delta) > abs(oldSize)) {
        const remainder = abs(delta) - abs(oldSize), openNotional = notionalUnits(remainder, px), margin = openNotional / BigInt(lev), fee = feeUnits(openNotional, 4);
        debit += margin + fee; totalFee += fee; newMargin = margin; newEntry = px; newLeverage = lev;
      } else if (newSize === 0n) { newEntry = 0n; newMargin = 0n; }
    }
    const walletDebit = debit > reservedUnits ? debit - reservedUnits : 0n;
    if (walletDebit > walletService.balanceUnits(address, 'USDT')) throw new Error('平台账户余额不足');
    if (walletDebit > 0n) walletService.debitBalance(address, 'USDT', walletDebit);
    else if (reservedUnits > debit) walletService.creditBalance(address, 'USDT', reservedUnits - debit);
    if (credit > 0n) walletService.creditBalance(address, 'USDT', credit);
    chargeInsurance(totalFee);
    if (insuranceSettlement < 0n) chargeInsurance(insuranceSettlement);
    else if (realized !== 0n) chargeInsurance(-realized);
    Object.assign(position, { sizeUnits:newSize.toString(), entryPriceUnits:newEntry.toString(), marginUnits:newMargin.toString(), realizedPnlUnits:(BigInt(position.realizedPnlUnits) + realized).toString(), feeUnits:(BigInt(position.feeUnits || '0') + totalFee).toString(), leverage:newLeverage, marginMode: newSize === 0n ? 'isolated' : activeMarginMode });
    const fill = recordFill(address, { symbol, product:'perp', side, sizeUnits:quantity.toString(), priceUnits:px.toString(), feeUnits:totalFee.toString(), pnlUnits:realized.toString(), reduceOnly:Boolean(reduceOnly), clientOrderId, requestHash });
    referralRewardsService?.distributeTradingFee(address, totalFee, fill.id, Date.parse(fill.createdAt));
    // 空投积分只计开仓量（平仓/减仓是对敲判定盲区，不计分防刷）
    const oldAbsSize = oldSize < 0n ? -oldSize : oldSize;
    const deltaAbs = delta < 0n ? -delta : delta;
    const openingQty = (oldSize === 0n || (oldSize > 0n) === (delta > 0n)) ? quantity : (deltaAbs > oldAbsSize ? deltaAbs - oldAbsSize : 0n);
    if (openingQty > 0n) {
      const fillTs = Date.parse(fill.createdAt);
      const washFill = pointsService ? findWashMatch(address, 'perp', symbol, side, fillTs) : null;
      pointsService?.onTradingFill(address, 'perp', notionalUnits(openingQty, px).toString(), {
        symbol, side, refId:fill.id, ts:fillTs,
        washMatch: washFill ? { refId:washFill.id, notionalUnits:notionalUnits(BigInt(washFill.sizeUnits), BigInt(washFill.priceUnits)).toString(), ts:Date.parse(washFill.createdAt) } : null,
      });
    }
    audit(address, 'perp_fill', { fillId:fill.id }); save(); return fill;
  }

  function placeOrder(address, body, markPrice) {
    const symbol = marketSymbol(body.symbol), product = body.product === 'spot' ? 'spot' : 'perp', side = body.side === 'sell' ? 'sell' : 'buy';
    const orderType = body.type === 'trigger' ? 'trigger' : 'limit';
    const triggerDirection = body.triggerDirection === 'below' ? 'below' : 'above';
    const orderPriceInput = orderType === 'trigger' ? body.triggerPrice : body.limitPrice;
    const quantity = units(body.size, ASSET_DECIMALS, `${symbol} 数量`), limit = units(orderPriceInput, PRICE_DECIMALS, orderType === 'trigger' ? '触发价' : '限价');
    const lev = normalizeLeverage(body.leverage), user = account(address);
    let reserved = 0n, reserveAsset = 'USDT';
    const reduceOnly = Boolean(body.reduceOnly);
    if (reduceOnly) {
      if (product !== 'perp') throw new Error('只有永续合约支持只减仓');
      const positionSize = BigInt(user.perps[symbol].sizeUnits || '0');
      const delta = side === 'buy' ? quantity : -quantity;
      if (!positionSize || (positionSize > 0n) === (delta > 0n)) throw new Error('只减仓方向与当前持仓不匹配');
      const alreadyOpen = state.orders.filter(order => order.status === 'open' && order.product === 'perp'
        && order.symbol === symbol && order.reduceOnly && order.address.toLowerCase() === addressKey(address))
        .reduce((sum, order) => sum + BigInt(order.sizeUnits), 0n);
      if (alreadyOpen + quantity > abs(positionSize)) throw new Error('只减仓委托总量超过当前持仓');
    } else if (product === 'spot' && side === 'sell') {
      if (BigInt(user.spot[symbol]) < quantity) throw new Error(`${symbol} 现货余额不足`);
      user.spot[symbol] = (BigInt(user.spot[symbol]) - quantity).toString(); reserved = quantity; reserveAsset = symbol;
    } else {
      const notional = notionalUnits(quantity, limit), fee = feeUnits(notional, product === 'spot' ? 5 : 4);
      if (product === 'spot') reserved = notional + fee;
      else {
        const positionSize = BigInt(user.perps[symbol].sizeUnits || '0');
        const positionLeverage = normalizeLeverage(user.perps[symbol].leverage);
        const delta = side === 'buy' ? quantity : -quantity;
        const openingSize = positionSize && (positionSize > 0n) !== (delta > 0n)
          ? (abs(delta) > abs(positionSize) ? abs(delta) - abs(positionSize) : 0n)
          : abs(delta);
        // A pure close is settled from isolated margin. Only the opening
        // remainder of a flip needs a wallet reservation.
        const openingNotional = notionalUnits(openingSize, limit);
        const reserveLeverage = positionSize && (positionSize > 0n) === (delta > 0n) ? positionLeverage : lev;
        reserved = openingNotional / BigInt(reserveLeverage) + feeUnits(openingNotional, 4);
      }
      walletService.debitBalance(address, 'USDT', reserved);
    }
    const order = { id:id('ord'), address:getAddress(address), symbol, product, type:orderType, side, sizeUnits:quantity.toString(), limitPriceUnits:limit.toString(), triggerPriceUnits:orderType === 'trigger' ? limit.toString() : '0', triggerDirection, leverage:lev, marginMode: product === 'perp' ? normalizeMarginMode(body.marginMode) : 'isolated', reduceOnly, reservedUnits:reserved.toString(), reserveAsset, status:'open', createdAt:nowIso(), clientOrderId:String(body.clientOrderId || ''), requestHash:String(body.requestHash || '') };
    state.orders.push(order); audit(address, 'order_open', { orderId:order.id }); save();
    if (Number(markPrice) > 0) processMarkPrice(product, symbol, markPrice);
    return order;
  }
  function cancelOrder(address, orderId) {
    const order = state.orders.find(item => item.id === orderId && item.address.toLowerCase() === addressKey(address));
    if (!order || order.status !== 'open') throw new Error('当前委托不存在');
    const reserved = BigInt(order.reservedUnits);
    if (order.reserveAsset !== 'USDT') account(address).spot[order.reserveAsset] = (BigInt(account(address).spot[order.reserveAsset]) + reserved).toString();
    else walletService.creditBalance(address, 'USDT', reserved);
    order.status = 'cancelled'; order.cancelledAt = nowIso(); audit(address, 'order_cancel', { orderId:order.id }); save(); return order;
  }

  function settleFunding(symbol, markPrice, now = Date.now()) {
    const lastFundingAt = Number(state.lastFundingAtBySymbol[symbol] || state.lastFundingAt || now);
    const intervals = Math.floor((now - lastFundingAt) / FUNDING_INTERVAL_MS); if (intervals <= 0) return;
    const px = units(markPrice, PRICE_DECIMALS, '标记价格');
    for (const [key, user] of Object.entries(state.accounts)) {
      const pos = user.perps[symbol], size = BigInt(pos.sizeUnits || '0'); if (!size) continue;
      if (activeTransaction) activeTransaction.touched.add(key);
      const payment = notionalUnits(size, px) * FUNDING_BPS_PER_INTERVAL * BigInt(intervals) / 10_000n;
      const margin = BigInt(pos.marginUnits);
      const settled = size > 0n ? (payment < margin ? payment : margin) : -payment;
      pos.marginUnits = (margin - settled).toString();
      pos.fundingPnlUnits = (BigInt(pos.fundingPnlUnits || '0') - settled).toString(); chargeInsurance(settled);
      audit(user.address, 'funding', { amountUnits:(-settled).toString(), intervals });
    }
    state.lastFundingAtBySymbol[symbol] = lastFundingAt + intervals * FUNDING_INTERVAL_MS;
    state.lastFundingAt = Math.max(...Object.values(state.lastFundingAtBySymbol).map(Number)); save();
  }
  function liquidate(symbol, markPrice) {
    const px = units(markPrice, PRICE_DECIMALS, '标记价格');
    let changed = false;
    for (const [key, user] of Object.entries(state.accounts)) {
      const pos = user.perps[symbol], size = BigInt(pos.sizeUnits || '0'); if (!size) continue;
      const margin = BigInt(pos.marginUnits), pnl = size * (px - BigInt(pos.entryPriceUnits)) / 10n ** BigInt(ASSET_DECIMALS);
      const maintenance = feeUnits(notionalUnits(size, px), MAINTENANCE_BPS);
      if (margin + pnl > maintenance) continue;
      if (activeTransaction) activeTransaction.touched.add(key);
      const fee = feeUnits(notionalUnits(size, px), LIQUIDATION_FEE_BPS), remaining = margin + pnl - fee;
      if (remaining > 0n) walletService.creditBalance(user.address, 'USDT', remaining);
      else {
        let loss = -remaining;
        if (normalizeMarginMode(pos.marginMode) === 'cross') {
          const walletBalance = walletService.balanceUnits(user.address, 'USDT');
          const walletCover = walletBalance < loss ? walletBalance : loss;
          if (walletCover > 0n) { walletService.debitBalance(user.address, 'USDT', walletCover); loss -= walletCover; }
        }
        if (loss > 0n) chargeInsurance(-loss);
      }
      chargeInsurance(fee); pos.realizedPnlUnits = (BigInt(pos.realizedPnlUnits) + pnl).toString(); pos.feeUnits = (BigInt(pos.feeUnits || '0') + fee).toString();
      Object.assign(pos, { sizeUnits:'0', entryPriceUnits:'0', marginUnits:'0' });
      recordFill(user.address, { symbol, product:'perp', side:size > 0n ? 'sell' : 'buy', sizeUnits:abs(size).toString(), priceUnits:px.toString(), feeUnits:fee.toString(), pnlUnits:pnl.toString(), liquidation:true });
      // 强平不计空投积分：其持仓量在开仓时已计过，重复计分等于送分
      audit(user.address, 'liquidation', { markPriceUnits:px.toString(), pnlUnits:pnl.toString() });
      changed = true;
    }
    if (changed) save();
    return changed;
  }
  function processMarkPrice(product, symbolInput, markPriceInput) {
    const legacyCall = markPriceInput === undefined;
    const symbol = marketSymbol(legacyCall ? 'BTC' : symbolInput);
    const markPrice = legacyCall ? symbolInput : markPriceInput;
    if (product === 'perp') { settleFunding(symbol, markPrice); liquidate(symbol, markPrice); }
    const px = units(markPrice, PRICE_DECIMALS, '标记价格');
    const matches = state.orders.filter(order => {
      if (order.status !== 'open' || order.product !== product || order.symbol !== symbol) return false;
      if (order.type === 'trigger') {
        const trigger = BigInt(order.triggerPriceUnits || order.limitPriceUnits);
        return order.triggerDirection === 'below' ? px <= trigger : px >= trigger;
      }
      return order.side === 'buy' ? px <= BigInt(order.limitPriceUnits) : px >= BigInt(order.limitPriceUnits);
    });
    for (const order of matches) {
      try {
        const args = { symbol, side:order.side, size:formatUnits(order.sizeUnits, ASSET_DECIMALS), price:markPrice, leverage:order.leverage, marginMode:order.marginMode, reduceOnly:Boolean(order.reduceOnly), reservedUnits:BigInt(order.reservedUnits), clientOrderId:order.clientOrderId, requestHash:order.requestHash };
        if (product === 'spot') spotTrade(order.address, args); else perpTrade(order.address, args);
        order.status = 'filled'; order.filledAt = nowIso();
      } catch (error) {
        const reserved = BigInt(order.reservedUnits || '0');
        if (order.reserveAsset !== 'USDT') account(order.address).spot[order.reserveAsset] = (BigInt(account(order.address).spot[order.reserveAsset]) + reserved).toString();
        else if (reserved > 0n) walletService.creditBalance(order.address, 'USDT', reserved);
        order.status = 'rejected'; order.reason = error.message; audit(order.address, 'order_reject', { orderId:order.id, reason:error.message });
      }
    }
    if (matches.length) save(); return matches.length;
  }

  function consolidateStrategyBalances() {
    let changed = false;
    for (const [key, user] of Object.entries(state.accounts)) {
      const legacy = BigInt(user.strategyBalanceUnits || '0');
      if (legacy <= 0n) continue;
      if (activeTransaction) activeTransaction.touched.add(key);
      walletService.creditBalance(user.address, 'USDT', legacy);
      user.strategyBalanceUnits = '0';
      audit(user.address, 'strategy_balance_consolidated', { amountUnits:legacy.toString() });
      changed = true;
    }
    if (changed) save();
    return changed;
  }
  function internalStrategyState(address, key) {
    return structuredClone(account(address).internalStrategies[String(key)] || null);
  }
  function internalStrategyAccounts() {
    return Object.values(state.accounts)
      .filter(user => user?.internalStrategies && Object.values(user.internalStrategies).some(strategy => strategy?.running))
      .map(user => user.address);
  }
  function startInternalStrategy(address, key, strategy, capital) {
    const user = account(address), value = BigInt(capital);
    if (value <= 0n) throw new Error('策略资金必须大于 0');
    if (walletService.balanceUnits(address, 'USDT') < value) throw new Error('平台账户余额不足');
    if (user.internalStrategies[key]?.running) throw new Error('策略已经在运行');
    walletService.debitBalance(address, 'USDT', value);
    user.internalStrategies[key] = structuredClone(strategy);
    audit(address, 'internal_strategy_start', { strategy:key, amountUnits:value.toString() }); save();
  }
  function addToInternalStrategy(address, key, strategy, capital) {
    const user = account(address), value = BigInt(capital);
    if (value <= 0n) throw new Error('策略资金必须大于 0');
    if (walletService.balanceUnits(address, 'USDT') < value) throw new Error('平台账户余额不足');
    walletService.debitBalance(address, 'USDT', value);
    user.internalStrategies[key] = structuredClone(strategy);
    audit(address, 'internal_strategy_add', { strategy:key, amountUnits:value.toString() });
    save();
  }
  function updateInternalStrategy(address, key, strategy) {
    const user = account(address);
    user.internalStrategies[key] = structuredClone(strategy);
    audit(address, 'internal_strategy_update', { strategy:key }); save();
  }
  function settleInternalStrategy(address, key, strategy, settlement) {
    const user = account(address), current = user.internalStrategies[key];
    if (!current || BigInt(current.capitalUnits || '0') <= 0n) throw new Error('策略没有待结算资金');
    const capital = BigInt(current.capitalUnits), value = BigInt(settlement);
    if (value < 0n) throw new Error('策略结算金额不能为负数');
    walletService.creditBalance(address, 'USDT', value);
    chargeInsurance(capital - value);
    user.internalStrategies[key] = structuredClone(strategy);
    audit(address, 'internal_strategy_settle', { strategy:key, capitalUnits:capital.toString(), settlementUnits:value.toString() }); save();
  }
  function stake(address, amount) { const user=account(address); accrue(user.staking); const value=units(amount,USDT_DECIMALS,'质押数量'); walletService.debitBalance(address,'USDT',value); user.staking.principalUnits=(BigInt(user.staking.principalUnits)+value).toString(); audit(address,'stake',{amountUnits:value.toString()}); save(); }
  function unstake(address, amount) { const user=account(address); accrue(user.staking); const value=units(amount,USDT_DECIMALS,'赎回数量'), principal=BigInt(user.staking.principalUnits); if(value>principal)throw new Error('质押余额不足'); const reward=BigInt(user.staking.rewardUnits); user.staking.principalUnits=(principal-value).toString(); user.staking.rewardUnits='0'; walletService.creditBalance(address,'USDT',value+reward); if(reward>0n)chargeInsurance(-reward); audit(address,'unstake',{amountUnits:value.toString(),rewardUnits:reward.toString()}); save(); }

  // 运营发放（抽奖中奖等）：直接给用户平台现货台账入账，资产页可见且可市价卖出换 USDT
  function creditSpot(address, symbol, quantityUnits) {
    const sym = marketSymbol(symbol), quantity = BigInt(quantityUnits);
    if (quantity <= 0n) throw new Error('入账数量必须大于 0');
    const user = account(address);
    user.spot[sym] = (BigInt(user.spot[sym] || '0') + quantity).toString();
    audit(address, 'lottery_credit', { symbol: sym, amountUnits: quantity.toString() });
    save();
    return quantity;
  }

  function totalEquityUnits(user, markPrices = {}) {
    const legacyPrice = typeof markPrices === 'number' ? markPrices : 0;
    const prices = Object.fromEntries(PLATFORM_SYMBOLS.map(symbol => [symbol, Number(markPrices?.[symbol] ?? legacyPrice ?? 0)]));
    const openOrders = state.orders.filter(item => item.address.toLowerCase() === addressKey(user.address) && item.status === 'open');
    const freeUsdt = walletService.balanceUnits(user.address, 'USDT');
    const frozenUsdt = openOrders.filter(item => item.reserveAsset === 'USDT')
      .reduce((sum, item) => sum + BigInt(item.reservedUnits || '0'), 0n);
    const spotValue = PLATFORM_SYMBOLS.reduce((sum, symbol) => {
      const frozen = openOrders.filter(item => item.reserveAsset === symbol)
        .reduce((amount, item) => amount + BigInt(item.reservedUnits || '0'), 0n);
      const mark = BigInt(Math.round(prices[symbol] * 1e6));
      return mark > 0n ? sum + notionalUnits(BigInt(user.spot[symbol] || '0') + frozen, mark) : sum;
    }, 0n);
    const positionEquity = PLATFORM_SYMBOLS.reduce((sum, symbol) => {
      const position = user.perps[symbol];
      const size = BigInt(position?.sizeUnits || '0');
      const entry = BigInt(position?.entryPriceUnits || '0');
      const mark = BigInt(Math.round(prices[symbol] * 1e6));
      const unrealized = mark > 0n ? size * (mark - entry) / 10n ** BigInt(ASSET_DECIMALS) : 0n;
      return sum + BigInt(position?.marginUnits || '0') + unrealized;
    }, 0n);
    const stakingValue = BigInt(user.staking?.principalUnits || '0') + BigInt(user.staking?.rewardUnits || '0');
    const internalStrategyValue = Object.values(user.internalStrategies || {}).filter(strategy => strategy?.running).reduce((sum, strategy) => {
      const strategySymbol = marketSymbol(strategy?.config?.symbol || 'BTC');
      const liveMark = BigInt(Math.round(Number(prices[strategySymbol] || 0) * 1e6));
      const mark = liveMark > 0n ? liveMark : BigInt(strategy?.lastPriceUnits || '0');
      return sum + BigInt(strategy?.cashUnits || '0')
        + (mark > 0n ? BigInt(strategy?.inventoryUnits || '0') * mark / 10n ** BigInt(ASSET_DECIMALS) : 0n);
    }, 0n);
    return freeUsdt + frozenUsdt + spotValue + BigInt(user.strategyBalanceUnits || '0')
      + internalStrategyValue + stakingValue + positionEquity;
  }

  function profile(address, markPrices = {}, selectedSymbol = 'BTC') {
    const user=account(address); if (accrue(user.staking)) save();
    const legacyPrice = typeof markPrices === 'number' ? markPrices : 0;
    const prices = Object.fromEntries(PLATFORM_SYMBOLS.map(symbol => [symbol, Number(markPrices?.[symbol] ?? legacyPrice ?? 0)]));
    const openOrders=state.orders.filter(item=>item.address.toLowerCase()===addressKey(address)&&item.status==='open');
    const presentOrder=item=>({...item,type:item.type === 'trigger' ? 'trigger' : 'limit',size:formatUnits(item.sizeUnits,ASSET_DECIMALS),limitPrice:formatUnits(item.limitPriceUnits,PRICE_DECIMALS),triggerPrice:formatUnits(item.triggerPriceUnits || '0',PRICE_DECIMALS)});
    const freeUsdt=walletService.balanceUnits(address,'USDT');
    // ── A 币交易委托冻结并入资产口径：否则求购/挂牌中的资金在资产管理页不可见 ──
    let aLockedUsdt=0n,aLockedA=0n;
    try {
      const locks=walletService.database?.sumATokenLockedByWallet?.(address);
      if (locks) { aLockedUsdt=BigInt(locks.usdtUnits||'0'); aLockedA=BigInt(locks.aUnits||'0'); }
    } catch {}
    const frozenUsdt=openOrders.filter(item=>item.reserveAsset==='USDT').reduce((sum,item)=>sum+BigInt(item.reservedUnits||'0'),0n)+aLockedUsdt;
    const frozenPerpUsdt=openOrders.filter(item=>item.product==='perp'&&item.reserveAsset==='USDT').reduce((sum,item)=>sum+BigInt(item.reservedUnits||'0'),0n);
    let spotValue=0n, positionEquity=0n, marginUsed=0n;
    const spotFrozen={};
    const spot=Object.fromEntries(PLATFORM_SYMBOLS.map(symbol => {
      const frozen=openOrders.filter(item=>item.reserveAsset===symbol).reduce((sum,item)=>sum+BigInt(item.reservedUnits||'0'),0n);
      spotFrozen[symbol]=formatUnits(frozen,ASSET_DECIMALS);
      // 钱包资金账本中的币种余额（如历史抽奖发放的 BTC/ETH/BNB）并入现货展示，否则资产页不可见
      // 注意：钱包账本为各币原生精度（ETH/BNB 18位），需换算到平台 8 位台账；账户不存在时 balanceUnits 会抛错，不能让它中断 profile
      let walletUnits=0n;
      try { walletUnits=walletUnitsToSpotDecimals(symbol, walletService.balanceUnits(address,symbol)||'0'); } catch {}
      const amount=BigInt(user.spot[symbol])+walletUnits+frozen, mark=BigInt(Math.round(prices[symbol]*1e6));
      if(mark>0n) spotValue+=notionalUnits(amount,mark);
      return [symbol,formatUnits(BigInt(user.spot[symbol])+walletUnits,ASSET_DECIMALS)];
    }));
    const perps=Object.fromEntries(PLATFORM_SYMBOLS.map(symbol => {
      const pos=user.perps[symbol], size=BigInt(pos.sizeUnits), entry=BigInt(pos.entryPriceUnits), mark=BigInt(Math.round(prices[symbol]*1e6));
      const unrealized=mark>0n?size*(mark-entry)/10n**BigInt(ASSET_DECIMALS):0n;
      const sizeNumber=Number(formatUnits(size,ASSET_DECIMALS)), entryNumber=Number(formatUnits(entry,PRICE_DECIMALS)), marginNumber=Number(formatUnits(pos.marginUnits,USDT_DECIMALS));
      const liquidationMargin = normalizeMarginMode(pos.marginMode) === 'cross' ? marginNumber + Number(formatUnits(freeUsdt, USDT_DECIMALS)) : marginNumber;
      const liquidationPrice=sizeNumber===0?0:Math.max(0,sizeNumber>0?(entryNumber-liquidationMargin/Math.abs(sizeNumber))/(1-Number(MAINTENANCE_BPS)/10000):(entryNumber+liquidationMargin/Math.abs(sizeNumber))/(1+Number(MAINTENANCE_BPS)/10000));
      positionEquity+=BigInt(pos.marginUnits)+unrealized; marginUsed+=BigInt(pos.marginUnits);
      return [symbol,{symbol,size:formatUnits(size,ASSET_DECIMALS),entryPrice:formatUnits(entry,PRICE_DECIMALS),markPrice:formatUnits(mark>0n?mark:0n,PRICE_DECIMALS),margin:formatUnits(pos.marginUnits,USDT_DECIMALS),marginMode:normalizeMarginMode(pos.marginMode),leverage:pos.leverage,liquidationPrice:String(liquidationPrice),unrealizedPnl:formatUnits(unrealized,USDT_DECIMALS),realizedPnl:formatUnits(pos.realizedPnlUnits,USDT_DECIMALS),totalFee:formatUnits(pos.feeUnits||'0',USDT_DECIMALS),netRealizedPnl:formatUnits(BigInt(pos.realizedPnlUnits)-BigInt(pos.feeUnits||'0'),USDT_DECIMALS),fundingPnl:formatUnits(pos.fundingPnlUnits,USDT_DECIMALS),maintenanceMargin:formatUnits(mark>0n?feeUnits(notionalUnits(size,mark),MAINTENANCE_BPS):0n,USDT_DECIMALS)}];
    }));
    let stakingValue=BigInt(user.staking.principalUnits)+BigInt(user.staking.rewardUnits);
    const aStakedPrincipal=(database.listATokenStakes?.(address)||[]).reduce((sum,stake)=>sum+splitStakePayment(stake,stake.totalEarnedUnits).outstanding,0n);
    const internalStrategyValue=Object.values(user.internalStrategies||{}).filter(strategy=>strategy?.running).reduce((sum,strategy)=>{
      const strategySymbol=marketSymbol(strategy?.config?.symbol||'BTC');
      const liveMark=BigInt(Math.round(Number(prices[strategySymbol]||0)*1e6));
      const mark=liveMark>0n?liveMark:BigInt(strategy?.lastPriceUnits||'0');
      return sum+BigInt(strategy?.cashUnits||'0')+(mark>0n?BigInt(strategy?.inventoryUnits||'0')*mark/10n**BigInt(ASSET_DECIMALS):0n);
    },0n);
    marginUsed+=frozenPerpUsdt;
    // A 币行：可用 = A 钱包余额；冻结中 = OPEN 卖单锁定（含手续费冻结）
    // AIX 现货归入现货市值，尚未返还的质押本金归入质押市值；总资产只汇总一次。
    try {
      const aBalanceUnits=BigInt(walletService.balanceUnits(address,'A')||'0');
      spot.A=formatUnits(aBalanceUnits,A_DECIMALS);
      spotFrozen.A=formatUnits(aLockedA,A_DECIMALS);
      if (aTokenPriceProvider) {
        const aPrice=BigInt(aTokenPriceProvider()||0n);
        if (aPrice>0n) {
          if (aBalanceUnits>0n) spotValue+=aBalanceUnits*aPrice/(10n**BigInt(A_DECIMALS));
          if (aLockedA>0n) spotValue+=aLockedA*aPrice/(10n**BigInt(A_DECIMALS));
          if (aStakedPrincipal>0n) stakingValue+=aStakedPrincipal*aPrice/(10n**BigInt(A_DECIMALS));
        }
      }
    } catch {}
    const totalEquity=freeUsdt+frozenUsdt+spotValue+BigInt(user.strategyBalanceUnits)+internalStrategyValue+stakingValue+positionEquity;
    const collateralEquity=freeUsdt+frozenPerpUsdt+positionEquity;
    const marginUsage=collateralEquity>0n?Number(marginUsed*1_000_000n/collateralEquity)/1_000_000:0;
    const symbol=marketSymbol(selectedSymbol);
    const fills=database.platformRecords('fills',address,{limit:1000}).map(item=>({...item,size:formatUnits(item.sizeUnits,ASSET_DECIMALS),price:formatUnits(item.priceUnits,PRICE_DECIMALS),fee:formatUnits(item.feeUnits,USDT_DECIMALS),pnl:formatUnits(item.pnlUnits,USDT_DECIMALS),netPnl:formatUnits(BigInt(item.pnlUnits||'0')-BigInt(item.feeUnits||'0'),USDT_DECIMALS)}));
    const orderRecords=database.platformRecords('orders',address,{limit:1000});
    const orderClientIds=new Set(orderRecords.map(item=>String(item.clientOrderId||'')).filter(Boolean));
    const fillByClientId=new Map(fills.filter(fill=>fill.clientOrderId).map(fill=>[String(fill.clientOrderId),fill]));
    const limitHistory=orderRecords.filter(item=>item.status!=='open').map(item=>{
      const order=presentOrder(item),fill=fillByClientId.get(String(item.clientOrderId||''));
      return fill?{...order,price:fill.price,fee:fill.fee,pnl:fill.pnl,netPnl:fill.netPnl,filledAt:fill.createdAt}:order;
    });
    const marketHistory=fills.filter(fill=>!fill.clientOrderId||!orderClientIds.has(String(fill.clientOrderId))).map(fill=>({
      id:fill.id,clientOrderId:fill.clientOrderId||'',symbol:fill.symbol,product:fill.product,side:fill.side,
      type:fill.liquidation?'liquidation':'market',status:'filled',size:fill.size,price:fill.price,
      limitPrice:fill.price,fee:fill.fee,pnl:fill.pnl,netPnl:fill.netPnl,reduceOnly:Boolean(fill.reduceOnly),
      liquidation:Boolean(fill.liquidation),createdAt:fill.createdAt,filledAt:fill.createdAt,
    }));
    const orderHistory=[...limitHistory,...marketHistory]
      .sort((left,right)=>(Date.parse(right.createdAt)||0)-(Date.parse(left.createdAt)||0)).slice(0,100);
    const auditHistory=database.platformRecords('audit_log',address,{limit:1000});
    const capitalHistory = [
      ...fills.map(fill => ({
        id: fill.id,
        createdAt: fill.createdAt,
        type: fill.liquidation ? 'liquidation' : (fill.product === 'spot' ? 'spot_trade' : 'perp_trade'),
        symbol: fill.symbol,
        side: fill.side,
        size: fill.size,
        price: fill.price,
        fee: fill.fee,
        pnl: fill.pnl,
        netPnl: fill.netPnl,
        liquidation: Boolean(fill.liquidation),
      })),
      ...auditHistory
        .filter(item => ['funding', 'stake', 'unstake', 'strategy_balance_consolidated', 'internal_strategy_settle'].includes(item.type))
        .map(item => ({
          id: item.id || `audit_${item.sequence || item.createdAt}`,
          createdAt: item.createdAt,
          type: item.type,
          symbol: item.symbol || 'USDT',
          amount: formatUnits(item.amountUnits == null ? (item.rewardUnits || item.settlementUnits || item.capitalUnits || '0') : item.amountUnits, USDT_DECIMALS),
          reason: item.reason || '',
        })),
      ...database.listAiRewards(address, 5000)
        .filter(item => item.kind === 'start' || item.kind === 'redeem')
        .map(item => ({
          id: item.id,
          createdAt: item.createdAt,
          type: item.kind === 'start' ? 'ai_copy_start' : 'ai_copy_redeem',
          symbol: 'USDT',
          amount: formatUnits(BigInt(item.amountUnits || '0'), USDT_DECIMALS),
          reason: item.kind === 'start' ? '加入跟单，扣除 USDT' : '提前赎回，返还 USDT',
        })),
      // AIX 代币交易成交（含互转外的买卖流水），让资金记录覆盖 AIX 生态
      ...database.listATokenTradesByWallet(address, 2000)
        .filter(item => item && item.id)
        .map(item => ({
          id: item.id,
          createdAt: new Date(Number(item.createdAt)).toISOString(),
          type: 'aix_trade',
          symbol: 'AIX',
          side: item.side,
          size: formatUnits(BigInt(item.sizeUnits || '0'), A_DECIMALS),
          price: formatUnits(BigInt(item.priceUsdtUnits || '0'), USDT_DECIMALS),
          fee: formatUnits(BigInt(item.feeUnits || '0'), A_DECIMALS),
          amount: formatUnits(BigInt(item.amountUsdtUnits || '0'), USDT_DECIMALS),
          pnl: null,
          liquidation: false,
        })),
      // 抽奖中奖的资产类奖品（BTC/ETH/BNB/USDT/AIX），让资金流水覆盖抽奖发放
      ...database.listLotteryWins(address, 500)
        .filter(item => item && item.prizeType === 'crypto' && Number(item.amount) > 0)
        .map(item => ({
          id: item.id,
          createdAt: new Date(Number(item.createdAt)).toISOString(),
          type: 'lottery_win',
          symbol: item.symbol === 'USDT' ? '' : String(item.symbol || ''),
          side: null,
          size: String(item.amount),
          price: null,
          fee: '0',
          pnl: null,
          liquidation: false,
          amount: Number(item.valueUsdt || 0).toFixed(2),
        })),
      // 链上充值：已确认到账的计入流水（确认中/已拒绝/已过期在“充值记录”表单独展示，避免与余额变动对不上）
      ...database.walletRecords('deposits', { wallet:address, status:'confirmed', limit:1000 })
        .filter(item => item && BigInt(item.amountUnits || '0') > 0n)
        .map(item => {
          const decimals = { ...WALLET_ASSET_DECIMALS, A:A_DECIMALS }[String(item.asset || 'USDT').toUpperCase()] ?? USDT_DECIMALS;
          const value = formatUnits(BigInt(item.amountUnits), decimals);
          return {
            id: item.id,
            createdAt: item.confirmedAt || item.createdAt,
            type: 'deposit',
            symbol: String(item.asset || 'USDT'),
            side: null,
            size: value,
            price: null,
            fee: '0',
            pnl: null,
            netPnl: null,
            liquidation: false,
            amount: value,
            status: 'confirmed',
            network: item.network || '',
          };
        }),
      // 链上提现：全部申请单都展示（处理中/已到账/失败/已退回），与“提现记录”表口径一致
      ...database.walletRecords('withdrawals', { wallet:address, limit:1000 })
        .filter(item => item && BigInt(item.amountUnits || '0') > 0n)
        .map(item => {
          const decimals = { ...WALLET_ASSET_DECIMALS, A:A_DECIMALS }[String(item.asset || 'USDT').toUpperCase()] ?? USDT_DECIMALS;
          const value = formatUnits(BigInt(item.amountUnits), decimals);
          return {
            id: item.id,
            createdAt: item.createdAt,
            type: 'withdrawal',
            symbol: String(item.asset || 'USDT'),
            side: null,
            size: value,
            price: null,
            fee: '0',
            pnl: null,
            netPnl: null,
            liquidation: false,
            amount: value,
            status: item.status || '',
            network: item.network || '',
          };
        }),
    ].sort((left, right) => (Date.parse(right.createdAt) || 0) - (Date.parse(left.createdAt) || 0)).slice(0, 1000);
    return { account:{availableMargin:formatUnits(freeUsdt,USDT_DECIMALS),totalEquity:formatUnits(totalEquity,USDT_DECIMALS),collateralEquity:formatUnits(collateralEquity,USDT_DECIMALS),positionEquity:formatUnits(positionEquity,USDT_DECIMALS),marginUsed:formatUnits(marginUsed,USDT_DECIMALS),marginUsage,reservedUsdt:formatUnits(frozenUsdt,USDT_DECIMALS),spotValue:formatUnits(spotValue,USDT_DECIMALS),strategyValue:formatUnits(BigInt(user.strategyBalanceUnits)+internalStrategyValue,USDT_DECIMALS),stakingValue:formatUnits(stakingValue,USDT_DECIMALS)}, spot, spotFrozen, perps, perp:perps[symbol], strategy:{balance:formatUnits(user.strategyBalanceUnits,USDT_DECIMALS)}, staking:{principal:formatUnits(user.staking.principalUnits,USDT_DECIMALS),rewards:formatUnits(user.staking.rewardUnits,USDT_DECIMALS),apy:STAKING_APY}, orders:openOrders.map(presentOrder), orderHistory, fills, capitalHistory, risk:{insuranceFund:formatUnits(state.insuranceFundUnits,USDT_DECIMALS),badDebt:formatUnits(state.badDebtUnits,USDT_DECIMALS),fundingRate:Number(FUNDING_BPS_PER_INTERVAL)/10000,fundingIntervalMs:FUNDING_INTERVAL_MS,nextFundingAt:Number(state.lastFundingAtBySymbol[symbol] || state.lastFundingAt)+FUNDING_INTERVAL_MS}, audit:auditHistory };
  }
  function findExecution(address, clientOrderId, requestHash) {
    const key = addressKey(address);
    const matchesAddress = item => String(item.address || '').toLowerCase() === key;
    const existing = database.findExecution(address, clientOrderId)
      || state.orders.find(item => matchesAddress(item) && item.clientOrderId === clientOrderId)
      || state.fills.find(item => matchesAddress(item) && item.clientOrderId === clientOrderId);
    if (!existing) return null;
    if (!existing.requestHash || existing.requestHash !== requestHash) {
      throw Object.assign(new Error('该请求编号已用于另一笔订单'), { code:'IDEMPOTENCY_CONFLICT', statusCode:409 });
    }
    return existing.id.startsWith('ord_') ? { order:existing } : { fill:existing };
  }
  function systemStatus() {
    return {
      settlement:'internal',
      accounts:Object.keys(state.accounts).length,
      openOrders:state.orders.filter(item => item.status === 'open').length,
      openPositions:Object.values(state.accounts).reduce((count,user)=>count+Object.values(user?.perps||{}).filter(pos=>BigInt(pos?.sizeUnits||'0')!==0n).length,0),
      fills:state.fills.length,
      insuranceFund:formatUnits(state.insuranceFundUnits, USDT_DECIMALS),
      badDebt:formatUnits(state.badDebtUnits, USDT_DECIMALS),
      lastFundingAt:new Date(state.lastFundingAt).toISOString(),
    };
  }
  function earningsLeaderboard({ limit = 100, address = '', markPrices = {} } = {}) {
    const cutoff = Date.now() - 30 * 24 * 60 * 60_000;
    // AI 托管的收益不会走到 internalStrategies 真实交易结算，realizedPnlUnits 里会把「奖励发放+本金回退+手续费退补」
    // 混在一起当"已实现利润"，而 ai_managed_rewards 表会单独记录每笔真正发放的奖励。
    // 为避免一笔收益被计数 2 次 (strategyUnits + aiManagedUnits)，这里排除所有 key 以 "ai-managed" 开头的内部策略；
    // 只保留真实网格/趋势/策略 引擎的 realizedPnl。
    const isAiManagedStrategy = key => typeof key === 'string' && (key === 'ai-managed' || key.startsWith('ai-managed-'));
    const itemTime = item => Number(item?.t || 0) || Date.parse(item?.createdAt || '') || Number(item?.createdAt || 0);
    const aPriceUsdtUnits = aTokenPriceProvider ? BigInt(aTokenPriceProvider() || 0n) : 0n;
    const aAssetToUsdt = aUnits => aPriceUsdtUnits > 0n ? (BigInt(aUnits || 0n) * aPriceUsdtUnits) / (10n ** BigInt(A_DECIMALS)) : 0n;
    const rows = Object.values(state.accounts || {}).map(user => {
      const wallet = String(user.address || '');
      const walletKey = wallet.toLowerCase();
      const sumUnits = (items, field) => items.reduce((sum, item) => sum + BigInt(item?.[field] || '0'), 0n);
      const fills = state.fills.filter(fill => String(fill.address || '').toLowerCase() === walletKey);
      const tradingUnits = sumUnits(fills, 'pnlUnits');
      const recentTrading = fills.filter(fill => itemTime(fill) >= cutoff);
      const userStrategies = Object.entries(user.internalStrategies || {}).filter(([key]) => !isAiManagedStrategy(key));
      const strategyUnits = userStrategies.reduce((sum, [, item]) => sum + BigInt(item?.realizedPnlUnits || '0'), 0n);
      const strategyFills = Object.entries(user.internalStrategies || {})
        .filter(([key]) => !isAiManagedStrategy(key))
        .flatMap(([, item]) => Array.isArray(item?.fills) ? item.fills : []);
      const recentStrategyFills = strategyFills.filter(fill => itemTime(fill) >= cutoff);
      const recentStrategyUnits = recentStrategyFills.reduce((sum, fill) => (
        sum + BigInt(fill.realizedPnlUnits || parseUnits(String(fill.realizedPnl || 0), USDT_DECIMALS))
      ), 0n);
      const stakingUnits = BigInt(user.staking?.rewardUnits || '0');
      // 旧口径：只要 staking.updatedAt 在 30d 内就把"全部"累计质押奖励当成 30D 收益 —— 明显多算。
      // 新口径：从 wallet 层的质押 reward 记录 (audit_log / 结算 history) 取近 30 天实际发放；如果没有 history，
      // 则用一个保守估计：只计最近 30d settlement (这里 staking.rewardUnits 本身是全量累计，所以用增量近似 0 不现实)
      // → 兜底用 audit_log 里 type=stake rewardUnits >= cutoff 算
      const stakeAuditRows = database.platformRecords('audit_log', wallet, { limit:5000 })
        .filter(row => row && row.type === 'staking_reward');
      const stakingAccumulatedUnits = stakeAuditRows.reduce((sum, row) => sum + BigInt(row?.rewardUnits || 0), 0n);
      const stakingHistoryBaseline30 = stakeAuditRows.filter(row => itemTime(row) < cutoff)
        .reduce((sum, row) => sum + BigInt(row?.rewardUnits || 0), 0n);
      const recentStakingUnits = stakingAccumulatedUnits > 0n
        ? (stakingAccumulatedUnits - stakingHistoryBaseline30 > 0n ? stakingAccumulatedUnits - stakingHistoryBaseline30 : 0n)
        : (Number(user.staking?.updatedAt || 0) >= cutoff ? stakingUnits : 0n); // fallback

      const aiManagedRewards = database.listAiRewards(wallet, 5000).filter(item => item.kind !== 'referral' && item.kind !== 'loss' && item.kind !== 'start' && item.kind !== 'redeem' && item.kind !== 'adjust');
      const aiManagedUnitsRewarded = aiManagedRewards.reduce((sum, item) => sum + BigInt(item.amountUnits || '0'), 0n);
      const aiManagedPendingUnits = (() => {
        let total = 0n;
        for (const [key, strategy] of Object.entries(user.internalStrategies || {})) {
          if (!isAiManagedStrategy(key)) continue;
          total += BigInt(strategy?.totalEarnedUnits || '0');
        }
        // 兼容：ai-managed.totalEarnedUnits 含 pending 今日部分（新代码每 slot 立即 credit，所以大部分时候差为 0；
        // 但服务器刚重启/定时器 tick 60s 空档期内可能差几百块 pending，这里取 max 保证不丢 earned）
        return total > aiManagedUnitsRewarded ? total - aiManagedUnitsRewarded : 0n;
      })();
      const aiManagedUnits = aiManagedUnitsRewarded + aiManagedPendingUnits;
      const recentAiManagedRewarded = aiManagedRewards.filter(item => itemTime(item) >= cutoff)
        .reduce((sum, item) => sum + BigInt(item.amountUnits || '0'), 0n);
      // 30d pending：totalEarnedUnits 30d 增量 − rewarded 30d 增量（同样兜底服务器空档）
      const recentAiManagedPending = (() => {
        // 简化：只算所有策略 batches 中 startedAt >= cutoff 的奖励增量（不精确但足够保护空档期当日收益）
        let p = 0n;
        for (const [key, strategy] of Object.entries(user.internalStrategies || {})) {
          if (!isAiManagedStrategy(key)) continue;
          for (const batch of Array.isArray(strategy?.batches) ? strategy.batches : []) {
            // 如果 batch.dayStartAt >= cutoff，dayEarnedUnits 就是 30d 内新产生但可能还没 tick 到 credit
            if (Number(batch?.dayStartAt || 0) >= cutoff) p += BigInt(batch?.dayEarnedUnits || '0');
          }
        }
        return p > recentAiManagedRewarded ? p - recentAiManagedRewarded : 0n;
      })();
      const recentAiManagedUnits = recentAiManagedRewarded + recentAiManagedPending;
      const referralRewards = database.listReferralRewards(wallet, 5000);
      const referralUnits = referralRewards.reduce((sum, item) => sum + BigInt(item.amountUnits || '0'), 0n);
      const recentReferralUnits = referralRewards.filter(item => itemTime(item) >= cutoff)
        .reduce((sum, item) => sum + BigInt(item.amountUnits || '0'), 0n);

      // A 币生态两大收益：矿机释放(A units) + 质押奖励(A units)，按 A 币现价折算 USDT 计入「累计赚取」
      const aMinerReleases = database.listATokenMinerReleases(wallet, 5000);
      const aMinerUnitsA = aMinerReleases.reduce((sum, item) => sum + BigInt(item?.amountUnits || '0'), 0n);
      const aMiner30UnitsA = aMinerReleases.filter(item => Number(item?.releasedAt || 0) >= cutoff)
        .reduce((sum, item) => sum + BigInt(item?.amountUnits || '0'), 0n);
      const aStakeRewards = database.listATokenStakeRewards(wallet, 5000);
      const aStakeUnitsA = aStakeRewards.reduce((sum, item) => sum + BigInt(item?.amountUnits || '0'), 0n);
      const aStake30UnitsA = aStakeRewards.filter(item => Number(item?.settledAt || 0) >= cutoff)
        .reduce((sum, item) => sum + BigInt(item?.amountUnits || '0'), 0n);
      const aMinerUnits = aAssetToUsdt(aMinerUnitsA);
      const aMiner30Units = aAssetToUsdt(aMiner30UnitsA);
      const aStakeUnits = aAssetToUsdt(aStakeUnitsA);
      const aStake30Units = aAssetToUsdt(aStake30UnitsA);

      const earnedUnits = tradingUnits + strategyUnits + stakingUnits + aiManagedUnits + referralUnits + aMinerUnits + aStakeUnits;
      const earned30Units = (
        sumUnits(recentTrading, 'pnlUnits') + recentStrategyUnits + recentStakingUnits
        + recentAiManagedUnits + recentReferralUnits + aMiner30Units + aStake30Units
      );
      // 30D 交易量 = 近 30 天合约（perpetual）成交名义价值累加（期货标准定义）。
      // 组成部分：
      //   (1) 真实合约 fills：state.fills 里 product='perp' 的单笔名义 size*price；
      //   (2) 非 AI 托管策略引擎 fills：strategyFills 里 product='perp' 的名义；
      //   (3) AI 托管模拟合约：internalStrategies.ai-managed-*.records (72 分钟/笔 simulated-grid)
      //       只取 notional（= 开仓名义 = size*openPrice 由 executionDetails 生成，ASSET_DECIMALS 口径），
      //       严格不用 profitUnits/reward，避免"收益=交易量"老 bug 再出现。
      const perpFills30d = state.fills.filter(fill => String(fill.address || '').toLowerCase() === walletKey
        && itemTime(fill) >= cutoff
        && String(fill.product || 'perp').toLowerCase() === 'perp');
      const strategyPerpFills30d = strategyFills.filter(fill => itemTime(fill) >= cutoff
        && String(fill.product || '').toLowerCase() === 'perp');
      const perpVolume = perpFills30d.reduce((sum, fill) => (
        sum + BigInt(fill.notionalUnits || notionalUnits(BigInt(fill.sizeUnits || '0'), BigInt(fill.priceUnits || '0')))
      ), 0n) + strategyPerpFills30d.reduce((sum, fill) => (
        sum + BigInt(fill.notionalUnits || notionalUnits(BigInt(fill.sizeUnits || '0'), BigInt(fill.priceUnits || '0')))
      ), 0n);
      const aiManagedPerpVolume30d = (() => {
        let v = 0n;
        for (const [key, strategy] of Object.entries(user.internalStrategies || {})) {
          if (!isAiManagedStrategy(key)) continue;
          const records = Array.isArray(strategy?.records) ? strategy.records : [];
          for (const record of records) {
            const t = Number(record?.slotAt || record?.t || 0) || Date.parse(record?.createdAt || '');
            if (t < cutoff) continue;
            // AI 托管 executionDetails.notional 是 JS Number(= USDT 小数)，转 units 时用 parseUnits 6 位兜底。
            // 如果 record 里有 notionalUnits（新字段）就优先 BigInt，否则 Math.abs 是因为价格计算出的 notional 恒正。
            const nUnits = BigInt(record?.notionalUnits || '0');
            if (nUnits > 0n) { v += nUnits; continue; }
            const n = Number(record?.notional || 0);
            if (n > 0) {
              try { v += BigInt(parseUnits(n.toFixed(USDT_DECIMALS), USDT_DECIMALS).toString()); } catch { /* ignore precision odd */ }
            }
          }
        }
        return v;
      })();
      const tradingVolume30Units = perpVolume + aiManagedPerpVolume30d;
      const depositedUnits = database.walletRecords('deposits', { wallet, status:'confirmed', limit:1000 })
        .reduce((sum, item) => sum + BigInt(item.amountUnits || '0'), 0n);
      // 后台测试金/赠送金（admin_test_credit）也算本金投入，避免用户靠赠金跑合约时 ROI 分母为 0 走 10 USDT 兜底导致 1099% 失真
      const adminCreditUnits = (database.listBalanceAdjustmentsByWallet?.(wallet, { type:'admin_test_credit', limit:5000 }) || [])
        .reduce((sum, item) => sum + BigInt(item.amountUnits || '0'), 0n);
      // 本金投入估算：充值美元 + 后台赠送金 + 全部策略（含 ai-managed）本金 + 质押本金
      // 注：ai-managed 虽然 realizedPnl 不进 earned 避免重复，但它的 capitalUnits 是用户真金白银转入的本金，
      // 必须算进 ROI 分母，否则会除以 1 USDT 兜底（144000%）严重失真。
      const nowMs = Date.now();
      const allStrategies = Object.entries(user.internalStrategies || {});
      let strategyPrincipalUnits = 0n;
      for (const [key, item] of allStrategies) {
        if (isAiManagedStrategy(key)) {
          const batches = Array.isArray(item?.batches) ? item.batches : [];
          if (batches.length) {
            // 分母必须覆盖窗口期内「曾在跑」的批次：批次在 30 天内赎回后，其收益仍留在分子里，
            // 若分母只算当前在投本金（capitalUnits=0），ROI 会炸成几千%（如 2537U 收益 / 10U 兜底）。
            // 批次与窗口 [cutoff, now] 有重叠即计入本金（保守口径：整段本金都算，ROI 只会略低估）。
            for (const b of batches) {
              const start = Number(b?.startedAt || 0);
              const end = b?.status === 'active' ? nowMs : Number(b?.redeemedAt || b?.expiresAt || start);
              if (start <= nowMs && end >= cutoff) strategyPrincipalUnits += BigInt(b?.principalUnits || '0');
            }
          } else {
            strategyPrincipalUnits += BigInt(item?.capitalUnits || item?.principalUnits || '0');
          }
        } else {
          strategyPrincipalUnits += BigInt(item?.capitalUnits || item?.principalUnits || '0');
        }
      }
      const stakingPrincipalUnits = BigInt(user.staking?.principalUnits || '0');
      // A 币矿机+质押本金（钱包激活/矿机购买/质押时的平台内部入账），折算 USDT
      const aMinerPrincipalUnitsA = database.listATokenMiners(wallet)
        .reduce((sum, item) => sum + BigInt(item?.totalUnits || '0'), 0n);
      const aStakePrincipalUnitsA = database.listATokenStakes(wallet)
        .reduce((sum, item) => sum + BigInt(item?.principalUnits || '0'), 0n);
      const aPrincipalUnits = aAssetToUsdt(aMinerPrincipalUnitsA + aStakePrincipalUnitsA);
      // 合约持仓保证金：当前所有 perp 仓位的 marginUnits 之和（用户实际占用的合约保证金）
      const perpMarginUnits = Object.values(user.perps || {})
        .reduce((sum, pos) => sum + BigInt(pos?.marginUnits || '0'), 0n);
      const capitalBasisUnits = depositedUnits + adminCreditUnits + strategyPrincipalUnits + stakingPrincipalUnits + aPrincipalUnits + perpMarginUnits;
      // ROI = 30D 投资收益 / 投入本金。分母若低于 10 USDT 兜底 10 USDT，避免除 0 或杠杆用户 ROI 爆炸。
      const roiBasisUnits = capitalBasisUnits > 10_000_000n ? capitalBasisUnits : 10_000_000n;
      // 分子不含直推分润：推广佣金是渠道收入、与自有本金投入无关，纯推广用户没有本金口径，
      // 计入会出现 77U 佣金 / 10U 兜底 = 770% 的失真收益率（佣金仍计入 earned30d 收益榜）。
      const roiEarned30Units = earned30Units - recentReferralUnits;
      const roi30d = Number(formatUnits(roiEarned30Units, USDT_DECIMALS)) / Number(formatUnits(roiBasisUnits, USDT_DECIMALS)) * 100;
      // 合约风云榜专用口径：只算合约跟单（AI 托管）的收益和投入本金
      //   - 分子 = AI 跟单收益（已排除 referral/loss/start/redeem/adjust，不含推荐佣金、手续费返佣）
      //   - 分母 = AI 跟单批次本金（窗口期内曾在跑的批次，含已赎回）；分母兜底 10 USDT
      //   - 交易量 = AI 跟单模拟合约名义价值（不含现货/真实合约）
      const copyEarnedUnits = aiManagedUnits;
      const copyEarned30Units = recentAiManagedUnits;
      const copyPrincipalUnits = strategyPrincipalUnits;
      const copyVolume30Units = aiManagedPerpVolume30d;
      const copyRoiBasisUnits = copyPrincipalUnits > 10_000_000n ? copyPrincipalUnits : 10_000_000n;
      const copyRoi30d = Number(formatUnits(copyEarned30Units, USDT_DECIMALS)) / Number(formatUnits(copyRoiBasisUnits, USDT_DECIMALS)) * 100;
      return {
        wallet, earnedUnits, tradingUnits, strategyUnits, stakingUnits, aiManagedUnits, referralUnits,
        aMinerUnits, aStakeUnits,
        earned30Units, tradingVolume30Units, depositedUnits, roi30d,
        copyEarnedUnits, copyEarned30Units, copyPrincipalUnits, copyVolume30Units, copyRoi30d,
      };
    }).filter(item => item.copyEarnedUnits > 0n)
      .sort((a, b) => a.copyEarnedUnits === b.copyEarnedUnits ? a.wallet.localeCompare(b.wallet) : a.copyEarnedUnits > b.copyEarnedUnits ? -1 : 1);
    const bounded = Math.min(Math.max(Number(limit) || 100, 1), 500);
    const items = rows.slice(0, bounded).map((item, index) => ({
      rank:index + 1,
      address:item.wallet,
      shortAddress:`${item.wallet.slice(0, 6)}…${item.wallet.slice(-4)}`,
      isCurrent:Boolean(address) && item.wallet.toLowerCase() === String(address).toLowerCase(),
      // 合约风云榜口径：只展示合约跟单的收益/本金/ROI/交易量
      earned:formatUnits(item.copyEarnedUnits, USDT_DECIMALS),
      deposited:formatUnits(item.copyPrincipalUnits, USDT_DECIMALS),
      earned30d:formatUnits(item.copyEarned30Units, USDT_DECIMALS),
      roi30d:Number.isFinite(item.copyRoi30d) ? item.copyRoi30d.toFixed(2) : '0.00',
      volume30d:formatUnits(item.copyVolume30Units, USDT_DECIMALS),
      // 原始全口径字段保留供后台/调试
      trading:formatUnits(item.tradingUnits, USDT_DECIMALS),
      strategy:formatUnits(item.strategyUnits, USDT_DECIMALS),
      staking:formatUnits(item.stakingUnits, USDT_DECIMALS),
      aiManaged:formatUnits(item.aiManagedUnits, USDT_DECIMALS),
      referral:formatUnits(item.referralUnits, USDT_DECIMALS),
      aMiner:formatUnits(item.aMinerUnits, USDT_DECIMALS),
      aStake:formatUnits(item.aStakeUnits, USDT_DECIMALS),
    }));
    return { items, total:rows.length, current:items.find(item => item.isCurrent) || null };
  }
  return {
    database,
    setATokenPriceProvider: (fn) => { aTokenPriceProvider = typeof fn === 'function' ? fn : null; },
    // 暴露 AIX 现价（USDT 浮点数，6 位精度）给 API 层，用于资产页 marketPrices.A 折算 AIX 市值
    aTokenSpotPrice: () => { try { const v = aTokenPriceProvider ? BigInt(aTokenPriceProvider() || 0n) : 0n; return Number(formatUnits(v, USDT_DECIMALS)); } catch { return 0; } },
    addToInternalStrategy:(...args) => transact(() => addToInternalStrategy(...args)),
    cancelOrder:(...args) => transact(() => cancelOrder(...args)),
    findExecution,
    perpTrade:(...args) => transact(() => perpTrade(...args)),
    placeOrder:(...args) => transact(() => placeOrder(...args)),
    processMarkPrice:(...args) => transact(() => processMarkPrice(...args)),
    setReferralService,
    setPointsService,
    profile,
    consolidateStrategyBalances:(...args) => transact(() => consolidateStrategyBalances(...args)),
    internalStrategyAccounts,
    internalStrategyState,
    earningsLeaderboard,
    settleInternalStrategy:(...args) => transact(() => settleInternalStrategy(...args)),
    startInternalStrategy:(...args) => transact(() => startInternalStrategy(...args)),
    spotTrade:(...args) => transact(() => spotTrade(...args)),
    creditSpot:(...args) => transact(() => creditSpot(...args)),
    stake:(...args) => transact(() => stake(...args)),
    systemStatus,
    updateInternalStrategy:(...args) => transact(() => updateInternalStrategy(...args)),
    unstake:(...args) => transact(() => unstake(...args)),
  };
}
