import { formatUnits } from 'ethers';
import { randomUUID } from 'node:crypto';
import { A_TOKEN_DECIMALS } from './a-token-service.js';
import { minerIncomeSummary } from './a-token-income.js';

// A 币矿机：激活赠送矿机，60s 定时巡检，**北京时间每天 00:00 日结一次**（一天一条流水）。
// 套餐 mini120(100A/30天,日约3.33A) 与 pro1500(1500A/90天,日16.67A)。
// plan key 'mini120' 为历史兼容名，激活包 0.002 BNB 现产出 100 枚。
// 产出按 dailyTargetUnits 比例折算：每天 00:00（北京）结算「上次结算点 → 今日 00:00」的实际时长，
// 首个日界即结出激活日零头（下午激活当晚 00:00 就见第一笔流水），幂等键按北京日槽；
// 整数除法尾差在到期 finalize 时一次性补齐，总量守恒。
const DAY_MS = 24 * 60 * 60_000;
const BJ_OFFSET_MS = 8 * 60 * 60_000; // 北京时间 = UTC+8
// 北京日界：ts 所在北京日的 00:00（UTC epoch 毫秒）
const bjDayStart = (ts) => Math.floor((Number(ts) + BJ_OFFSET_MS) / DAY_MS) * DAY_MS - BJ_OFFSET_MS;
// 北京日槽：自 epoch 起的北京日序号
const bjDaySlot = (ts) => Math.floor((Number(ts) + BJ_OFFSET_MS) / DAY_MS);

export const MINER_PLANS = Object.freeze({
  mini120: { plan:'mini120', totalUnits: (100n * 10n ** BigInt(A_TOKEN_DECIMALS)).toString(), days:30 },
  pro1500: { plan:'pro1500', totalUnits: (1500n * 10n ** BigInt(A_TOKEN_DECIMALS)).toString(), days:90 },
});

