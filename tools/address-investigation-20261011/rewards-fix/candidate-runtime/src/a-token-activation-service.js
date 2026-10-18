import { JsonRpcProvider, isAddress, getAddress } from 'ethers';
import { A_TOKEN_DECIMALS } from './a-token-service.js';

// A 币激活：用户链上付 BNB 到平台收款地址,后端按需 BSC RPC 校验后发矿机。
// plan '1': 0.002 BNB → mini120 矿机(Mini 矿机,100A/30天)
// plan '2': 0.05 BNB → pro1500 矿机(Pro 矿机,1500A/90天)
// 名额限前 1,000,000。第一期按需校验 txHash（不持续监听）,未配置时待后台手动确认。
const BNB_DECIMALS = 18;
const CAP = 1_000_000;
const TX_HASH_RE = /^0x[a-fA-F0-9]{64}$/;

export const ACTIVATION_PLANS = Object.freeze({
  '1': { plan:'1', bnbWei: (2n * 10n ** 15n).toString(), minerPlan:'mini120', bnb:'0.002', name:'Mini 矿机', label:'0.002 BNB · Mini 矿机 · 100A / 30天 · 每人限购 1 份' },
  '2': { plan:'2', bnbWei: (5n * 10n ** 16n).toString(), minerPlan:'pro1500', bnb:'0.05', name:'Pro 矿机', label:'0.05 BNB · Pro 矿机 · 1500A / 90天 · 每人限购 1 份' },
});

