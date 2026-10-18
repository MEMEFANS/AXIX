import { createAixTransaction } from './a-token-ledger.js';
import { formatUnits } from 'ethers';
import { readAixIncome, splitStakePayment, beijingDayStart } from './a-token-income.js';

const A_TOKEN_DECIMALS = 18;
const USDT_DECIMALS = 6;
const A = (n) => BigInt(n) * 10n ** BigInt(A_TOKEN_DECIMALS);

// A1-A10 等级常量：个人持有门槛 + 团队持有门槛 + 级差收益比例(bps)
const TEAM_LEVELS = [
  { level: 1,  personalHeld: 1000,    teamHeld: 5000,        rateBps: 1000, label: 'A1' },
  { level: 2,  personalHeld: 2000,    teamHeld: 10000,       rateBps: 2000, label: 'A2' },
  { level: 3,  personalHeld: 4000,    teamHeld: 50000,       rateBps: 3000, label: 'A3' },
  { level: 4,  personalHeld: 8000,    teamHeld: 100000,      rateBps: 4000, label: 'A4' },
  { level: 5,  personalHeld: 16000,   teamHeld: 500000,      rateBps: 5000, label: 'A5' },
  { level: 6,  personalHeld: 32000,   teamHeld: 1000000,     rateBps: 6000, label: 'A6' },
  { level: 7,  personalHeld: 64000,   teamHeld: 5000000,     rateBps: 7000, label: 'A7' },
  { level: 8,  personalHeld: 128000,  teamHeld: 10000000,    rateBps: 8000, label: 'A8' },
  { level: 9,  personalHeld: 256000,  teamHeld: 50000000,    rateBps: 9000, label: 'A9' },
  { level: 10, personalHeld: 500000,  teamHeld: 100000000,   rateBps: 10000, label: 'A10 享受交易手续费分红' },
];

const DIRECT_RATE_BPS = 1500n;   // 直推 15%
const INDIRECT_RATE_BPS = 1000n; // 间推 10%
const PARITY_RATE_BPS = 1000n;    // 平级 10%

