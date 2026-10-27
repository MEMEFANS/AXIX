import crypto from 'node:crypto';
import { formatUnits } from 'ethers';

const USDT_DECIMALS = 6;
const codeFor = address => crypto.createHash('sha256').update(String(address).toLowerCase()).digest('hex').slice(0, 10).toUpperCase();
const key = value => String(value || '').toLowerCase();
const short = value => `${String(value).slice(0, 6)}...${String(value).slice(-4)}`;
// 统一用户ID字符集（与 a-token-service 的 8 位用户ID一致，去掉易混字符 0/O/1/I）
const ID_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function createReferralService({ database, walletService }) {
  // ── 推荐关系缓存（2026-10-22 全站卡顿修复）──
  // 旧实现 links() 每次调用都全表扫 platform_referral_links（2.3 万行、逐行 JSON.parse）：
  // referral profile 一次请求要扫 (2+直推数) 遍，AIX 卖单/互转的费率阶梯也每笔全扫一遍，
  // keccak 修复后这里是全站 CPU 最大的热点（实测 profile 中占主线程 20~34%）。
  // 借鉴 a-token-team-service 的链图缓存：15s TTL 内存 map，任何 upsert 后立即失效。
  // 代价：新绑定的推荐关系最多 15s 后对统计/费率可见；绑定写库本身即时生效，不影响绑定正确性。
  const LINKS_TTL_MS = 15_000;
  let _linkRows = null, _linksByWallet = null, _linksByChild = null, _linksByCode = null, _linksAt = 0;
  function linksMaps() {
    const now = Date.now();
    if (_linksByWallet && now - _linksAt < LINKS_TTL_MS) {
      return { list: _linkRows, byWallet: _linksByWallet, byChild: _linksByChild, byCode: _linksByCode };
    }
    const rows = database.listReferralLinks();
    _linkRows = rows;
    _linksByWallet = new Map();
    _linksByChild = new Map();
    _linksByCode = new Map();
    for (const item of rows) {
      const w = key(item.wallet);
      if (!_linksByWallet.has(w)) _linksByWallet.set(w, item); // 首个优先，与旧 find() 语义一致
      if (item.code && !_linksByCode.has(item.code)) _linksByCode.set(item.code, item);
      const p = key(item.referrerWallet);
      if (p) {
        let arr = _linksByChild.get(p);
        if (!arr) { arr = []; _linksByChild.set(p, arr); }
        arr.push(item);
      }
    }
    _linksAt = now;
    return { list: _linkRows, byWallet: _linksByWallet, byChild: _linksByChild, byCode: _linksByCode };
  }
  function invalidateLinks() { _linksByWallet = null; _linksAt = 0; }
  function links() { return linksMaps().list; }
  function upsertLink(link) { const row = database.upsertReferralLink(link); invalidateLinks(); return row; }
  const byWalletOf = value => linksMaps().byWallet.get(key(value)) || null;
  function directOf(address) { return linksMaps().byChild.get(key(address)) || []; }
  // 统一用户ID：与 AIX 互转使用的 8 位用户ID同表同值，保证「邀请码 = 用户ID」
  function ensureUnifiedUserId(address) {
    const normalized = String(address || '').toLowerCase();
    try { walletService.ensureUser?.(normalized); } catch { /* 建用户失败不阻塞 */ }
    const existing = database.getATokenUserIdByWallet?.(normalized);
    if (existing?.userId) return existing.userId;
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const bytes = crypto.randomBytes(8);
      let userId = '';
      for (let i = 0; i < 8; i += 1) userId += ID_CHARS[bytes[i] % ID_CHARS.length];
      if (!database.getATokenUserId?.(userId)) {
        database.upsertATokenUserIdRow?.({ wallet: normalized, userId, createdAt: Date.now() });
        return userId;
      }
    }
    return null;
  }
  // 推荐人解析：① 现行 8 位邀请码 ② 用户ID表兜底 ③ 旧版 10 位 sha256 邀请码兼容
  function resolveReferrer(referralCode) {
    const c = String(referralCode || '').trim().toUpperCase();
    if (!c) return null;
    const byCode = linksMaps().byCode.get(c) || null;
    if (byCode) return byCode;
    const uidRow = database.getATokenUserId?.(c);
    if (uidRow?.wallet) {
      const byUid = byWalletOf(uidRow.wallet);
      if (byUid) return byUid;
    }
    return links().find(item => codeFor(item.wallet) === c) || null; // 旧版 10 位码兼容，罕见路径
  }
  function ensure(address, referralCode = '') {
    const existing = byWalletOf(address);
    const referrer = referralCode ? resolveReferrer(referralCode) : null;
    if (referrer && key(referrer.wallet) === key(address)) throw new Error('不能绑定自己的推荐链接');
    if (referrer && !existing?.referrerWallet) {
      const parents = new Map(links().map(item => [key(item.wallet), key(item.referrerWallet)]));
      const visited = new Set([key(address)]);
      let ancestor = key(referrer.wallet);
      while (ancestor) {
        if (visited.has(ancestor)) throw new Error('不能绑定下级或循环推荐关系');
        visited.add(ancestor);
        ancestor = parents.get(ancestor);
      }
    }
    const unified = ensureUnifiedUserId(address);
    // 已有记录：邀请码统一迁移为 8 位用户ID；已有推荐人保持不变，没推荐人且本次带来有效推荐码 → 补绑
    // （用户先访问过网站时其他服务会创建无推荐人的空记录，之后通过推荐链接进来仍需能绑定）
    if (existing) {
      const nextReferrer = existing.referrerWallet || referrer?.wallet || null;
      if (unified && existing.code !== unified) {
        return upsertLink({ wallet:address, code:unified, referrerWallet:nextReferrer, createdAt:existing.createdAt });
      }
      if (existing.referrerWallet || !referrer) return existing;
      return upsertLink({ wallet:address, code:existing.code, referrerWallet:referrer.wallet, createdAt:existing.createdAt });
    }
    return upsertLink({ wallet:address, code:unified || codeFor(address), referrerWallet:referrer?.wallet || null, createdAt:new Date().toISOString() });
  }
  function activePrincipal(address) {
    // 有效本金三选一即可：
    //   ① AI 合约跟单 active 批次本金（USDT，6 位精度）
    //   ② AIX 矿机运行中（active 状态，有剩余产出）
    //   ③ AIX 质押运行中（active 状态，有本金）
    const k = key(address);
    const aiSum = database.listAiBatches(address).filter(item => item.status === 'active')
      .reduce((sum, item) => sum + BigInt(item.principalUnits || '0'), 0n);
    if (aiSum > 0n) return aiSum;
    // 矿机 active 视为有效本金（取剩余产出额度，AIX 18 位精度，只需 >0n）
    const minerActive = database.listATokenMiners?.(k)
      .some(m => String(m.status) === 'active' && BigInt(m.totalUnits || '0') - BigInt(m.totalEarnedUnits || '0') > 0n);
    if (minerActive) return 1n; // 非零占位即可，validDirectCount 只看 >0
    // 质押 active 视为有效本金（取本金，AIX 18 位精度）
    const stakeActive = database.listATokenStakes?.(k)
      .filter(s => String(s.status) === 'active')
      .reduce((sum, s) => sum + BigInt(s.principalUnits || '0'), 0n);
    if (stakeActive > 0n) return stakeActive;
    return 0n;
  }
  // directOf 已上移至链接缓存区（linksMaps().byChild，避免每笔卖单/互转全表扫）
  // 代理后台专用：返回 rootWallet 的全部下级钱包闭包（直推+间推，BFS 遍历推荐关系），小写地址 Set
  function getDownlineWallets(rootWallet) {
    const root = key(rootWallet);
    const all = links();
    const children = new Map();
    for (const item of all) {
      const parent = key(item.referrerWallet);
      if (!parent) continue;
      if (!children.has(parent)) children.set(parent, []);
      children.get(parent).push(key(item.wallet));
    }
    const visited = new Set();
    const queue = [root];
    visited.add(root);
    while (queue.length) {
      const cur = queue.shift();
      for (const child of children.get(cur) || []) {
        if (visited.has(child)) continue; // 防循环推荐
        visited.add(child);
        queue.push(child);
      }
    }
    visited.delete(root); // 不含自己
    return visited;
  }
  function validDirectCount(address) { return directOf(address).filter(item => activePrincipal(item.wallet) > 0n).length; }
  // 阶梯费率专用：只算「有效直推」——矿机运行中（active 且有剩余产出）或质押运行中（active 且有本金）。
  // 矿机到期/产出完毕且没有质押 AIX 的直推不再计入，上级手续费阶梯随之回落（费率回升）
  function minerDirectCount(address) {
    return directOf(address).filter(item => {
      const w = key(item.wallet);
      const minerActive = (database.listATokenMiners?.(w) || [])
        .some(m => String(m.status) === 'active' && BigInt(m.totalUnits || '0') - BigInt(m.totalEarnedUnits || '0') > 0n);
      if (minerActive) return true;
      return (database.listATokenStakes?.(w) || [])
        .some(s => String(s.status) === 'active' && BigInt(s.principalUnits || '0') > 0n);
    }).length;
  }
  // AI 合约跟单推荐奖励：仅 1 代直推，固定 10%，不再有间推/阶梯
  const DIRECT_RATE_BPS = 1000n; // 10%
  const directRateBps = () => DIRECT_RATE_BPS;
  const indirectRateBps = () => 0n;
  function presentRow(item, level, owner) {
    const principal = activePrincipal(item.wallet);
    // 「跟单金额」只统计 AI 合约跟单 active 批次本金（USDT，6 位）。
    // activePrincipal 混合了 AIX 质押(18 位)/矿机，仅用于下方有效判定，不能按 USDT 展示，
    // 否则 8000 AIX 质押会被放大 10^12 显示成 8 千万亿 USDT。
    const aiPrincipal = database.listAiBatches(item.wallet)
      .filter(batch => batch.status === 'active')
      .reduce((sum, batch) => sum + BigInt(batch.principalUnits || '0'), 0n);
    const fills = database.platformRecords('fills', item.wallet, { limit:1000 });
    const volume = fills.reduce((sum, fill) => sum + BigInt(fill.sizeUnits || '0') * BigInt(fill.priceUnits || '0') / 100_000_000n, 0n);
    const fees = fills.reduce((sum, fill) => sum + BigInt(fill.feeUnits || '0'), 0n);
    const tradeRewards = database.listReferralRewards(owner, 5000).filter(reward => key(reward.sourceWallet) === key(item.wallet));
    const aiRewards = database.listAiRewards(owner, 5000).filter(reward => reward.kind === 'referral' && key(reward.fromWallet) === key(item.wallet));
    const rewardTotal = [...tradeRewards, ...aiRewards].filter(reward => reward.status !== 'pending').reduce((sum, reward) => sum + BigInt(reward.amountUnits || '0'), 0n);
    // 有效条件：有本金(矿机/质押/AI跟单) OR 有交易手续费(已产生返佣)
    const hasTraded = fees > 0n;
    return { address:item.wallet, shortAddress:short(item.wallet), joinedAt:item.createdAt, level, valid:principal > 0n || hasTraded,
      managedAmount:formatUnits(aiPrincipal, USDT_DECIMALS), totalVolume:formatUnits(volume, USDT_DECIMALS), totalFees:formatUnits(fees, USDT_DECIMALS), myReward:formatUnits(rewardTotal, USDT_DECIMALS) };
  }
  function profile(address) {
    const mine = ensure(address), direct = directOf(address), indirect = direct.flatMap(item => directOf(item.wallet));
    const rows = [...direct.map(item => presentRow(item, 1, address)), ...indirect.map(item => presentRow(item, 2, address))];
    const aiRewards = database.listAiRewards(address, 5000).filter(item => item.kind === 'referral');
    const tradeRewards = database.listReferralRewards(address, 5000);
    const allRewards = [...aiRewards, ...tradeRewards];
    const earned = allRewards.filter(item => item.status !== 'pending').reduce((sum, item) => sum + BigInt(item.amountUnits || '0'), 0n);
    const claimable = allRewards.filter(item => item.status === 'pending').reduce((sum, item) => sum + BigInt(item.amountUnits || '0'), 0n);
    // 有效/无效计数直接复用 presentRow 的 valid（= activePrincipal>0 || 手续费>0），
    // 不再对每个下级重复拉 fills(1000)/矿机/质押做二次判定（与旧 isEffective 结果完全一致）
    const lvl = n => rows.filter(r => r.level === n);
    return { code:mine.code, link:`/?ref=${mine.code}`, directValid:lvl(1).filter(r => r.valid).length,
      directInvalid:lvl(1).filter(r => !r.valid).length,
      indirectValid:lvl(2).filter(r => r.valid).length,
      indirectInvalid:lvl(2).filter(r => !r.valid).length,
      directRate:Number(directRateBps(address)) / 10000, indirectRate:Number(indirectRateBps(address)) / 10000,
      earned:formatUnits(earned, USDT_DECIMALS), claimable:formatUnits(claimable, USDT_DECIMALS), rows };
  }
  function distributeAiReward(userAddress, userReward, batch, slotAt) {
    const child = byWalletOf(userAddress);
    const direct = child?.referrerWallet ? byWalletOf(child.referrerWallet) : null;
    // 仅 1 代直推，固定 10%，不再有间推
    if (!direct) return;
    const rate = directRateBps();
    if (!rate) return;
    const reward = BigInt(userReward) * rate / 10000n;
    if (reward <= 0n) return;
    const rewardId = `air_ref_${batch.id}_${slotAt}_1`;
    if (database.aiRewardById?.(rewardId)) return;
    database.insertAiReward({ id:rewardId, batchId:batch.id, wallet:direct.wallet, amountUnits:reward.toString(), rewardDate:new Date(slotAt).toISOString().slice(0,10), slotAt, createdAt:slotAt, source:'platform', kind:'referral', level:1, fromWallet:userAddress, status:'pending' });
  }
  function distributeTradingFee(userAddress, feeUnits, executionId, createdAt = Date.now()) {
    const child = byWalletOf(userAddress);
    if (!child?.referrerWallet) return 0n;
    const reward = BigInt(feeUnits) / 2n;
    if (reward <= 0n) return 0n;
    const rewardId = `fee_ref_${executionId}`;
    if (database.referralRewardById(rewardId)) return 0n;
    database.insertReferralReward({ id:rewardId, recipientWallet:child.referrerWallet, sourceWallet:userAddress, kind:'trading_fee_50pct', amountUnits:reward.toString(), executionId, createdAt, source:'platform', status:'pending' });
    return reward;
  }
  function claim(address) {
    const walletUpdate = walletService.beginAtomicUpdate?.();
    try {
      let total = 0n;
      let count = 0;
      database.transaction(() => {
        const all = [
          ...database.listAiRewards(address, 5000).filter(item => item.kind === 'referral' && item.status === 'pending'),
          ...database.listReferralRewards(address, 5000).filter(item => item.status === 'pending'),
        ];
        count = all.length;
        for (const reward of all) {
          const amount = BigInt(reward.amountUnits || '0');
          if (amount <= 0n) continue;
          walletService.creditBalance(address, 'USDT', amount);
          total += amount;
          const patch = { status:'claimed', claimedAt:Date.now() };
          if (database.aiRewardById?.(reward.id)) database.updateAiReward?.(reward.id, patch);
          else database.updateReferralReward?.(reward.id, patch);
        }
        if (walletUpdate?.isDirty()) database.replaceWalletStateInside(walletUpdate.exportState());
      });
      walletUpdate?.finish();
      return { amount:formatUnits(total, USDT_DECIMALS), count };
    } catch (error) { walletUpdate?.rollback(); throw error; }
  }
  return { claim, distributeAiReward, distributeTradingFee, ensure, getDownlineWallets, profile, validDirectCount, minerDirectCount, links };
}