export function createATokenActivationService({
  aTokenService, minerService, database, clock = () => Date.now(),
  rpcUrl = '', collectionAddress = '', confirmations = 12,
  onConfirmed = null,
  rotationAddress = '', rotationPlan = '2', rotationEvery = 3,
}) {
  const db = database;
  const configuredAddress = isAddress(String(collectionAddress || '')) ? getAddress(collectionAddress) : '';
  const rotAddress = isAddress(String(rotationAddress || '')) ? getAddress(rotationAddress) : '';
  let provider = null;
  function getProvider() {
    if (!rpcUrl) return null;
    if (!provider) provider = new JsonRpcProvider(rpcUrl);
    return provider;
  }

  function getPlans() { return Object.values(ACTIVATION_PLANS).map(p => ({ ...p, bnbWei: undefined })); }
  function getMeta() { return aTokenService.getActivationMeta(); }

  // 按已确认的 plan '2' 激活数决定当前 plan 应用的收款地址
  // 每 rotationEvery 笔中的最后一笔用轮换地址，其余用主地址
  function getCollectionAddressForPlan(planKey) {
    if (!rotAddress || String(planKey) !== String(rotationPlan)) return configuredAddress;
    const count = db.countConfirmedATokenActivationsByPlan ? db.countConfirmedATokenActivationsByPlan(String(planKey)) : 0;
    return (count % rotationEvery === rotationEvery - 1) ? rotAddress : configuredAddress;
  }

  function submit(wallet, planKey, txHash) {
    const plan = ACTIVATION_PLANS[String(planKey)];
    if (!plan) throw new Error('激活套餐无效');
    const hash = String(txHash || '').trim();
    if (!TX_HASH_RE.test(hash)) throw new Error('交易哈希格式不正确');
    if (db.countConfirmedATokenActivations() >= CAP) throw new Error('激活名额已满（限前 100 万名）');
    // 每个钱包每个套餐仅可激活 1 份（pending/confirmed 占名额，rejected 不占、可重新提交）
    if (db.countATokenActivationsByWalletPlan(wallet, plan.plan) > 0) throw new Error('该套餐每个钱包仅可激活一次，请勿重复购买');
    // 矿机已存在（后台赠送等）也不可重复激活
    if (db.listATokenMiners && db.listATokenMiners(String(wallet).toLowerCase()).some(m => m.plan === plan.minerPlan)) throw new Error('该矿机套餐已激活，不可重复激活');
    if (db.getATokenActivationByTx(hash)) throw new Error('该交易已提交,请勿重复激活');
    // 记录该笔提交时应使用的收款地址（提交瞬间决定，避免计数变化导致校验地址漂移）
    const expectedAddress = getCollectionAddressForPlan(plan.plan);
    const record = {
      id: `ata_${plan.plan}_${clock()}_${String(wallet).toLowerCase().slice(0, 8)}`,
      wallet, plan: plan.plan, bnbAmountWei: plan.bnbWei, txHash: hash,
      blockNumber: null, status: 'pending', confirmedAt: null, createdAt: clock(),
      payload: { plan: plan.plan, bnb: plan.bnb, minerPlan: plan.minerPlan, wallet, collectionAddress: expectedAddress },
    };
    db.upsertATokenActivationRow(record);
    return record;
  }

  // 链上校验：成功则 confirm,未上链/未确认返回 pending,失败则 reject
  async function verify(record) {
    if (!record) throw new Error('激活记录不存在');
    if (record.status === 'confirmed') return { status: 'confirmed', record };
    if (record.status === 'rejected') return { status: 'rejected', record };
    const plan = ACTIVATION_PLANS[record.plan];
    if (!plan) throw new Error('激活套餐无效');
    const p = getProvider();
    if (!p || !configuredAddress) return { status: 'pending', reason: '未配置链上校验,待后台确认', record };
    // 优先用提交时记录的收款地址，兼容旧记录（无 payload.collectionAddress）回退到主地址
    // 主地址/轮换地址都是平台收款地址，匹配任一即视为有效（消除提交瞬间计数翻转导致的地址竞态误判）
    const expected = String(record.payload?.collectionAddress || configuredAddress).toLowerCase();
    const validAddresses = new Set([expected, String(configuredAddress).toLowerCase()]);
    if (rotAddress) validAddresses.add(String(rotAddress).toLowerCase());
    try {
      const [tx, receipt, currentBlock] = await Promise.all([
        p.getTransaction(record.txHash),
        p.getTransactionReceipt(record.txHash).catch(() => null),
        p.getBlockNumber().catch(() => 0),
      ]);
      if (!tx) return { status: 'pending', reason: '交易尚未上链', record };
      if (!receipt) return { status: 'pending', reason: '交易尚未确认', record };
      if (receipt.status !== 1) { reject(record, '链上交易失败'); return { status: 'rejected', reason: '链上交易失败', record }; }
      if (currentBlock && receipt.blockNumber && currentBlock - receipt.blockNumber < confirmations) {
        return { status: 'pending', reason: `需 ${confirmations} 区块确认`, record };
      }
      const from = String(tx.from || '').toLowerCase();
      const to = String(tx.to || '').toLowerCase();
      if (from !== String(record.wallet).toLowerCase()) { reject(record, '交易发起方与钱包不符'); return { status: 'rejected', reason: '交易发起方与钱包不符', record }; }
      if (!validAddresses.has(to)) { reject(record, '收款地址不符'); return { status: 'rejected', reason: '收款地址不符', record }; }
      if (BigInt(tx.value.toString()) !== BigInt(plan.bnbWei)) { reject(record, 'BNB 金额不符'); return { status: 'rejected', reason: 'BNB 金额不符', record }; }
      record.blockNumber = Number(receipt.blockNumber || 0);
      return { status: 'confirmed', record: confirm(record) };
    } catch (error) {
      return { status: 'pending', reason: `链上校验异常:${error?.message || error}`, record };
    }
  }

  function confirm(record) {
    if (!record) throw new Error('激活记录不存在');
    if (record.status === 'confirmed') return record;
    const plan = ACTIVATION_PLANS[record.plan];
    record.status = 'confirmed';
    record.confirmedAt = clock();
    db.upsertATokenActivationRow(record);
    // 矿机已存在（后台赠送等）则不重复创建，仅标记激活记录为已确认
    const minerExists = plan && db.listATokenMiners && db.listATokenMiners(String(record.wallet).toLowerCase()).some(m => m.plan === plan.minerPlan);
    if (plan && minerService && !minerExists) minerService.createMiner(record.wallet, plan.minerPlan, { startedAt: clock() });
    // 确认翻转的唯一汇聚点：定时器自动校验 / 后台手动确认 / 提交即时确认都经过这里
    if (typeof onConfirmed === 'function') {
      try { onConfirmed(record.wallet, record.plan); } catch (e) { console.error('[积分] 激活发放失败', e?.message || e); }
    }
    return record;
  }
  function reject(record, reason) {
    record.status = 'rejected';
    record.payload = { ...record.payload, rejectReason: reason };
    db.upsertATokenActivationRow(record);
    return record;
  }

  function findById(recordId) {
    return db.listATokenActivations(5000).find(r => r.id === recordId) || null;
  }
  function adminConfirm(recordId) {
    const record = findById(recordId);
    if (!record) throw new Error('激活记录不存在');
    if (record.status === 'confirmed') throw new Error('该记录已确认');
    return confirm(record);
  }
  function adminReject(recordId, reason) {
    const record = findById(recordId);
    if (!record) throw new Error('激活记录不存在');
    return reject(record, reason || '后台拒绝');
  }

  function listByWallet(wallet) {
    return db.listATokenActivationsByWallet(String(wallet));
  }
  function listAll(limit = 200) {
    return db.listATokenActivations(limit);
  }

  // ── pending 自动校验 ─────────────────────────────────────────────
  // 提交激活时只 verify 一次,而 BSC 需 12 个区块确认(约 36 秒),提交瞬间几乎必然
  // 返回 pending;若此后无人再校验,记录将永远 pending、矿机永远不发。
  // 此定时任务周期性重扫 pending 记录,链上确认达标即自动 confirm 并发放矿机。
  let autoVerifyTimer = null;
  let autoVerifyBusy = false;
  async function runPendingVerify() {
    if (autoVerifyBusy) return;
    autoVerifyBusy = true;
    try {
      const pending = listAll(5000).filter(r => r.status === 'pending');
      for (const record of pending) {
        try {
          const result = await verify(record);
          if (result?.status === 'confirmed') console.log(`[A币激活] 自动确认 ${record.id} → 矿机已发放`);
          else if (result?.status === 'rejected') console.log(`[A币激活] 自动校验驳回 ${record.id}: ${result.reason || ''}`);
        } catch { /* 单条失败不影响其余记录,下轮重试 */ }
      }
    } finally {
      autoVerifyBusy = false;
    }
  }
  function startAutoVerify(intervalMs = 30_000) {
    if (autoVerifyTimer) return;
    autoVerifyTimer = setInterval(() => { runPendingVerify(); }, Math.max(10_000, Number(intervalMs) || 30_000));
    autoVerifyTimer.unref?.();
    console.log(`[A币激活] 自动校验任务已启动(每 ${Math.max(10, Math.round((Number(intervalMs) || 30_000) / 1000))} 秒扫描 pending 记录)`);
  }

  return { getPlans, getMeta, submit, verify, adminConfirm, adminReject, listByWallet, listAll, startAutoVerify, findById, ACTIVATION_PLANS, CAP, collectionAddress: configuredAddress, getCollectionAddressForPlan, rotationAddress: rotAddress };
}
