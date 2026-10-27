import { JsonRpcProvider, isAddress, getAddress } from 'ethers';
import { A_TOKEN_DECIMALS } from './a-token-service.js';
import { createHash } from 'node:crypto';

// New activations debit and burn platform AIX atomically. BNB plans below are
// retained only to verify payments made before the persisted cutover time.
const TX_HASH_RE = /^0x[a-fA-F0-9]{64}$/;

const LEGACY_ACTIVATION_PLANS = Object.freeze({
  '1': { plan:'1', bnbWei: (2n * 10n ** 15n).toString(), minerPlan:'mini120', bnb:'0.002', name:'Mini 矿机', label:'0.002 BNB · Mini 矿机 · 100A / 30天 · 每人限购 1 份' },
  '2': { plan:'2', bnbWei: (5n * 10n ** 16n).toString(), minerPlan:'pro1500', bnb:'0.05', name:'Pro 矿机', label:'0.05 BNB · Pro 矿机 · 1500A / 90天 · 每人限购 1 份' },
});

export const ACTIVATION_PLANS = Object.freeze({
  '1': Object.freeze({ plan: '1', minerPlan: 'mini120', paymentAsset: 'AIX', aix: '20', name: 'Mini 矿机', total: '100', days: 30, lifetimeLimit: 1, label: '20 AIX · Mini 矿机 · 100 AIX / 30天 · 每钱包终身一次' }),
  '2': Object.freeze({ plan: '2', minerPlan: 'pro1500', paymentAsset: 'AIX', aix: '400', name: 'Pro 矿机', total: '1500', days: 90, lifetimeLimit: null, label: '400 AIX · Pro 矿机 · 1500 AIX / 90天 · 激活无上限' }),
});

export function activationMessage(planKey, requestId, timestamp, quantity = 1) {
  const plan = ACTIVATION_PLANS[String(planKey)];
  if (!plan) throw new Error('激活套餐无效');
  const qty = Math.max(1, Math.floor(Number(quantity) || 1));
  // 台数并入销毁金额：1 台时与历史消息格式完全一致（兼容升级前未确认的请求）
  const burnAix = qty === 1 ? plan.aix : String(Number(plan.aix) * qty);
  return `AxiX 矿机激活确认：套餐 ${plan.plan}，销毁 ${burnAix} AIX，编号 ${requestId}，时间：${timestamp}`;
}