export function createATokenMinerService({ aTokenService, database, teamService, clock = () => Date.now() }) {
  const db = database;
  const insertReleaseStmt = db.db.prepare(`INSERT INTO a_token_miner_releases
    (id,miner_id,wallet,amount_units,released_at,payload_json) VALUES(?,?,?,?,?,?)
    ON CONFLICT(id) DO NOTHING`);

  function dailyTargetOf(plan) {
    const cfg = MINER_PLANS[plan];
    if (!cfg) throw new Error('矿机套餐无效');
    const total = BigInt(cfg.totalUnits);
    return total / BigInt(cfg.days); // 整数向下取整，尾差到期补齐
  }

  // 激活确认 / 后台赠送时调用：创建一台矿机
  function createMiner(wallet, plan, { startedAt } = {}) {
    const cfg = MINER_PLANS[plan];
    if (!cfg) throw new Error('矿机套餐无效');
    // 同钱包同套餐仅可激活一次（不管前端还是后台），防止重复发放
    const w = String(wallet || '').toLowerCase();
    const existing = db.listATokenMiners(w);
    if (existing.some(m => m.plan === plan)) throw new Error('该矿机套餐已激活，不可重复激活');
    const now = startedAt ?? clock();
    const totalUnits = BigInt(cfg.totalUnits);
    const dailyTarget = dailyTargetOf(plan);
    const miner = {
      id: `atm_${plan}_${now}_${randomUUID()}`,
      wallet, plan, totalUnits: totalUnits.toString(),
      dailyRateBps: 0, // 兼容字段；实际用 dailyTargetUnits
      dailyTargetUnits: dailyTarget.toString(),
      startedAt: now,
      expiresAt: now + cfg.days * DAY_MS,
      lastReleaseAt: now,
      dayEarnedUnits: '0',
      totalEarnedUnits: '0',
      status: 'active',
    };
    db.upsertATokenMinerRow(miner);
    return miner;
  }

  function payRelease(miner, amount, releaseId, releasedAt, detail = {}) {
    if (db.db.prepare('SELECT 1 FROM a_token_miner_releases WHERE id=?').get(releaseId)) return 0n;
    const granted = BigInt(aTokenService.creditMinerA(miner.wallet, amount) || '0');
    if (granted <= 0n) return 0n;
    const record = { id:releaseId, minerId:miner.id, wallet:miner.wallet, amountUnits:granted.toString(), releasedAt, ...detail };
    insertReleaseStmt.run(releaseId, miner.id, miner.wallet, granted.toString(), releasedAt, JSON.stringify(record));
    teamService?.distributeMinerReward(miner.wallet, granted, miner.id, releasedAt);
    return granted;
  }

  function finalize(miner, now, remaining) {
    const granted = remaining > 0n ? payRelease(miner, remaining, `amr_${miner.id}_final_${bjDaySlot(now)}`, now, {reason:'final'}) : 0n;
    miner.totalEarnedUnits = (BigInt(miner.totalEarnedUnits) + granted).toString();
    miner.dayEarnedUnits = granted.toString();
    if (BigInt(miner.totalEarnedUnits) >= BigInt(miner.totalUnits)) miner.status = 'completed';
    if (granted > 0n || remaining <= 0n) miner.lastReleaseAt = now;
    db.upsertATokenMinerRow(miner);
  }

  // 北京日结：结算 [lastReleaseAt, now] 之间已完整度过的北京日，每个完整日发一天产出，
  // 多次巡检/服务中断恢复后同一天最多入账一条（幂等键按北京日槽）。
  function releaseOne(miner, now) {
    if (miner.status !== 'active') return;
    const totalUnits = BigInt(miner.totalUnits);
    const totalEarned = BigInt(miner.totalEarnedUnits);
    const remaining = totalUnits - totalEarned;
    if (remaining <= 0n || now >= Number(miner.expiresAt)) { finalize(miner, now, remaining); return; }
    const lastAt = Number(miner.lastReleaseAt);
    if (now <= lastAt) return;
    const todayStart = bjDayStart(now);
    if (todayStart <= lastAt) return; // 今天（北京）尚未跨过 00:00，无产出可结
    // 跨日即结：按「上次结算点（激活时刻或上一日界）→ 今日 00:00」的实际时长比例折算。
    // 首个日界即结出激活日零头（下午激活当晚 00:00 就见第一笔流水），此后每天结整天产出；
    // 整数除法尾差在到期 finalize 时一次性补齐，总量守恒。
    const elapsedMs = todayStart - lastAt;
    let accrued = BigInt(miner.dailyTargetUnits) * BigInt(elapsedMs) / BigInt(DAY_MS); // 向下取整
    if (accrued > remaining) accrued = remaining;
    if (accrued <= 0n) return;
    const slot = bjDaySlot(now);
    const releaseId = `amr_${miner.id}_bj${slot}`;
    const granted = payRelease(miner, accrued, releaseId, now, {elapsedMs});
    if (granted <= 0n) return;
    // 当日产出：本次日结入账量（每天 00:00 结算截至今日 00:00 的产出，首笔含激活日零头）
    miner.dayEarnedUnits = granted.toString();
    miner.totalEarnedUnits = (totalEarned + granted).toString();
    miner.lastReleaseAt = todayStart;
    if (totalEarned + granted >= totalUnits) miner.status = 'completed';
    db.upsertATokenMinerRow(miner);
  }

  // 每批事务的矿机数：0 点 6000+ 台若逐台一个事务会产生数千次提交；
  // 分批后提交次数降到 1/200，嵌套的团队奖写入复用同一事务（见 a-token-ledger 的 WeakSet）
  const PROCESS_BATCH_SIZE = 200;
  function processAll(now = clock()) {
    // SQL 层只取跨过 0 点待日结或已到期的矿机，非 0 点巡检为 0 行
    const miners = db.listDueATokenMiners(bjDayStart(now), now);
    let failed = 0;
    for (let i = 0; i < miners.length; i += PROCESS_BATCH_SIZE) {
      const batch = miners.slice(i, i + PROCESS_BATCH_SIZE);
      // 整批一个事务提交；批内单台失败只回滚该台的 SAVEPOINT，不连累同批其他台，
      // 失败台下一分钟随 processAll 幂等重试（releaseId 唯一 + ON CONFLICT DO NOTHING，不会重复发）
      aTokenService.transaction(() => {
        for (let j = 0; j < batch.length; j++) {
          const miner = batch[j];
          // 唯一 savepoint 名：ROLLBACK TO 后同名 savepoint 仍保留，复用会错误归入后续台
          const sp = `miner_${i + j}`;
          try {
            database.db.exec(`SAVEPOINT ${sp}`);
            releaseOne(miner, now);
            database.db.exec(`RELEASE SAVEPOINT ${sp}`);
          } catch (e) {
            try { database.db.exec(`ROLLBACK TO SAVEPOINT ${sp}`); } catch {}
            try { database.db.exec(`RELEASE SAVEPOINT ${sp}`); } catch {}
            failed += 1;
            console.error('[A币矿机] 单台结算失败，跳过待下轮重试', miner?.id, e?.message || e);
          }
        }
      });
    }
    if (failed > 0) console.warn(`[A币矿机] 本轮 ${miners.length} 台中 ${failed} 台失败，将于 1 分钟后自动重试`);
    return miners.length;
  }

  function present(wallet) {
    const miners = db.listATokenMiners(wallet);
    const now = clock();
    const income = minerIncomeSummary(db, wallet, now);
    return miners.map(m => {
      const total = BigInt(m.totalUnits);
      const earned = BigInt(m.totalEarnedUnits);
      const remaining = total - earned > 0n ? total - earned : 0n;
      // 实时预估（未入账的累计）
      const lastAt = Number(m.lastReleaseAt);
      const liveAccrued = m.status === 'active' && now > lastAt
        ? BigInt(m.dailyTargetUnits) * BigInt(now - lastAt) / BigInt(DAY_MS) : 0n;
      const liveEarned = earned + (liveAccrued > remaining ? remaining : liveAccrued);
      return {
        ...m,
        total: formatUnits(total, A_TOKEN_DECIMALS),
        dailyTarget: formatUnits(BigInt(m.dailyTargetUnits), A_TOKEN_DECIMALS),
        dayEarned: formatUnits(income.get(m.id)?.today || 0n, A_TOKEN_DECIMALS),
        yesterdayEarned: formatUnits(income.get(m.id)?.yesterday || 0n, A_TOKEN_DECIMALS),
        totalEarned: formatUnits(earned, A_TOKEN_DECIMALS),
        estimatedPending: formatUnits(liveEarned - earned, A_TOKEN_DECIMALS),
        remaining: formatUnits(remaining, A_TOKEN_DECIMALS),
        progressPct: total > 0n ? Number(earned * 10_000n / total) / 100 : 0,
        expiresAt: Number(m.expiresAt),
        startedAt: Number(m.startedAt),
      };
    });
  }

  // 后台：按 minerId 手动立即发放（把截至 now 的未入账产出一次性补齐）
  function releaseNowById(minerId) {
    const all = db.listActiveATokenMiners();
    const miner = all.find(m => m.id === minerId);
    if (!miner) return null;
    const before = BigInt(miner.totalEarnedUnits);
    aTokenService.transaction(() => releaseOne(miner, clock()));
    // 若到期/产完，会在 releaseOne 里 finalize
    const after = BigInt(miner.totalEarnedUnits);
    return { miner, releasedUnits: (after - before).toString(), status: miner.status };
  }
  // 后台：强制过期一台矿机（尾差补齐 → 状态 completed），或直接标记终止（不补尾差）
  function forceExpire(minerId, { payRemaining = true } = {}) {
    // 先从 active 列表找，找不到再 adminListATokenMiners(limit 5000 兜底) 扫 id
    let miner = db.listActiveATokenMiners().find(m => m.id === minerId) || null;
    if (!miner) {
      const all = db.adminListATokenMiners({ limit: 5000 });
      miner = all.find(m => m.id === minerId) || null;
    }
    if (!miner) return null;
    const now = clock();
    const remaining = BigInt(miner.totalUnits) - BigInt(miner.totalEarnedUnits);
    if (payRemaining && remaining > 0n && miner.status === 'active') {
      finalize(miner, now, remaining);
    } else {
      miner.status = 'completed';
      miner.lastReleaseAt = now;
      db.upsertATokenMinerRow(miner);
    }
    return miner;
  }
  // 后台：扫所有矿机（允许空 wallet）并转成前端展示格式
  function presentAll({ wallet = '', status = '', plan = '', limit = 500 } = {}) {
    const raw = db.adminListATokenMiners({ wallet, status, plan, limit });
    const now = clock();
    return raw.map(m => {
      const total = BigInt(m.totalUnits);
      const earned = BigInt(m.totalEarnedUnits);
      const remaining = total - earned > 0n ? total - earned : 0n;
      const lastAt = Number(m.lastReleaseAt);
      const liveAccrued = m.status === 'active' && now > lastAt
        ? BigInt(m.dailyTargetUnits) * BigInt(now - lastAt) / BigInt(DAY_MS) : 0n;
      const liveEarned = earned + (liveAccrued > remaining ? remaining : liveAccrued);
      return {
        ...m,
        total: formatUnits(total, A_TOKEN_DECIMALS),
        dailyTarget: formatUnits(BigInt(m.dailyTargetUnits), A_TOKEN_DECIMALS),
        dayEarned: formatUnits(bjDayStart(m.lastReleaseAt) === bjDayStart(now) ? BigInt(m.dayEarnedUnits) : 0n, A_TOKEN_DECIMALS),
        totalEarned: formatUnits(earned, A_TOKEN_DECIMALS),
        estimatedPending: formatUnits(liveEarned - earned, A_TOKEN_DECIMALS),
        remaining: formatUnits(remaining, A_TOKEN_DECIMALS),
        progressPct: total > 0n ? Number(earned * 10_000n / total) / 100 : 0,
        expiresAt: Number(m.expiresAt),
        startedAt: Number(m.startedAt),
        lastReleaseAt: lastAt,
      };
    });
  }

  return { createMiner, processAll, present, MINER_PLANS, dailyTargetOf, releaseNowById, forceExpire:(...args) => aTokenService.transaction(() => forceExpire(...args)), presentAll };
}