export function createATokenTeamService({ database, walletService }) {
  const transaction = createAixTransaction(database, walletService);
  const k = (v) => String(v || '').toLowerCase();

  // ── 推荐链：返回 [直推人, 间推人, 三推人, ...] ──
  function getReferralChain(address) {
    const links = database.listReferralLinks();
    const chain = [];
    const start = links.find((item) => k(item.wallet) === k(address));
    let current = start;
    const visited = new Set([k(address)]);
    while (current?.referrerWallet && chain.length < 10) {
      const referrer = links.find((item) => k(item.wallet) === k(current.referrerWallet));
      if (!referrer || visited.has(k(referrer.wallet))) break;
      visited.add(k(referrer.wallet));
      chain.push(referrer.wallet);
      current = referrer;
    }
    return chain;
  }

  // ── 个人持有 A（18 decimals units, BigInt）：钱包余额 + 质押中本金 ──
  // 本人级别判定用：质押不降级别、赎回不升级别，只有真正卖出/转出 AIX 才下降
  // 2026-09-27 起矿机剩余未产出不再计入个人业绩（矿机≠持仓）；团队业绩仍保留下级矿机剩余口径
  function getPersonalHeld(address) {
    try {
      let total = walletService.balanceUnits(address, 'A');
      for (const s of database.listATokenStakes(address)) {
        if (s.status === 'active') total += splitStakePayment(s, s.totalEarnedUnits).outstanding;
      }
      return total;
    } catch { return 0n; }
  }

  // ── 下级质押中本金 + 矿机剩余未产出（18 decimals units, BigInt）──
  // 团队业绩用：下级质押本金 + 矿机剩余量；产出后递减，赎回则下降
  function getStakedPrincipal(address) {
    try {
      let total = 0n;
      for (const s of database.listATokenStakes(address)) {
        if (s.status === 'active') total += splitStakePayment(s, s.totalEarnedUnits).outstanding;
      }
      for (const m of database.listATokenMiners(address)) {
        if (m.status === 'active') {
          const remaining = BigInt(m.totalUnits || '0') - BigInt(m.totalEarnedUnits || '0');
          if (remaining > 0n) total += remaining;
        }
      }
      return total;
    } catch { return 0n; }
  }

  // ── 推荐树：referrer -> [直推...] 一次构建，供批量快照/递归复用 ──
  function buildReferralTree(links) {
    const childrenMap = new Map();
    for (const item of links) {
      const key = k(item.referrerWallet);
      if (!key) continue;
      if (!childrenMap.has(key)) childrenMap.set(key, []);
      childrenMap.get(key).push(item.wallet);
    }
    return childrenMap;
  }

  // ── 后台手动设置的「团队展示数据」（仅前端展示，绝不参与等级/费率/分润等经济计算）──
  // 虚拟会员开通矿机即视为持有对应 AIX 业绩：Mini=100 AIX、Pro=1500 AIX（与真实新矿机满额一致）
  const VIRTUAL_MINI_HOLD_UNITS = 100n * 10n ** BigInt(A_TOKEN_DECIMALS);
  const VIRTUAL_PRO_HOLD_UNITS = 1500n * 10n ** BigInt(A_TOKEN_DECIMALS);

  function planMinerWallets() {
    return {
      mini: database.listATokenMinerWalletsByPlan?.('mini120') || new Set(),
      pro: database.listATokenMinerWalletsByPlan?.('pro1500') || new Set(),
    };
  }

  // 真实团队统计：人数按去重钱包计；Mini/Pro 按矿机档位分别统计（同一人开两档则各计一次）
  function realTeamStats(address, linksArg = null) {
    const links = linksArg || database.listReferralLinks();
    const childrenMap = buildReferralTree(links);
    const { mini, pro } = planMinerWallets();
    const ak = k(address);
    const directSet = new Set((childrenMap.get(ak) || []).map(w => k(w)).filter(w => w && w !== ak));
    // 间推：直推的直推（去重，排除本人与直推）
    const indirectSet = new Set();
    for (const d of directSet) {
      for (const g of (childrenMap.get(d) || [])) {
        const gk = k(g);
        if (gk && gk !== ak && !directSet.has(gk)) indirectSet.add(gk);
      }
    }
    // 全部下级（迭代遍历；团队口径含直推，与 profile() 的 teamCount/teamMini/teamPro 一致）
    const downlines = new Set(directSet);
    const stack = [...directSet];
    while (stack.length) {
      const cur = stack.pop();
      for (const w of (childrenMap.get(cur) || [])) {
        const wk = k(w);
        if (wk && wk !== ak && !downlines.has(wk)) { downlines.add(wk); stack.push(wk); }
      }
    }
    let directMini = 0, directPro = 0, teamMini = 0, teamPro = 0;
    for (const w of directSet) {
      if (mini.has(w)) directMini += 1;
      if (pro.has(w)) directPro += 1;
    }
    for (const w of downlines) {
      if (mini.has(w)) teamMini += 1;
      if (pro.has(w)) teamPro += 1;
    }
    return {
      directCount: directSet.size, indirectCount: indirectSet.size, teamCount: downlines.size,
      directMini, directPro, teamMini, teamPro,
      directSet, indirectSet, downlines, childrenMap,
    };
  }

  // 父链：钱包(小写) -> 直推上级(小写)
  function parentMapOf(links) {
    const m = new Map();
    for (const item of links) if (item.referrerWallet) m.set(k(item.wallet), k(item.referrerWallet));
    return m;
  }

  // 计算某地址在全部展示覆盖下的叠加量：
  //   ① 本人被设置 → 本人页面各项直接叠加；
  //   ② 后代地址被设置 → 沿真实推荐链向上汇总：其虚拟团队成员/团队矿机/团队业绩计入每个真实上级，
  //      其虚拟直推仅计入它「直推上级」的间推人数。
  function virtualStatsAccrual(address, linksArg = null, context = null) {
    const rows = context?.rows || database.listATokenTeamStatsOverrides?.() || [];
    const acc = {
      dDirect: 0, dIndirect: 0, dTeam: 0,
      dDirectMini: 0, dDirectPro: 0, dTeamMini: 0, dTeamPro: 0,
      directHoldUnits: 0n, teamHoldUnits: 0n,
      directHoldUsers: 0, teamHoldUsers: 0,
      own: false,
    };
    if (!rows.length) return acc;
    const links = linksArg || database.listReferralLinks();
    const parentMap = context?.parentMap || parentMapOf(links);
    const target = k(address);
    for (const o of rows) {
      const ow = k(o.wallet);
      if (ow === target) {
        acc.own = true;
        acc.dDirect += o.dDirect;
        acc.dIndirect += o.dIndirect;
        acc.dTeam += o.dTeam;
        acc.dDirectMini += o.dDirectMini;
        acc.dDirectPro += o.dDirectPro;
        acc.dTeamMini += o.dTeamMini;
        acc.dTeamPro += o.dTeamPro;
        acc.directHoldUnits += VIRTUAL_MINI_HOLD_UNITS * BigInt(o.dDirectMini) + VIRTUAL_PRO_HOLD_UNITS * BigInt(o.dDirectPro);
        // 团队业绩口径含直推（与真实统计一致）：虚拟直推矿机同样计入本人团队业绩
        acc.teamHoldUnits += VIRTUAL_MINI_HOLD_UNITS * BigInt(o.dTeamMini + o.dDirectMini)
          + VIRTUAL_PRO_HOLD_UNITS * BigInt(o.dTeamPro + o.dDirectPro);
        acc.directHoldUsers += o.dDirectMini + o.dDirectPro;
        acc.teamHoldUsers += o.dTeamMini + o.dTeamPro + o.dDirectMini + o.dDirectPro;
        continue;
      }
      // 沿真实父链一直向上找 target（全代际，与团队人数的全量下级遍历口径一致）；
      // depth=1 表示 target 是 ow 的直推上级；seen 防止异常推荐链成环导致死循环
      let cur = parentMap.get(ow);
      let depth = 0;
      const seen = new Set([ow]);
      while (cur) {
        depth += 1;
        if (seen.has(cur)) break;
        seen.add(cur);
        if (cur === target) {
          acc.dTeam += o.dTeam;
          // 下级（无论隔几层）的虚拟直推矿机用户，对上级都是团队矿机用户
          acc.dTeamMini += o.dTeamMini + o.dDirectMini;
          acc.dTeamPro += o.dTeamPro + o.dDirectPro;
          acc.teamHoldUnits += VIRTUAL_MINI_HOLD_UNITS * BigInt(o.dTeamMini + o.dDirectMini)
            + VIRTUAL_PRO_HOLD_UNITS * BigInt(o.dTeamPro + o.dDirectPro);
          acc.teamHoldUsers += o.dTeamMini + o.dTeamPro + o.dDirectMini + o.dDirectPro;
          if (depth === 1) acc.dIndirect += o.dDirect;
          break;
        }
        cur = parentMap.get(cur);
      }
    }
    return acc;
  }

  // 后台/接口共用视图：真实值 + 生效值（真实+叠加）+ 该地址已保存的覆盖行
  function getTeamStatsView(address) {
    const links = database.listReferralLinks();
    const r = realTeamStats(address, links);
    const real = {
      directCount: r.directCount, indirectCount: r.indirectCount, teamCount: r.teamCount,
      directMini: r.directMini, directPro: r.directPro, teamMini: r.teamMini, teamPro: r.teamPro,
    };
    const acc = virtualStatsAccrual(address, links);
    // 本人被设置时，其虚拟直推矿机也属于自己的团队矿机（团队口径含直推）
    const ownDirectMini = acc.own ? acc.dDirectMini : 0;
    const ownDirectPro = acc.own ? acc.dDirectPro : 0;
    // 真实直推业绩：每个直推用户的个人持有（AIX 余额 + 质押本金 + 矿机剩余）之和，不含其下级
    let directRealHoldUnits = 0n;
    for (const w of r.directSet) {
      try { directRealHoldUnits += getPersonalHeld(w); } catch {}
    }
    const effective = {
      directCount: real.directCount + acc.dDirect,
      indirectCount: real.indirectCount + acc.dIndirect,
      teamCount: real.teamCount + acc.dTeam,
      directMini: real.directMini + acc.dDirectMini,
      directPro: real.directPro + acc.dDirectPro,
      teamMini: real.teamMini + acc.dTeamMini + ownDirectMini,
      teamPro: real.teamPro + acc.dTeamPro + ownDirectPro,
      teamHoldA: formatUnits(acc.teamHoldUnits, A_TOKEN_DECIMALS),
      directHoldA: formatUnits(acc.directHoldUnits, A_TOKEN_DECIMALS),           // 虚拟直推矿机业绩
      directRealHoldA: formatUnits(directRealHoldUnits, A_TOKEN_DECIMALS),       // 真实直推业绩
      directTotalHoldA: formatUnits(directRealHoldUnits + acc.directHoldUnits, A_TOKEN_DECIMALS), // 直推总业绩（真实+虚拟）
      statsOverridden: acc.own,
    };
    // 展示等级（仅页面展示，不写快照、不影响真实分润）：真实团队业绩 + 虚拟矿机业绩参与档位计算
    let effectiveLevel = 0;
    try {
      const levelRow = database.getATokenTeamLevel?.(address);
      const realLevel = applyFloor(calcLevel(getPersonalHeld(address), getTeamHeld(address)), levelRow?.manualLevel || 0);
      const virtualLevel = calcLevel(getPersonalHeld(address), getTeamHeld(address) + acc.teamHoldUnits);
      effectiveLevel = Math.max(realLevel, virtualLevel);
    } catch {}
    effective.level = effectiveLevel;
    const stored = database.getATokenTeamStatsOverride?.(address) || null;
    return { real, effective, stored };
  }

  // ── 团队持有：记忆化递归（每钱包质押本金查一次、子树和算一次，整体 O(n)，防环）──
  // 团队业绩 = 下级钱包 AIX 余额 + 下级 active 质押本金 + 下级 active 矿机剩余
  // 注意：active 质押本金未退回钱包，所以不会与钱包余额重复；到期后质押变 completed 不算，本金已退回钱包
  function teamHeldOf(address, childrenMap, stakedCache, walletCache, teamCache, visiting) {
    const key = k(address);
    if (teamCache.has(key)) return teamCache.get(key);
    if (visiting.has(key)) return 0n;
    visiting.add(key);
    let total = 0n;
    for (const child of childrenMap.get(key) || []) {
      const ck = k(child);
      if (!stakedCache.has(ck)) stakedCache.set(ck, getStakedPrincipal(child));
      if (!walletCache.has(ck)) {
        try { walletCache.set(ck, walletService.balanceUnits(child, 'A')); } catch { walletCache.set(ck, 0n); }
      }
      total += walletCache.get(ck);       // 下级钱包里持有的 AIX
      total += stakedCache.get(ck);       // 下级质押中的本金 + 矿机剩余
      total += teamHeldOf(child, childrenMap, stakedCache, walletCache, teamCache, visiting);
    }
    visiting.delete(key);
    teamCache.set(key, total);
    return total;
  }

  // ── 团队持有：递归累加所有下级的 A 余额 + 质押本金 + 矿机剩余 ──
  function getTeamHeld(address) {
    const childrenMap = buildReferralTree(database.listReferralLinks());
    return teamHeldOf(address, childrenMap, new Map(), new Map(), new Map(), new Set());
  }

  // ── 计算等级：个人持有 + 团队持有 都达标才能升级 ──
  function calcLevel(personalUnits, teamUnits) {
    let level = 0;
    for (let i = TEAM_LEVELS.length - 1; i >= 0; i--) {
      const t = TEAM_LEVELS[i];
      if (personalUnits >= A(t.personalHeld) && teamUnits >= A(t.teamHeld)) {
        level = t.level;
        break;
      }
    }
    return level;
  }

  // ── 快照：算等级 + 写入数据库 ──
  // manualLevel 语义=保底等级（只升不降）：实际等级取 max(自动等级, 保底等级)；
  // 持仓达标更高等级时自动升级，跌破保底时维持保底；manualLevel=0 表示完全按持仓自动计算
  function applyFloor(autoLevel, manualLevel) {
    return manualLevel > 0 ? Math.max(Number(manualLevel), autoLevel) : autoLevel;
  }
  function snapshot(address) {
    const personalUnits = getPersonalHeld(address);
    const teamUnits = getTeamHeld(address);
    const existing = database.getATokenTeamLevel?.(address);
    const manualLevel = existing?.manualLevel || 0;
    const level = applyFloor(calcLevel(personalUnits, teamUnits), manualLevel);
    const links = database.listReferralLinks();
    const directValid = links.filter(
      (item) => k(item.referrerWallet) === k(address) && getPersonalHeld(item.wallet) > 0n
    ).length;
    const now = Date.now();
    database.upsertATokenTeamLevelRow({
      wallet: address,
      level,
      personalHeldUnits: personalUnits.toString(),
      teamHeldUnits: teamUnits.toString(),
      directValidCount: directValid,
      updatedAt: now,
      manualLevel: manualLevel > 0 ? manualLevel : undefined,
    });
    // 同步 wallet_users 里的 level 字段，避免其他地方读旧值
    try { walletService?.setUserLevel?.(address, level); } catch {}
    return { wallet: address, level, personalA: Number(formatUnits(personalUnits, A_TOKEN_DECIMALS)), teamA: Number(formatUnits(teamUnits, A_TOKEN_DECIMALS)) };
  }

  // ── 全量快照：一次建树 + 记忆化递归 + 事务批量写（O(n)，不随人数平方增长）──
  // 2026-10-05 修复：加节流，防止 settleParityRewards/settleA10Pool/启动 等多处叠加调用导致 CPU 100%
  let _lastSnapshotAllAt = 0;
  const SNAPSHOT_ALL_MIN_INTERVAL = 30_000; // 全量快照最小间隔 30 秒（ snapshotAll 是 O(N)，N=2146 时约 2-3 秒）
  function snapshotAll() {
    const throttleNow = Date.now();
    if (throttleNow - _lastSnapshotAllAt < SNAPSHOT_ALL_MIN_INTERVAL) {
      return { count: 0, skipped: true, reason: 'throttled' };
    }
    _lastSnapshotAllAt = throttleNow;
    const links = database.listReferralLinks();
    const childrenMap = buildReferralTree(links);
    const personalCache = new Map();
    const stakedCache = new Map();
    const walletCache = new Map();
    const teamCache = new Map();
    const visiting = new Set();
    const wallets = new Set();
    for (const item of links) {
      if (item.wallet) wallets.add(item.wallet);
      if (item.referrerWallet) wallets.add(item.referrerWallet);
    }
    const now = Date.now();
    const rows = [];
    for (const w of wallets) {
      try {
        const key = k(w);
        if (!personalCache.has(key)) personalCache.set(key, getPersonalHeld(w));
        const personalUnits = personalCache.get(key);
        const teamUnits = teamHeldOf(w, childrenMap, stakedCache, walletCache, teamCache, visiting);
        const existing = database.getATokenTeamLevel?.(w);
        const manualLevel = existing?.manualLevel || 0;
        const level = applyFloor(calcLevel(personalUnits, teamUnits), manualLevel);
        let directValid = 0;
        for (const cw of childrenMap.get(key) || []) {
          const ck = k(cw);
          if (!personalCache.has(ck)) personalCache.set(ck, getPersonalHeld(cw));
          if (personalCache.get(ck) > 0n) directValid += 1;
        }
        rows.push({
          wallet: w, level,
          personalHeldUnits: personalUnits.toString(),
          teamHeldUnits: teamUnits.toString(),
          directValidCount: directValid, updatedAt: now,
          manualLevel: manualLevel > 0 ? manualLevel : undefined,
        });
      } catch {}
    }
    const write = () => {
      for (const row of rows) {
        database.upsertATokenTeamLevelRow(row);
        // 同步 wallet_users.level：快照表为等级唯一权威，后台用户列表等读此字段，全量重算（含降级）后须一并更新
        // 处于原子事务中时 setUserLevel 仅标记 dirty，由 transaction() 统一一次性提交，不会逐行落库
        try { walletService?.setUserLevel?.(row.wallet, row.level); } catch {}
      }
    };
    if (database.db.isTransaction) write(); else transaction(write);
    return { count: rows.length, results: rows.slice(0, 100) };
  }

  // ── 获取等级（从快照表读）──
  function getLevel(address) {
    const row = database.getATokenTeamLevel(address);
    return row?.level || 0;
  }

  // ── 后台手动指定等级：manualLevel 作为「保底等级」，实际等级=max(自动等级, 保底)，只升不降 ──
  // level 1-10 = 设置/更新保底；0 = 取消保底，恢复完全按持仓自动计算
  // 等级取值统一交给 snapshot()（applyFloor），这里只负责写入/删除保底标记
  function setManualLevel(address, level) {
    const lv = Math.max(0, Math.min(10, Math.floor(Number(level) || 0)));
    const row = { ...(database.getATokenTeamLevel?.(address) || {}), wallet: address, updatedAt: Date.now() };
    if (lv > 0) row.manualLevel = lv; else delete row.manualLevel;
    // 先落保底标记（新用户无快照行时补齐必填字段），snapshot 紧接着会重算并覆盖这些值
    if (row.personalHeldUnits === undefined) row.personalHeldUnits = '0';
    if (row.teamHeldUnits === undefined) row.teamHeldUnits = '0';
    if (row.directValidCount === undefined) row.directValidCount = 0;
    if (row.level === undefined) row.level = lv;
    database.upsertATokenTeamLevelRow(row);
    return snapshot(address);
  }

  // ── 团队分润（矿机产出/质押收益通用）：直推15% + 间推10% + 级差/平级 ──
  // ── 有效用户闸门（2026-10-01 用户确认）──
  // 规则：只有「有矿机（含后台赠送）/ 有质押 / 有 confirmed 激活记录」的用户才能获得动态奖励；
  // 一旦激活或质押过即永久有效（矿机到期、质押赎回不影响）。纯拉人头、自己从不激活/质押者不发任何动态奖励。
  const eligibleStmt = database.db.prepare(
    'SELECT 1 FROM a_token_miners WHERE wallet=? ' +
    'UNION ALL SELECT 1 FROM a_token_stakes WHERE wallet=? ' +
    'UNION ALL SELECT 1 FROM a_token_activations WHERE wallet=? AND status=? LIMIT 1'
  );
  function isEligibleRecipient(wallet) {
    return !!eligibleStmt.get(wallet, wallet, wallet, 'confirmed');
  }

  // prefix: 'miner' → kind=miner_direct/...；'stake' → kind=stake_direct/...
  function distributeReward(userAddress, rewardUnits, { prefix, sourceId, slotAt = Date.now(), receivedAt = slotAt }) {
    const prior = database.db.prepare('SELECT id FROM a_token_team_rewards WHERE source_wallet=? COLLATE NOCASE').all(userAddress);
    if (prior.some(row => row.id.startsWith(prefix + '_') && row.id.includes(`_${sourceId}_${slotAt}_`))) return { distributed:false, reason:'already distributed' };
    const chain = getReferralChain(userAddress);
    if (chain.length === 0) return { distributed: false, reason: 'no referrer' };
    // 等级直接读快照表（5 分钟定时器维护）：snapshot() 单用户也要全表扫推荐关系+递归子树持仓（O(N)），
    // 00:00 日结全部矿机集中发放时逐个 snapshot 会 O(矿机数×链长×N) 冻结事件循环（2026-10-05 全站卡死事故）
    const userLevel = getLevel(userAddress);
    const totalReward = BigInt(rewardUnits);
    if (totalReward <= 0n) return { distributed: false, reason: 'zero reward' };
    const results = [];

    const credit = (recipient, kind, amount, levelInfo = {}) => {
      if (amount <= 0n) return;
      // 有效用户闸门：无矿机/无质押/无激活记录的收款方不发（不顺延）
      if (!isEligibleRecipient(recipient)) {
        results.push({ recipient, kind, amount: amount.toString(), credited: false, skipped: 'ineligible' });
        return;
      }
      const recorded = database.insertATokenTeamRewardRow({
        id: `${prefix}_${kind}_${sourceId}_${slotAt}_${results.length}`,
        recipientWallet: recipient,
        sourceWallet: userAddress,
        kind: `${prefix}_${kind}`,
        level: levelInfo.level ?? null,
        rateBps: levelInfo.rateBps ?? null,
        amountUnits: amount.toString(),
        createdAt: receivedAt,
        periodEndAt: slotAt,
      });
      if (recorded.inserted) walletService.creditBalance(recipient, 'A', amount);
      results.push({ recipient, kind, amount: amount.toString(), credited:recorded.inserted });
    };

    // ① 直推 15%
    if (chain[0]) {
      const amt = (totalReward * DIRECT_RATE_BPS) / 10000n;
      credit(chain[0], 'direct', amt, { level: 1, rateBps: Number(DIRECT_RATE_BPS) });
    }
    // ② 间推 10%
    if (chain[1]) {
      const amt = (totalReward * INDIRECT_RATE_BPS) / 10000n;
      credit(chain[1], 'indirect', amt, { level: 2, rateBps: Number(INDIRECT_RATE_BPS) });
    }

    // ③ 团队奖/级差：沿链"逐层减法"模型（用户 2026-09-13 确认）
    //    每个有级别上级实拿 = 自己档位% −（产单人档位% + 下方已分到的节点档位%之和）
    //    命名口径（用户 2026-09-13 确认）：
    //    - 下方没有任何级别占用（eaten=0，即产单人是 A0 且中间只有 A0）→ 拿自己满档位 = 团队奖(team)
    //      例：A1 拿 A0 产的叫团队奖；A2-A9 伞下全是 A0 时拿满档位，也叫团队奖
    //    - 下方已有级别拿过档位（eaten>0）→ 只拿剩下的差值 = 级差(level_diff)
    //      例1：A0 产 100 枚 → A1 团队奖10；A2 级差 20−10=10；A9 级差 90−30=60
    //      例2（倒挂）：A0→A1→A3→A2→A5 → A1 团队奖10、A3 级差20、A2 倒挂拿0（档位不占用空间）、
    //                   A5 级差 50−(0+10+30)=10；继续向上只发给更高级别，最高分到 A9 档为止
    //    - 算出 <0：倒挂不发奖，且自己档位不计入合计（不占空间）
    //    - 算出 =0：同级，链上不发奖（平级奖改为按日结算，见 settleParityRewards）
    //    - A0 中间层：档位 0，不影响合计（透明穿透）
    //    - A10：不拿团队奖/级差/平级，截断整条链
    const rateBpsOf = (lvl) => (lvl > 0 ? BigInt(TEAM_LEVELS[lvl - 1].rateBps) : 0n);
    {
      let eatenBps = rateBpsOf(userLevel);   // 已被下方占用的档位合计（从产单人档位起算）
      for (let i = 0; i < chain.length; i++) {
        const uplineLevel = getLevel(chain[i]);
        if (uplineLevel <= 0) continue;      // A0 中间层：穿透
        if (uplineLevel >= 10) break;        // A10：截断整条链
        const mineBps = rateBpsOf(uplineLevel);
        const takeBps = mineBps - eatenBps;
        if (takeBps > 0n) {
          const amt = (totalReward * takeBps) / 10000n;
          // 命名：下方无级别占用 → 团队奖（拿满档位）；下方有级别拿过 → 级差（拿差值）
          const pushAt = results.length;
          credit(chain[i], eatenBps === 0n ? 'team' : 'level_diff', amt, { level: uplineLevel, rateBps: Number(takeBps) });
          // 无资格被跳过 → 档位不占空间（与倒挂同理），更高级别仍按原剩余空间分
          if (results[pushAt]?.skipped !== 'ineligible') eatenBps += mineBps;
        }
        // takeBps <= 0：同级/倒挂，链上不发奖也不占档位空间（同级补偿走每日平级奖 settleParityRewards）
      }
    }

    return { distributed: true, results, totalDistributed: results.reduce((s, r) => s + BigInt(r.amount), 0n).toString() };
  }

  // ── 矿机产出分润 ──
  function distributeMinerReward(userAddress, rewardUnits, minerId, slotAt = Date.now()) {
    return transaction(() => distributeReward(userAddress, rewardUnits, { prefix: 'miner', sourceId: minerId, slotAt }));
  }

  // ── 质押收益分润（比例与矿机一致：直推15% + 间推10% + 级差/平级）──
  function distributeStakeReward(userAddress, rewardUnits, stakeId, slotAt = Date.now(), receivedAt = slotAt) {
    return transaction(() => distributeReward(userAddress, rewardUnits, { prefix: 'stake', sourceId: stakeId, slotAt, receivedAt }));
  }

  // ── 平级奖（2026-10-02 改为每日 0 点日结前一天）──
  // 规则（用户确认）：只看「直推且与我同级」的下级，取该下级【前一天全天】团队收益（团队奖 team + 级差 level_diff，
  // 不含直推15%/间推10%）的 10% 作为平级奖；每个（上级, 下级, 北京日）一条记录。
  // 每天北京时间 0 点后结算一次；幂等 id=parity_{北京日槽}_{上级}_{下级}，重复执行/重启补跑均不重复发放。
  function settleParityRewards(now = Date.now()) {
    const dayStart = beijingDayStart(now);
    // 结算区间：前一天北京日 [dayStart-1d, dayStart)；daySlot 对应前一天
    const settleStart = dayStart - 86400000;
    const daySlot = Math.floor((dayStart + 28800000) / 86400000) - 1;
    // 前一天全天团队奖+级差，按下级（收款方）汇总：平级奖基数 = 下级本人收到的 team/level_diff 收益
    // 注意：amount_units 是 18 位精度大整数，不能在 SQLite 里 SUM（超出 JS 安全整数），取行后用 BigInt 聚合
    const rows = database.db.prepare(`
      SELECT recipient_wallet AS w, amount_units AS a
      FROM a_token_team_rewards
      WHERE kind IN ('miner_team','stake_team','miner_level_diff','stake_level_diff')
        AND created_at >= ? AND created_at < ?`).all(settleStart, dayStart);
    const sumByChild = new Map();
    for (const row of rows) {
      const w = k(row.w);
      sumByChild.set(w, (sumByChild.get(w) || 0n) + BigInt(row.a || '0'));
    }
    const entries = [...sumByChild.entries()].filter(([, s]) => s > 0n);
    if (!entries.length) return { settled: false, reason: 'no team income' };
    snapshotAll();
    const parentOf = new Map(database.listReferralLinks().map((l) => [k(l.wallet), k(l.referrerWallet || '')]));
    const getRow = database.db.prepare('SELECT amount_units FROM a_token_team_rewards WHERE id=?');
    let count = 0;
    let total = 0n;
    for (const [child, sum] of entries) {
      const parent = parentOf.get(child);
      if (!parent || parent === child) continue;
      const childLevel = getLevel(child);
      if (childLevel <= 0 || childLevel >= 10) continue;      // 无级别/A10 不参与平级
      if (getLevel(parent) !== childLevel) continue;          // 仅「直推且同级」
      if (!isEligibleRecipient(parent)) continue;             // 有效用户闸门
      const amount = (sum * PARITY_RATE_BPS) / 10000n;
      if (amount <= 0n) continue;
      const id = `parity_${daySlot}_${parent}_${child}`;
      const existing = getRow.get(id);
      if (!existing) {
        const rec = database.insertATokenTeamRewardRow({
          id, recipientWallet: parent, sourceWallet: child, kind: 'parity',
          level: childLevel, rateBps: Number(PARITY_RATE_BPS), amountUnits: amount.toString(),
          createdAt: now, periodEndAt: dayStart,
        });
        if (rec.inserted) { walletService.creditBalance(parent, 'A', amount); count += 1; total += amount; }
      } else if (BigInt(existing.amount_units) < amount) {
        // 兼容 2026-10-02 由「当日滚动」改「0点日结」前的部分发放：日结时只补差额（只补不扣）。
        // 正常日结前一天数据固定、一次发全，delta=0 不触发。
        const delta = amount - BigInt(existing.amount_units);
        database.db.prepare('UPDATE a_token_team_rewards SET amount_units=?, period_end_at=? WHERE id=?')
          .run(amount.toString(), dayStart, id);
        walletService.creditBalance(parent, 'A', delta);
        count += 1; total += delta;
      }
    }
    return count > 0
      ? { settled: true, daySlot, count, total: total.toString(), totalA: formatUnits(total, A_TOKEN_DECIMALS) }
      : { settled: false, reason: 'no same-level direct child' };
  }

  // ── A10 池：交易/互转手续费的分红份额全额进池（调用方已按 50% 预分），日结均分给所有 A10 用户 ──
  function distributeToA10Pool(feeAUnits, executionId, createdAt = Date.now()) {
    const poolReward = BigInt(feeAUnits);
    if (poolReward <= 0n) return 0n;
    let pool = database.getA10Pool('current');
    if (!pool) {
      pool = { id: 'current', accumUnits: '0', settled: 0, createdAt, updatedAt: createdAt };
    }
    pool.accumUnits = (BigInt(pool.accumUnits || '0') + poolReward).toString();
    pool.updatedAt = createdAt;
    database.upsertA10Pool(pool);
    return poolReward;
  }

  // ── A10 日结：均分池子给所有 A10 用户（发 A 币）──
  function settleA10Pool(now = Date.now()) {
    const settleDate = new Date(beijingDayStart(now) + 28800000).toISOString().slice(0, 10);
    if (database.getA10Pool(`settled_${settleDate}`)) return { settled:false, reason:'already settled' };
    const pool = database.getA10Pool('current');
    if (!pool) return null;
    const total = BigInt(pool.accumUnits || '0');
    if (total <= 0n) return { settled: false, reason: 'pool empty' };
    snapshotAll();
    const a10Users = database.listATokenTeamLevelsByLevel(10).sort((a,b) => k(a.wallet).localeCompare(k(b.wallet)));
    const count = a10Users.length;
    if (count === 0) return { settled: false, reason: 'no A10 users', accumUnits: total.toString() };

    const perShare = total / BigInt(count);
    const remainder = total % BigInt(count);

    let i = 0;
    for (const user of a10Users) {
      let share = perShare;
      if (remainder > 0n && i === 0) share += remainder;
      if (share > 0n && user.wallet) {
        // 幂等：先写记录（ON CONFLICT DO NOTHING），changes=0 表示当日已发过，跳过发币避免重复
        const rec = database.insertATokenTeamRewardRow({
          id: `a10pool_${settleDate}_${k(user.wallet)}`,
          recipientWallet: user.wallet,
          sourceWallet: 'A10_POOL',
          kind: 'a10_pool_share',
          level: 10,
          rateBps: null,
          amountUnits: share.toString(),
          createdAt: now,
        });
        if (rec.inserted) walletService.creditBalance(user.wallet, 'A', share);
      }
      i++;
    }

    // 归档当前池为历史记录
    database.upsertA10Pool({
      ...pool,
      id: `settled_${settleDate}`,
      settled: 1,
      settleDate,
      participantCount: count,
      perShareUnits: perShare.toString(),
      updatedAt: now,
    });
    // 重置当前池
    database.upsertA10Pool({ id: 'current', accumUnits: '0', settled: 0, createdAt: now, updatedAt: now });

    return { settled: true, settleDate, participantCount: count, perShare: perShare.toString(), total: total.toString() };
  }

  // 人数首屏不需要读取收益流水、持仓或重算等级。
  function summary(address) {
    const links = database.listReferralLinks();
    const childrenMap = buildReferralTree(links);
    const own = k(address);
    const direct = new Set((childrenMap.get(own) || []).map(k).filter(w => w && w !== own));
    const downlines = new Set(direct);
    const stack = [...direct];
    while (stack.length) {
      for (const child of childrenMap.get(stack.pop()) || []) {
        const key = k(child);
        if (key && key !== own && !downlines.has(key)) { downlines.add(key); stack.push(key); }
      }
    }
    const acc = virtualStatsAccrual(address, links);
    const parent = links.find(item => k(item.wallet) === own)?.referrerWallet;
    const referrer = parent && k(parent) !== own ? links.find(item => k(item.wallet) === k(parent))?.wallet : null;
    return {
      directReferrer: referrer || null,
      directCount: direct.size + acc.dDirect,
      teamCount: downlines.size + acc.dTeam,
    };
  }

  // ── 团队 profile：等级 + 收益 + 下级 ──
  function profile(address) {
    snapshot(address);
    const level = getLevel(address);
    const chain = getReferralChain(address);
    // 团队页的累计收益不能只取最近 200 笔，否则历史流水多时会被截断。
    const rewards = readAixIncome(database, address, 'team');
    const directCountRewards = readAixIncome(database, address, 'direct');
    const allRewards = [
      ...rewards,
      ...directCountRewards.map(r => ({ ...r, kind: 'direct_count', amountUnits: r.amountUnits || '0' })),
    ];
    const totalEarned = allRewards.reduce((sum, r) => sum + BigInt(r.amountUnits || '0'), 0n);
    const pool = database.getA10Pool('current');

    // 下级列表（个人持有/等级读快照表，无实时余额递归；无快照行时回退实时）
    const links = database.listReferralLinks();
    const minerWallets = database.listATokenMinerWallets?.() || new Set();
    const miniMinerWallets = database.listATokenMinerWalletsByPlan?.('mini120') || new Set();
    const proMinerWallets = database.listATokenMinerWalletsByPlan?.('pro1500') || new Set();
    // 后台手动设置的团队展示数据叠加量（本人设置 + 后代节点沿真实推荐链向上汇总，仅影响展示）
    const overrideContext = { rows: database.listATokenTeamStatsOverrides?.() || [], parentMap: parentMapOf(links) };
    const statsAcc = virtualStatsAccrual(address, links, overrideContext);
    const childrenMap2 = buildReferralTree(links);
    // 一次请求共用树与持仓缓存，直推明细不再逐人扫描整张推荐关系表。
    const stakedCache = new Map(), walletCache = new Map(), teamCache = new Map();
    const teamHeldFor = wallet => teamHeldOf(wallet, childrenMap2, stakedCache, walletCache, teamCache, new Set());
    let directHoldUnits = 0n;
    let directHoldUsers = 0;
    const directs = links.filter((item) => k(item.referrerWallet) === k(address)).map((item) => {
      const row = database.getATokenTeamLevel?.(item.wallet);
      const bal = getPersonalHeld(item.wallet);
      const teamHeld = teamHeldFor(item.wallet);
      // 该直推用户的虚拟团队业绩叠加（后台设置的虚拟矿机业绩沿推荐链传播到此直推用户）
      const dAcc = virtualStatsAccrual(item.wallet, links, overrideContext);
      const effTeamHeld = teamHeld + dAcc.teamHoldUnits;
      // 保底等级只升不降：max(自动等级, 保底等级)，未设保底则完全按持仓实时计算
      const lvl = applyFloor(calcLevel(bal, effTeamHeld), row?.manualLevel || 0);
      const hisDirectCount = (childrenMap2.get(k(item.wallet)) || []).length;
      directHoldUnits += bal;
      if (bal > 0n) directHoldUsers += 1;
      return {
        wallet: item.wallet,
        shortAddress: `${String(item.wallet).slice(0, 6)}...${String(item.wallet).slice(-4)}`,
        personalA: Number(formatUnits(bal, A_TOKEN_DECIMALS)),
        teamA: Number(formatUnits(effTeamHeld, A_TOKEN_DECIMALS)),
        level: lvl,
        joinedAt: item.createdAt,
        minerCount: database.countATokenMinersByWallet?.(item.wallet) || 0,
        directCount: hisDirectCount + dAcc.dDirect,
      };
    });
    const directMinerUsers = directs.filter((d) => d.minerCount > 0).length;
    // 真实间推（直推的直推，去重）与直推分档矿机人数
    const directWalletSet = new Set(directs.map(d => k(d.wallet)));
    const indirectWalletSet = new Set();
    for (const dw of directWalletSet) {
      for (const gw of (childrenMap2.get(dw) || [])) {
        const gwk = k(gw);
        if (gwk && gwk !== k(address) && !directWalletSet.has(gwk)) indirectWalletSet.add(gwk);
      }
    }
    let realDirectMini = 0, realDirectPro = 0;
    for (const w of directWalletSet) {
      if (miniMinerWallets.has(w)) realDirectMini += 1;
      if (proMinerWallets.has(w)) realDirectPro += 1;
    }

    // 整个团队网络（迭代遍历全部下级）中激活过矿机的人数
    const childrenMap = childrenMap2;
    const downlines = new Set();
    const stack = [k(address)];
    while (stack.length) {
      for (const w of childrenMap.get(stack.pop()) || []) {
        const ck = k(w);
        if (!downlines.has(ck)) { downlines.add(ck); stack.push(ck); }
      }
    }
    downlines.delete(k(address));
    let teamMinerUsers = 0;
    for (const w of downlines) { if (minerWallets.has(w)) teamMinerUsers += 1; }
    let realTeamMini = 0, realTeamPro = 0;
    for (const w of downlines) {
      if (miniMinerWallets.has(w)) realTeamMini += 1;
      if (proMinerWallets.has(w)) realTeamPro += 1;
    }

    // 团队持币统计：下级钱包 AIX 余额 + active 质押本金 + active 矿机剩余（与级别判定口径一致）
    let teamHoldUnits = 0n;
    let teamHoldUsers = 0;
    for (const w of downlines) {
      let v = 0n;
      if (!walletCache.has(w)) {
        try { walletCache.set(w, walletService.balanceUnits(w, 'A')); } catch { walletCache.set(w, 0n); }
      }
      if (!stakedCache.has(w)) stakedCache.set(w, getStakedPrincipal(w));
      v += walletCache.get(w) + stakedCache.get(w);
      if (v > 0n) { teamHoldUnits += v; teamHoldUsers += 1; }
    }
    // 虚拟会员业绩叠加（仅展示）：Mini 100 AIX / Pro 1500 AIX
    teamHoldUnits += statsAcc.teamHoldUnits;
    teamHoldUsers += statsAcc.teamHoldUsers;
    directHoldUnits += statsAcc.directHoldUnits;
    directHoldUsers += statsAcc.directHoldUsers;

    // 团队质押业绩：在押（active）质押本金，按钱包汇总后统计直推/整个团队
    const stakeByWallet = new Map();
    for (const s of database.listActiveATokenStakes?.() || []) {
      const sw = k(s.wallet);
      stakeByWallet.set(sw, (stakeByWallet.get(sw) || 0n) + splitStakePayment(s, s.totalEarnedUnits).outstanding);
    }
    let teamStakeUnits = 0n;
    let teamStakeUsers = 0;
    for (const w of downlines) {
      const v = stakeByWallet.get(w);
      if (v && v > 0n) { teamStakeUnits += v; teamStakeUsers += 1; }
    }
    let directStakeUnits = 0n;
    let directStakeUsers = 0;
    for (const d of directs) {
      const v = stakeByWallet.get(k(d.wallet));
      if (v && v > 0n) { directStakeUnits += v; directStakeUsers += 1; }
    }

    // 按 kind 汇总收益
    const byKind = {};
    for (const r of allRewards) {
      const k2 = r.kind || 'other';
      byKind[k2] = (byKind[k2] || 0n) + BigInt(r.amountUnits || '0');
    }

    // 展示等级（仅页面展示，不写快照、不参与真实分润）：真实等级 与 真实+虚拟团队业绩档位 取高
    let displayLevel = level;
    try {
      const virtualLevel = calcLevel(getPersonalHeld(address), teamHeldFor(address) + statsAcc.teamHoldUnits);
      displayLevel = Math.max(level, virtualLevel);
    } catch {}
    // 本人被设置时，虚拟直推矿机同时计入本人团队矿机（团队口径含直推）
    const ownDirectMini = statsAcc.own ? statsAcc.dDirectMini : 0;
    const ownDirectPro = statsAcc.own ? statsAcc.dDirectPro : 0;

    return {
      level: displayLevel,
      realLevel: level,
      levelLabel: displayLevel > 0 ? TEAM_LEVELS[displayLevel - 1].label : '未达标',
      nextLevel: displayLevel < 10 && displayLevel >= 0 ? TEAM_LEVELS[displayLevel] : null,
      directReferrer: chain[0] || null,
      indirectReferrer: chain[1] || null,
      directCount: directs.length + statsAcc.dDirect,
      indirectCount: indirectWalletSet.size + statsAcc.dIndirect,
      directMini: realDirectMini + statsAcc.dDirectMini,
      directPro: realDirectPro + statsAcc.dDirectPro,
      directMinerUsers: directMinerUsers + statsAcc.dDirectMini + statsAcc.dDirectPro,
      teamMini: realTeamMini + statsAcc.dTeamMini + ownDirectMini,
      teamPro: realTeamPro + statsAcc.dTeamPro + ownDirectPro,
      teamMinerUsers: teamMinerUsers + statsAcc.dTeamMini + statsAcc.dTeamPro + ownDirectMini + ownDirectPro,
      teamCount: downlines.size + statsAcc.dTeam,
      statsOverridden: statsAcc.own,
      teamHoldA: formatUnits(teamHoldUnits, A_TOKEN_DECIMALS),
      teamHoldUsers,
      directHoldA: formatUnits(directHoldUnits, A_TOKEN_DECIMALS),
      directHoldUsers,
      teamStakeA: formatUnits(teamStakeUnits, A_TOKEN_DECIMALS),
      teamStakeUsers,
      directStakeA: formatUnits(directStakeUnits, A_TOKEN_DECIMALS),
      directStakeUsers,
      directs: directs.slice(0, 50),
      totalEarnedA: totalEarned > 0n ? formatUnits(totalEarned, A_TOKEN_DECIMALS) : '0',
      byKind: Object.fromEntries(Object.entries(byKind).map(([k2, v]) => [k2, formatUnits(v, A_TOKEN_DECIMALS)])),
      a10PoolAccum: pool ? formatUnits(BigInt(pool.accumUnits || '0'), A_TOKEN_DECIMALS) : '0',
      a10ParticipantCount: database.listATokenTeamLevelsByLevel(10).length,
      TEAM_LEVELS,
    };
  }

  return { snapshot, snapshotAll, getLevel, setManualLevel, calcLevel, distributeMinerReward, distributeStakeReward, distributeToA10Pool,
    settleParityRewards:(...args) => transaction(() => settleParityRewards(...args)),
    settleA10Pool:(...args) => transaction(() => settleA10Pool(...args)), profile, summary, getTeamStatsView, TEAM_LEVELS };
}