export function createATokenActivationService({
  aTokenService, minerService, database, clock = () => Date.now(),
  rpcUrl = '', collectionAddress = '', confirmations = 12,
  onConfirmed = null,
  rotationAddress = '', rotationAddressesByPlan = '', rotationPlan = '2', rotationEvery = 3,
  rotationEveryByPlan = '',
  reconcileLookbackBlocks = 5000, reconcileRangeCap = 2000,
  reconcileConcurrency = 8, extraCollectionAddresses = '',
  providerOverride = null,
}) {
  const db = database;
  // Fixed at the first startup of this version; restarting must never reopen BNB sales.
  const LEGACY_CUTOFF_KEY = 'a_token_activation_aix_cutover_v1';
  if (!db.getSetting(LEGACY_CUTOFF_KEY)) db.saveSetting(LEGACY_CUTOFF_KEY, String(clock()));
  const legacyCutoffAt = Number(db.getSetting(LEGACY_CUTOFF_KEY));
  const configuredAddress = isAddress(String(collectionAddress || '')) ? getAddress(collectionAddress) : '';
  const rotAddress = isAddress(String(rotationAddress || '')) ? getAddress(rotationAddress) : '';
  // 额外/历史收款地址（如已轮换下线的旧地址）：既参与链上对账扫描，也作为 verify 的
  // 有效收款地址，使误打到旧地址的付款即便已被前端提交并驳回，也能重新校验后自动补发。
  const extraAddresses = String(extraCollectionAddresses || '').split(',')
    .map(s => s.trim()).filter(Boolean)
    .map(s => (isAddress(s) ? getAddress(s).toLowerCase() : '')).filter(Boolean);
  // 每个套餐可配独立轮换地址（A_TOKEN_ROTATION_ADDRESSES，格式 '1:0x..,2:0x..'）；
  // 未单独配置的套餐回退到 rotationAddress。
  const rotationByPlan = new Map(String(rotationAddressesByPlan || '').split(',')
    .map(entry => {
      const idx = entry.indexOf(':');
      if (idx < 0) return null;
      const planKey = entry.slice(0, idx).trim();
      const addr = entry.slice(idx + 1).trim();
      return planKey && isAddress(addr) ? [planKey, getAddress(addr)] : null;
    }).filter(Boolean));
  // 所有轮换地址（含默认的）：链上对账扫描与 verify 白名单都必须覆盖全部，
  // 否则打到「某个套餐专属轮换地址」的付款会被判「收款地址不符」，漏发矿机与积分。
  const allRotationAddresses = [...new Set([...rotationByPlan.values(), ...(rotAddress ? [rotAddress] : [])])];
  const rotationAddressFor = planKey => rotationByPlan.get(String(planKey)) || rotAddress;
  const rotationEveryN = Math.max(1, Number(rotationEvery) || 1);
  // 每个套餐可配独立轮换间隔（A_TOKEN_ROTATION_EVERY_BY_PLAN，格式 '1:3,2:2'）；
  // 未单独配置的套餐回退到全局 rotationEvery。
  const everyByPlan = new Map(String(rotationEveryByPlan || '').split(',')
    .map(entry => {
      const idx = entry.indexOf(':');
      if (idx < 0) return null;
      const planKey = entry.slice(0, idx).trim();
      const n = Math.max(1, Number(entry.slice(idx + 1).trim()) || 1);
      return planKey ? [planKey, n] : null;
    }).filter(Boolean));
  const rotationEveryFor = planKey => everyByPlan.get(String(planKey)) || rotationEveryN;
  const everyLabelFor = planKey => {
    const every = rotationEveryFor(planKey);
    return `${every} 进 1（第 ${every} 笔）`;
  };
  if (allRotationAddresses.length) {
    const planLabel = String(rotationPlan || '').split(',').map(s => s.trim()).filter(Boolean).join('/') || '全部';
    const addrLabel = rotationByPlan.size
      ? [...rotationByPlan].map(([p, a]) => `套餐${p}=${a}·${everyLabelFor(p)}`).join(' / ')
      : `默认=${rotAddress}·${everyLabelFor('')}`;
    console.log(`[A币激活] 收款地址轮换已启用: 参与套餐 ${planLabel} · ${addrLabel}`);
  }
  let provider = null;
  function getProvider() {
    if (providerOverride) return providerOverride; // 测试/离线校验注入
    if (!rpcUrl) return null;
    if (!provider) provider = new JsonRpcProvider(rpcUrl);
    return provider;
  }

  function getPlans() { return Object.values(ACTIVATION_PLANS).map(p => ({ ...p })); }
  function getMeta() { return { ...aTokenService.getActivationMeta(), cap: null, unlimited: true, paymentMode: 'aix_balance' }; }

  function requestRecordId(wallet, requestId) {
    if (!/^[a-zA-Z0-9_-]{16,128}$/.test(String(requestId || ''))) throw new Error('激活请求编号无效，请刷新后重试');
    return `ata_aix_${createHash('sha256').update(`${String(wallet).toLowerCase()}:${requestId}`).digest('hex')}`;
  }
  function getRequest(wallet, planKey, requestId) {
    const record = findById(requestRecordId(wallet, requestId));
    if (record && String(record.plan) !== String(planKey)) throw new Error('激活请求编号已用于其他套餐');
    return record;
  }
  function activate(wallet, planKey, requestId, quantity = 1) {
    const plan = ACTIVATION_PLANS[String(planKey)];
    if (!plan) throw new Error('激活套餐无效');
    let qty = Math.floor(Number(quantity));
    if (!Number.isFinite(qty) || qty < 1) qty = 1;
    if (qty > 100) throw new Error('单次最多激活 100 台，请分批操作');
    if (plan.plan === '1' && qty > 1) throw new Error('Mini 矿机每个钱包终身仅可激活一次');
    const id = requestRecordId(wallet, requestId);
    return aTokenService.transaction(() => {
      const previous = getRequest(wallet, planKey, requestId);
      if (previous) return previous;
      if (aTokenService.isActivationEnabled && !aTokenService.isActivationEnabled()) throw new Error('矿机激活暂未开放');
      if (plan.plan === '1' && (db.countATokenActivationsByWalletPlan(wallet, '1') > 0
          || db.listATokenMiners(wallet).some(m => m.plan === 'mini120'))) {
        throw new Error('Mini 矿机每个钱包终身仅可激活一次');
      }
      const cost = BigInt(plan.aix) * BigInt(qty) * 10n ** BigInt(A_TOKEN_DECIMALS);
      if (BigInt(aTokenService.balanceA(wallet)) < cost) throw new Error(`可用 AIX 余额不足，激活 ${qty} 台需 ${Number(plan.aix) * qty} AIX`);
      aTokenService.debitA(wallet, cost);
      const burned = aTokenService.burn(cost, 'miner_activation', `${plan.name}${qty > 1 ? `×${qty}` : ''}激活全额销毁 · ${id}`);
      if (BigInt(burned) !== cost) throw new Error('剩余可销毁额度不足，暂时无法激活矿机');
      const now = clock();
      const record = { id, wallet, plan: plan.plan, paymentAsset: 'AIX', amountUnits: cost.toString(),
        bnbAmountWei: '0', txHash: null, blockNumber: null, status: 'confirmed', confirmedAt: now, createdAt: now,
        payload: { paymentMode: 'aix_balance', paymentAsset: 'AIX', aix: plan.aix, quantity: qty, burnedUnits: cost.toString(), requestId, minerPlan: plan.minerPlan } };
      db.upsertATokenActivationRow(record);
      // 批量激活一次入账 N 台：逐台发矿机，积分回调每台一次（与逐台单独购买完全等价）
      for (let i = 0; i < qty; i++) {
        const miner = minerService.createMiner(wallet, plan.minerPlan, { startedAt: now, activationId: id });
        if (i === 0) record.payload.minerId = miner.id;
        if (typeof onConfirmed === 'function') onConfirmed(wallet, plan.plan);
      }
      db.upsertATokenActivationRow(record);
      return record;
    });
  }

  // 按已确认的激活数决定当前 plan 应用的收款地址
  // 每 rotationEvery 笔中的最后一笔用轮换地址，其余用主地址
  // rotationPlan 支持逗号分隔的多个套餐（如 '1,2'）；为空表示全部套餐都参与轮换
  function getCollectionAddressForPlan(planKey) {
    const perPlan = rotationAddressFor(planKey);
    if (!perPlan) return configuredAddress;
    const plans = String(rotationPlan || '').split(',').map(s => s.trim()).filter(Boolean);
    if (plans.length && !plans.includes(String(planKey))) return configuredAddress;
    const count = db.countConfirmedATokenActivationsByPlan ? db.countConfirmedATokenActivationsByPlan(String(planKey)) : 0;
    const every = rotationEveryFor(planKey);
    return (count % every === every - 1) ? perPlan : configuredAddress;
  }

  function submit(wallet, planKey, txHash) {
    const plan = LEGACY_ACTIVATION_PLANS[String(planKey)];
    if (!plan) throw new Error('激活套餐无效');
    const hash = String(txHash || '').trim();
    if (!TX_HASH_RE.test(hash)) throw new Error('交易哈希格式不正确');
    const existing = db.getATokenActivationByTx(hash);
    if (existing) {
      if (String(existing.wallet).toLowerCase() !== String(wallet).toLowerCase() || existing.plan !== plan.plan) throw new Error('该交易已提交');
      return existing;
    }
    // 每个钱包每个套餐仅可激活 1 份（pending/confirmed 占名额，rejected 不占、可重新提交）
    if (hasLegacyActivation(wallet, plan.plan)) throw new Error('该历史 BNB 套餐每个钱包仅可激活一次，请勿重复购买');
    // 矿机已存在（后台赠送等）也不可重复激活
    if (hasLegacyMiner(wallet, plan.minerPlan)) throw new Error('该历史 BNB 矿机套餐已激活，不可重复激活');
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
    // 曾因「收款地址不符」被驳回的记录：若该收款地址后来被纳入白名单（如历史收款地址配置），
    // 允许重新校验以自动恢复；其它原因的驳回维持原状。
    if (record.status === 'rejected' && record.payload?.rejectReason !== '收款地址不符') return { status: 'rejected', record };
    const plan = LEGACY_ACTIVATION_PLANS[record.plan];
    if (!plan) throw new Error('激活套餐无效');
    const p = getProvider();
    if (!p || !configuredAddress) return { status: 'pending', reason: '未配置链上校验,待后台确认', record };
    // 优先用提交时记录的收款地址，兼容旧记录（无 payload.collectionAddress）回退到主地址
    // 主地址/轮换地址都是平台收款地址，匹配任一即视为有效（消除提交瞬间计数翻转导致的地址竞态误判）
    const expected = String(record.payload?.collectionAddress || configuredAddress).toLowerCase();
    const validAddresses = new Set([expected, String(configuredAddress).toLowerCase()]);
    for (const addr of allRotationAddresses) validAddresses.add(String(addr).toLowerCase());
    for (const addr of extraAddresses) validAddresses.add(addr);
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
      const block = await p.getBlock(receipt.blockNumber);
      if (!block?.timestamp) return { status: 'pending', reason: '等待核验历史付款时间', record };
      if (Number(block.timestamp) * 1000 > legacyCutoffAt) {
        reject(record, 'BNB 激活已关闭，请使用平台 AIX 余额激活');
        return { status: 'rejected', reason: record.payload.rejectReason, record };
      }
      const from = String(tx.from || '').toLowerCase();
      const to = String(tx.to || '').toLowerCase();
      if (from !== String(record.wallet).toLowerCase()) { reject(record, '交易发起方与钱包不符'); return { status: 'rejected', reason: '交易发起方与钱包不符', record }; }
      if (!validAddresses.has(to)) { reject(record, '收款地址不符'); return { status: 'rejected', reason: '收款地址不符', record }; }
      if (BigInt(tx.value.toString()) !== BigInt(plan.bnbWei)) { reject(record, 'BNB 金额不符'); return { status: 'rejected', reason: 'BNB 金额不符', record }; }
      record.blockNumber = Number(receipt.blockNumber || 0);
      // Store the actual recipient only after all chain checks pass; the submitted address is only a quote.
      record.payload = { ...record.payload, verifiedCollectionAddress: to };
      record.payload = { ...record.payload, legacyPaidAt: Number(block.timestamp) * 1000 };
      return { status: 'confirmed', record: confirm(record) };
    } catch (error) {
      return { status: 'pending', reason: `链上校验异常:${error?.message || error}`, record };
    }
  }

  function confirm(record) {
    return aTokenService.transaction(() => confirmInside(record));
  }
  function confirmInside(record) {
    if (!record) throw new Error('激活记录不存在');
    const stored = findById(record.id);
    record = stored?.status === 'confirmed' ? stored : { ...record, payload: { ...record.payload } };
    if (record.status === 'confirmed') return record;
    const plan = LEGACY_ACTIVATION_PLANS[record.plan];
    record.status = 'confirmed';
    record.confirmedAt = clock();
    if (record.payload?.rejectReason) delete record.payload.rejectReason;
    db.upsertATokenActivationRow(record);
    // 矿机已存在（后台赠送等）则不重复创建，仅标记激活记录为已确认
    const minerExists = plan && hasLegacyMiner(record.wallet, plan.minerPlan);
    if (plan && minerService && !minerExists) minerService.createMiner(record.wallet, plan.minerPlan, { startedAt: clock(), activationId: record.id });
    // 确认翻转的唯一汇聚点：定时器自动校验 / 后台手动确认 / 提交即时确认都经过这里
    if (typeof onConfirmed === 'function') {
      try { onConfirmed(record.wallet, record.plan); } catch (e) { console.error('[积分] 激活发放失败', e?.message || e); }
    }
    return record;
  }
  function reject(record, reason) {
    if (record.paymentAsset === 'AIX' && record.status === 'confirmed') throw new Error('AIX 激活已扣款销毁并发放矿机，不能驳回');
    record.status = 'rejected';
    record.payload = { ...record.payload, rejectReason: reason };
    db.upsertATokenActivationRow(record);
    return record;
  }

  function findById(recordId) {
    return db.getATokenActivationById(recordId);
  }
  function adminConfirm(recordId) {
    const record = findById(recordId);
    if (!record) throw new Error('激活记录不存在');
    if (record.status === 'confirmed') throw new Error('该记录已确认');
    const paidAt = Number(record.payload?.legacyPaidAt);
    if (record.paymentAsset === 'AIX' || !Number.isFinite(paidAt) || paidAt <= 0 || paidAt > legacyCutoffAt) {
      throw new Error('该记录需要链上核验历史付款时间，不能手动确认');
    }
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

  // ── 链上收款对账（兜底漏单）──────────────────────────────────────────
  // 站内记账完全依赖前端在付款后 POST /activate；若该请求失败（页面被钱包 App
  // 回收、网络/会话抖动、服务重启、用户不再回访），链上付款就成了"孤儿"——钱进了
  // 收款地址，但库里没有任何记录，前端 localStorage 兜底也可能失效，永久漏单。
  // 这里周期性增量扫描收款地址的链上流入，发现"金额匹配套餐 + tx 未入库 + 该钱包
  // 该套餐无记录"的付款，即自动补建 pending 记录并走 verify→confirm（与正常激活
  // 完全同一汇聚点：矿机创建、积分发放逻辑一致，不会重复发放）。
  const RECONCILE_KEY = 'a_token_activation_reconcile_v1';
  const PLAN_BY_WEI = new Map(Object.values(LEGACY_ACTIVATION_PLANS).map(plan => [plan.bnbWei, plan]));
  let reconcileTimer = null;
  let reconcileBusy = false;

  async function rpcCall(method, params) {
    const res = await fetch(rpcUrl, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(20_000), // 避免 RPC 无响应时任务挂起卡死
    });
    if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
    const body = await res.json();
    if (body.error) throw new Error(body.error.message || 'RPC error');
    return body.result;
  }
  // 需要扫描的收款地址集合：主地址 + 轮换地址 + 额外配置的历史地址
  function reconcileAddresses() {
    const set = new Set();
    if (configuredAddress) set.add(String(configuredAddress).toLowerCase());
    for (const addr of allRotationAddresses) set.add(String(addr).toLowerCase());
    for (const addr of extraAddresses) set.add(addr);
    return set;
  }
  function readReconcileCursor() {
    try { const v = JSON.parse(db.getSetting(RECONCILE_KEY) || 'null'); return v && Number(v.lastBlock) > 0 ? Number(v.lastBlock) : 0; } catch { return 0; }
  }
  function saveReconcileCursor(lastBlock, stats) {
    try { db.saveSetting(RECONCILE_KEY, JSON.stringify({ lastBlock, updatedAt: Date.now(), ...(stats || {}) })); } catch {}
  }
  // A new AIX Pro must not suppress recovery of an older paid BNB Pro.
  function hasLegacyActivation(wallet, planKey) {
    return db.listATokenActivationsByWallet(wallet).some(row => String(row.plan) === String(planKey)
      && ['pending', 'confirmed'].includes(row.status) && (String(planKey) === '1' || row.paymentAsset !== 'AIX'));
  }
  function hasLegacyMiner(wallet, minerPlan) {
    return (db.listATokenMiners?.(String(wallet).toLowerCase()) || []).some(m => m.plan === minerPlan
      && (minerPlan === 'mini120' || !String(m.activationId || '').startsWith('ata_aix_')));
  }
  // 同钱包的历史 BNB 档位仍只补发一次；新 AIX Pro 可单独并行。
  function alreadyServiced(wallet, plan) {
    return hasLegacyActivation(wallet, plan.plan) || hasLegacyMiner(wallet, plan.minerPlan);
  }

  async function runReconcileOnce() {
    if (!rpcUrl) return { skipped: '未配置 RPC' };
    const addrs = reconcileAddresses();
    if (!addrs.size) return { skipped: '未配置收款地址' };
    if (reconcileBusy) return { skipped: '上一轮仍在进行' };
    reconcileBusy = true;
    try {
      const latest = Number(BigInt(await rpcCall('eth_blockNumber', [])));
      let cursor = readReconcileCursor();
      if (!cursor) {
        // 首次运行：只回看最近 N 个块作为起点，避免一上线就全量重扫
        cursor = Math.max(0, latest - Math.max(1, Number(reconcileLookbackBlocks) || 5000));
        saveReconcileCursor(cursor, { init: true });
        console.log(`[A币激活][对账] 初始化扫描游标 block=${cursor} (latest=${latest})`);
        return { initialized: true, cursor, latest, scanned: 0, created: 0, duplicate: 0 };
      }
      if (latest <= cursor) return { scanned: 0, created: 0, duplicate: 0, cursor, latest };
      const from = cursor + 1;
      const to = Math.min(latest, cursor + Math.max(1, Number(reconcileRangeCap) || 2000));
      let created = 0, duplicate = 0, matched = 0, recovered = 0;
      const blockNumbers = [];
      for (let bn = from; bn <= to; bn++) blockNumbers.push(bn);
      let idx = 0;
      async function worker() {
        while (idx < blockNumbers.length) {
          const bn = blockNumbers[idx++];
          let raw;
          try { raw = await rpcCall('eth_getBlockByNumber', ['0x' + bn.toString(16), true]); } catch { continue; }
          if (!raw?.timestamp || Number(BigInt(raw.timestamp)) * 1000 > legacyCutoffAt) continue;
          for (const tx of (raw?.transactions || [])) {
            if (!tx || !tx.to) continue;
            if (!addrs.has(String(tx.to).toLowerCase())) continue;
            let wei; try { wei = BigInt(tx.value).toString(); } catch { continue; }
            const plan = PLAN_BY_WEI.get(wei);
            if (!plan) continue;
            matched++;
            const existing = db.getATokenActivationByTx(tx.hash);
            if (existing) {
              // 已入库：正常激活流程已处理。例外——曾因「收款地址不符」被驳回、而该地址现已纳入
              // 白名单（如历史收款地址）的付款，重新校验一次即可自动补发矿机。
              if (existing.status === 'rejected' && existing.payload?.rejectReason === '收款地址不符') {
                const retry = await verify(existing).catch(() => null);
                if (retry?.status === 'confirmed') {
                  recovered++;
                  console.log(`[A币激活][对账] 驳回记录恢复 ${existing.id} plan=${existing.plan} wallet=${existing.wallet} tx=${tx.hash}`);
                }
              }
              continue;
            }
            const wallet = String(tx.from || '');
            if (alreadyServiced(wallet, plan)) {
              duplicate++;
              console.warn(`[A币激活][对账] 重复付款已服务,跳过 tx=${tx.hash} plan=${plan.plan} wallet=${wallet}`);
              continue;
            }
            const record = {
              id: `ata_${plan.plan}_${clock()}_${wallet.toLowerCase().slice(2, 10)}`,
              wallet, plan: plan.plan, bnbAmountWei: plan.bnbWei,
              txHash: tx.hash, blockNumber: bn, status: 'pending', confirmedAt: null,
              createdAt: Number(BigInt(raw.timestamp)) * 1000,
              payload: { plan: plan.plan, bnb: plan.bnb, minerPlan: plan.minerPlan, wallet, collectionAddress: getAddress(String(tx.to)), recovered: 'onchain-reconcile' },
            };
            // 单条补录失败（如付款钱包未在平台注册，外键约束）不得中断整轮扫描
            try { db.upsertATokenActivationRow(record); }
            catch (error) { console.error(`[A币激活][对账] 补录失败,跳过 tx=${tx.hash} wallet=${wallet}: ${error?.message || error}`); continue; }
            created++;
            await verify(record).catch(() => null);
            console.log(`[A币激活][对账] 链上漏单补录 ${record.id} plan=${plan.plan} wallet=${wallet} tx=${tx.hash} block=${bn}`);
          }
        }
      }
      await Promise.all(Array.from({ length: Math.min(Math.max(1, Number(reconcileConcurrency) || 8), blockNumbers.length) }, worker));
      saveReconcileCursor(to, { lastCreated: created, lastDuplicate: duplicate, lastRecovered: recovered });
      if (created || duplicate || recovered) console.log(`[A币激活][对账] 本轮扫描 ${from}~${to}: 补录=${created} 重复付款=${duplicate} 驳回恢复=${recovered}`);
      return { scanned: to - cursor, matched, created, duplicate, recovered, cursor: to, latest };
    } catch (error) {
      console.error('[A币激活][对账] 扫描失败', error?.message || error);
      return { error: error?.message || String(error) };
    } finally {
      reconcileBusy = false;
    }
  }

  function startOnchainReconcile(intervalMs = 60_000) {
    if (reconcileTimer) return;
    const ms = Math.max(15_000, Number(intervalMs) || 60_000);
    reconcileTimer = setInterval(() => { runReconcileOnce(); }, ms);
    reconcileTimer.unref?.();
    console.log(`[A币激活][对账] 链上收款对账任务已启动(每 ${Math.round(ms / 1000)} 秒增量扫描收款地址)`);
    runReconcileOnce(); // 启动即跑一轮，尽快补齐重启期间的缺口
  }
  function stopOnchainReconcile() { if (reconcileTimer) { clearInterval(reconcileTimer); reconcileTimer = null; } }

  return { getPlans, getMeta, activate, getRequest, legacyCutoffAt, submit, verify, adminConfirm, adminReject, listByWallet, listAll, startAutoVerify, findById, ACTIVATION_PLANS, collectionAddress: configuredAddress, getCollectionAddressForPlan, rotationAddress: rotAddress, startOnchainReconcile, stopOnchainReconcile, reconcileNow: runReconcileOnce };
}
