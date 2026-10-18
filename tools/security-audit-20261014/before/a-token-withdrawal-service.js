import {
  Interface,
  JsonRpcProvider,
  Wallet,
  formatUnits,
  getAddress,
  isAddress,
  keccak256,
} from 'ethers';
import { A_TOKEN_DECIMALS } from './a-token-service.js';

const LEDGER_DECIMALS = A_TOKEN_DECIMALS; // 18
const BSC_CHAIN_ID = 56;
const BSC_CONFIRMATIONS = 12;
const BSC_BLOCK_TIME_MS = 3_000;
const PAYOUT_STATES = new Set(['processing', 'signed', 'broadcast']);
const ERC20_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
];
const tokenInterface = new Interface(ERC20_ABI);

function errorMessage(error) {
  return String(error?.shortMessage || error?.reason || error?.message || error || 'A 币链上提现失败');
}

function startOfDayUnixMs(now = Date.now()) {
  const d = new Date(now);
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * A 币链上提现服务（BSC 单链）。
 * 依赖：用户必须先部署 contracts/A.sol 到 BSC 主网并填好 .env：
 *   A_TOKEN_CONTRACT_ADDRESS = 部署得到的合约地址
 *   A_TOKEN_HOT_WALLET       = 平台热钱包（持有大额 A 币用于出款）
 *   A_TOKEN_HOT_PRIVATE_KEY   = 上述热钱包的私钥
 *   BSC_RPC_URL               = BSC 主网 RPC（可选，默认用公共节点）
 */
export function createATokenWithdrawalService({
  aTokenService,        // 提供 balanceA / debitA / creditA
  database,             // 直接读写 a_token_withdrawals
  contractAddress = '',
  hotWalletAddress = '',
  hotPrivateKey = '',
  rpcUrl = 'https://bsc-dataseed.binance.org',
  pollIntervalMs = 15_000,
  // 限额（单位：A 币（小数=1，方便阅读））
  minWithdrawA = 100,           // 单笔最小 100 A
  maxWithdrawA = 500_000,       // 单笔最大 50 万 A
  dailyCapA = 2_000_000,         // 单日累计上限 200 万 A
  autoApproveThresholdA = 1_000, // <1000 A 自动放；>=1000 A 进 manual_review
  feeRateBps = 50,              // 0.5% 手续费
  minFeeA = 5,                  // 单笔手续费最少 5 A
} = {}) {
  if (!aTokenService) throw new Error('A 币提现服务缺少 aTokenService');
  if (!database) throw new Error('A 币提现服务缺少 database');

  const contract = isAddress(String(contractAddress || '')) ? getAddress(contractAddress) : '';
  const hotAddress = isAddress(String(hotWalletAddress || '')) ? getAddress(hotWalletAddress) : '';
  let baseWallet = null;
  if (hotPrivateKey) {
    try { baseWallet = new Wallet(String(hotPrivateKey).trim()); }
    catch { throw new Error('A_TOKEN_HOT_PRIVATE_KEY 格式无效'); }
  }
  if (baseWallet && hotAddress && baseWallet.address.toLowerCase() !== hotAddress.toLowerCase()) {
    throw new Error('A_TOKEN_HOT_PRIVATE_KEY 与 A_TOKEN_HOT_WALLET 不匹配');
  }

  let provider = null;
  let signer = null;
  if (contract && baseWallet) {
    provider = new JsonRpcProvider(String(rpcUrl || ''), BSC_CHAIN_ID, { staticNetwork: true });
    signer = baseWallet.connect(provider);
  }
  const configured = Boolean(contract && signer);
  const inFlight = new Set();
  let timer = null;

  function status() {
    return {
      enabled: configured,
      configured,
      contractAddress: contract,
      hotWalletAddress: hotAddress,
      bscChainId: BSC_CHAIN_ID,
      confirmations: BSC_CONFIRMATIONS,
      minWithdrawA,
      maxWithdrawA,
      dailyCapA,
      autoApproveThresholdA,
      feeRateBps,
      minFeeA,
    };
  }

  function toAUnits(amountNumber) {
    // amountNumber 是人类可读的 A 数量（小数=1），转 18 位 BigInt units
    if (typeof amountNumber !== 'number' || !isFinite(amountNumber) || amountNumber <= 0) return null;
    const units = BigInt(Math.floor(amountNumber * 10 ** LEDGER_DECIMALS));
    return units;
  }

  function fromAUnits(units) {
    return Number(units) / 10 ** LEDGER_DECIMALS;
  }

  function computeFee(amountUnits) {
    const feeUnits = BigInt(amountUnits) * BigInt(feeRateBps) / 10_000n;
    const minFeeUnits = BigInt(Math.floor(minFeeA * 10 ** LEDGER_DECIMALS));
    return feeUnits > minFeeUnits ? feeUnits : minFeeUnits;
  }

  function isBlockedAddress(addr) {
    if (!addr) return true;
    const a = String(addr).toLowerCase();
    if (!isAddress(a)) return true;
    if (contract && a === contract.toLowerCase()) return true;            // 不能提现到 A 币合约本身
    if (hotAddress && a === hotAddress.toLowerCase()) return true;       // 不能提现回平台热钱包
    return false;
  }

  function quote({ amount }) {
    const amountUnits = toAUnits(Number(amount));
    if (!amountUnits) return { error: '提现金额无效', ok: false };
    if (amountUnits < BigInt(Math.floor(minWithdrawA * 10 ** LEDGER_DECIMALS)))
      return { ok: false, error: `最小提现金额为 ${minWithdrawA} A` };
    if (amountUnits > BigInt(Math.floor(maxWithdrawA * 10 ** LEDGER_DECIMALS)))
      return { ok: false, error: `单笔最大提现 ${maxWithdrawA} A` };
    const feeUnits = computeFee(amountUnits);
    const needUnits = amountUnits + feeUnits;
    const willAutoApprove = amountUnits < BigInt(Math.floor(autoApproveThresholdA * 10 ** LEDGER_DECIMALS));
    return {
      ok: true,
      amountA: formatUnits(amountUnits, LEDGER_DECIMALS),
      feeA: formatUnits(feeUnits, LEDGER_DECIMALS),
      receiveA: formatUnits(amountUnits, LEDGER_DECIMALS),  // 链上到账 = 提现金额（不含手续费）
      needBalanceA: formatUnits(needUnits, LEDGER_DECIMALS), // 内盘需扣 = amount + fee
      autoApprove: willAutoApprove,
      toChain: 'BSC',
      chainId: BSC_CHAIN_ID,
      estimatedSeconds: BSC_CONFIRMATIONS * (BSC_BLOCK_TIME_MS / 1000),
      contractAddress: contract,
    };
  }

  function listWithdrawals(wallet, limit = 50) {
    return database.listATokenWithdrawalsByWallet(wallet, limit);
  }

  function getWithdrawal(id) {
    return database.getATokenWithdrawalById(id);
  }

  function listPending(limit = 100) {
    return database.listPendingATokenWithdrawals(limit);
  }

  function dailyUsed(wallet) {
    return database.sumATokenWithdrawalsByWalletToday(wallet, startOfDayUnixMs());
  }

  /**
   * 用户提交提现申请。
   * 流程：
   *   1. 校验配置 + toAddress + 金额 + 单笔/单日限额
   *   2. 计算 fee，校验 A 余额 >= amount + fee
   *   3. debit A（amount + fee）—— 视为冻结
   *   4. INSERT a_token_withdrawals 记录
   *   5. 小额 → 立即标记 processing 并 enqueue
   *      大额 → 标记 manual_review，等后台审核
   */
  function requestWithdrawal({ wallet, amount, toAddress, requestId = '' }) {
    if (!wallet) throw new Error('缺少钱包地址');
    if (!configured) throw new Error('A 币链上提现未启用（请先部署合约并配置 A_TOKEN_CONTRACT_ADDRESS / A_TOKEN_HOT_WALLET / A_TOKEN_HOT_PRIVATE_KEY）');
    // 安全约束：链上提现只能提到当前连接钱包地址本身，禁止任意地址输入
    const recipient = isAddress(String(wallet || '')) ? getAddress(wallet) : '';
    if (!recipient) throw new Error('当前钱包地址格式无效');
    if (isBlockedAddress(recipient)) throw new Error('收款地址不被允许（不能是平台合约或热钱包地址）');
    // 若调用方仍传入 toAddress，必须与连接钱包一致；不一致直接拒绝（防绕过）
    if (toAddress && getAddress(String(toAddress)) !== recipient) {
      throw new Error('提现地址必须与当前连接钱包一致');
    }

    // 幂等：同一钱包同一 requestId 重复提交（网络重试/签名重放）直接返回已有记录，防双笔扣款
    const reqIdEarly = String(requestId || '').trim();
    if (reqIdEarly) {
      const existing = database.listATokenWithdrawalsByWallet(recipient, 50)
        .find(r => String(r.requestId || '') === reqIdEarly);
      if (existing) return existing;
    }

    const amountUnits = toAUnits(Number(amount));
    if (!amountUnits) throw new Error('提现金额无效');
    if (amountUnits < BigInt(Math.floor(minWithdrawA * 10 ** LEDGER_DECIMALS)))
      throw new Error(`最小提现金额为 ${minWithdrawA} A`);
    if (amountUnits > BigInt(Math.floor(maxWithdrawA * 10 ** LEDGER_DECIMALS)))
      throw new Error(`单笔最大提现 ${maxWithdrawA} A`);

    const todayUsed = dailyUsed(wallet);
    if (todayUsed + amountUnits > BigInt(Math.floor(dailyCapA * 10 ** LEDGER_DECIMALS)))
      throw new Error(`单日提现上限 ${dailyCapA} A，今日已用 ${formatUnits(todayUsed, LEDGER_DECIMALS)} A`);

    const feeUnits = computeFee(amountUnits);
    const needUnits = amountUnits + feeUnits;
    const balanceA = aTokenService.balanceA(wallet);
    if (BigInt(balanceA) < needUnits)
      throw new Error(`A 余额不足，需要 ${formatUnits(needUnits, LEDGER_DECIMALS)} A（含手续费 ${formatUnits(feeUnits, LEDGER_DECIMALS)} A）`);

    // 立即扣款（冻结）
    aTokenService.debitA(wallet, needUnits.toString());

    const id = `awd_${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 10)}`;
    const reqId = String(requestId || `req_${Math.random().toString(16).slice(2, 14)}`);
    const willAutoApprove = amountUnits < BigInt(Math.floor(autoApproveThresholdA * 10 ** LEDGER_DECIMALS));
    const initialStatus = willAutoApprove ? 'processing' : 'manual_review';
    const now = Date.now();
    const record = {
      id, requestId: reqId, wallet, toAddress: recipient,
      amountUnits: amountUnits.toString(),
      feeUnits: feeUnits.toString(),
      needUnits: needUnits.toString(),
      status: initialStatus,
      txHash: null,
      chainId: BSC_CHAIN_ID,
      confirmations: 0,
      createdAt: now,
      processedAt: null,
      failReason: null,
    };
    database.upsertATokenWithdrawalRow(record);

    if (willAutoApprove) enqueue(id).catch(() => {});
    return record;
  }

  /** 后台批准大额提现：manual_review → processing */
  function approveWithdrawal(id) {
    const record = database.getATokenWithdrawalById(id);
    if (!record) throw new Error('提现记录不存在');
    if (record.status !== 'manual_review') throw new Error(`当前状态 ${record.status} 不可批准`);
    database.upsertATokenWithdrawalRow({ ...record, status: 'processing', processedAt: Date.now() });
    enqueue(id).catch(() => {});
    return database.getATokenWithdrawalById(id);
  }

  /** 后台拒绝大额提现：manual_review → rejected，退回 A 余额 */
  function rejectWithdrawal(id, reason = 'manual_rejected') {
    const record = database.getATokenWithdrawalById(id);
    if (!record) throw new Error('提现记录不存在');
    if (record.status !== 'manual_review') throw new Error(`当前状态 ${record.status} 不可拒绝`);
    aTokenService.creditA(record.wallet, BigInt(record.needUnits).toString());
    database.upsertATokenWithdrawalRow({
      ...record, status: 'rejected', processedAt: Date.now(), failReason: String(reason),
    });
    return database.getATokenWithdrawalById(id);
  }

  /** 用户主动撤销：仅 pending/manual_review 可撤销，退回 A 余额 */
  function cancelWithdrawal({ wallet, id }) {
    const record = database.getATokenWithdrawalById(id);
    if (!record) throw new Error('提现记录不存在');
    if (String(record.wallet).toLowerCase() !== String(wallet).toLowerCase())
      throw new Error('无权撤销他人的提现');
    if (!['pending', 'manual_review'].includes(record.status))
      throw new Error(`当前状态 ${record.status} 不可撤销（仅待审核状态可撤销）`);
    aTokenService.creditA(record.wallet, BigInt(record.needUnits).toString());
    database.upsertATokenWithdrawalRow({
      ...record, status: 'cancelled', processedAt: Date.now(), failReason: 'user_cancelled',
    });
    return database.getATokenWithdrawalById(id);
  }

  async function checkReceipt(record) {
    const receipt = await provider.getTransactionReceipt(record.txHash);
    if (!receipt) return false;
    if (Number(receipt.status) !== 1) {
      markFailed(record.id, '链上 transfer 执行失败（交易 revert）');
      return true;
    }
    const currentBlock = await provider.getBlockNumber();
    const confirmations = Math.max(0, currentBlock - Number(receipt.blockNumber) + 1);
    if (confirmations < BSC_CONFIRMATIONS) {
      // 更新确认数但不改状态
      database.upsertATokenWithdrawalRow({ ...record, confirmations });
      return false;
    }
    const updated = { ...record, status: 'paid', processedAt: Date.now(), confirmations };
    database.upsertATokenWithdrawalRow(updated);
    return true;
  }

  function markFailed(id, reason) {
    const record = database.getATokenWithdrawalById(id);
    if (!record) return;
    // 退回冻结的 A（amount + fee）
    try { aTokenService.creditA(record.wallet, BigInt(record.needUnits).toString()); }
    catch { /* balance credit failure - 平台对账时手工处理 */ }
    database.upsertATokenWithdrawalRow({
      ...record, status: 'failed', processedAt: Date.now(), failReason: String(reason).slice(0, 500),
    });
  }

  async function process(id) {
    if (!configured || inFlight.has(id)) return;
    inFlight.add(id);
    try {
      let record = database.getATokenWithdrawalById(id);
      if (!record || !PAYOUT_STATES.has(record.status)) return;

      if (record.status === 'processing') {
        // 校验热钱包链上 A 余额
        const balanceData = tokenInterface.encodeFunctionData('balanceOf', [signer.address]);
        const encoded = await provider.call({ to: contract, data: balanceData });
        const [tokenBalance] = tokenInterface.decodeFunctionResult('balanceOf', encoded);
        const amountUnits = BigInt(record.amountUnits);
        if (BigInt(tokenBalance) < amountUnits) {
          markFailed(id, '平台热钱包 A 币链上余额不足，请联系平台补充');
          return;
        }
        // 签名 ERC-20 transfer(recipient, amount)
        const data = tokenInterface.encodeFunctionData('transfer', [record.toAddress, amountUnits]);
        const transaction = await signer.populateTransaction({ to: contract, data });
        const rawTransaction = await signer.signTransaction(transaction);
        const txHash = keccak256(rawTransaction);
        database.upsertATokenWithdrawalRow({
          ...record, status: 'signed', txHash, rawTransaction,
          nonce: transaction.nonce, processedAt: Date.now(),
        });
        record = database.getATokenWithdrawalById(id);
      }

      if (record.status === 'signed') {
        try {
          const response = await provider.broadcastTransaction(record.rawTransaction);
          if (response?.hash && String(response.hash).toLowerCase() !== record.txHash.toLowerCase()) {
            throw new Error('节点返回的交易哈希与本地签名不一致');
          }
        } catch (error) {
          // 检查是否已经被节点接收（可能其他进程已广播过）
          const known = await provider.getTransaction(record.txHash).catch(() => null);
          if (!known) throw error;
        }
        database.upsertATokenWithdrawalRow({ ...record, status: 'broadcast', processedAt: Date.now() });
        record = database.getATokenWithdrawalById(id);
      }

      if (record.status === 'broadcast') {
        const settled = await checkReceipt(record);
        if (!settled && record.rawTransaction) {
          // 如果链上找不到这笔 tx，可能广播丢了，重试一次
          const known = await provider.getTransaction(record.txHash).catch(() => null);
          if (!known) {
            try { await provider.broadcastTransaction(record.rawTransaction); }
            catch { /* already in mempool */ }
          }
        }
      }
    } catch (error) {
      // 临时性错误（网络抖动 / RPC 限流）不立即标记失败，下次扫描重试
      const msg = errorMessage(error);
      if (/余额不足|revert|失败/i.test(msg)) {
        markFailed(id, msg);
      } else {
        // 仅记录但不改状态，下次扫描重试
        const record = database.getATokenWithdrawalById(id);
        if (record) database.upsertATokenWithdrawalRow({ ...record, lastError: String(msg).slice(0, 500) });
      }
    } finally {
      inFlight.delete(id);
    }
  }

  function enqueue(id) {
    if (!configured || !id) return Promise.resolve(false);
    return process(id).then(() => true).catch(() => false);
  }

  function scan() {
    if (!configured) return;
    for (const record of database.listPendingATokenWithdrawals(100)) {
      if (PAYOUT_STATES.has(record.status)) enqueue(record.id).catch(() => {});
    }
  }

  function start() {
    if (!configured || timer) return;
    scan();
    timer = setInterval(scan, Math.max(5_000, Number(pollIntervalMs) || 15_000));
    timer.unref?.();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return {
    status, quote, requestWithdrawal, cancelWithdrawal,
    approveWithdrawal, rejectWithdrawal,
    listWithdrawals, getWithdrawal, listPending,
    enqueue, scan, start, stop,
  };
}
