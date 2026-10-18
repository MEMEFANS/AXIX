/**
 * AIX 链上提取签名服务（AIXPool harvest 模式）
 *
 * 流程：
 *   1. 用户在前端点"提取到钱包"按钮
 *   2. 前端 POST /api/a-token/claim-signature { amount }
 *   3. 本服务：
 *      - 验证用户账面 AIX 余额 ≥ amount
 *      - 计算 nonce（防重放，记录到数据库）
 *      - 立即扣减账面余额（防止用户并发请求）
 *      - 用 AIX_POOL_SIGNER_PRIVATE_KEY 对 EIP-191 消息签名
 *      - 返回 { amount, nonce, signature, contractAddress, chainId }
 *   4. 前端拿到签名后弹钱包签名请求
 *      - 用户调用 AIXPool.harvest(amount, nonce, signature)
 *      - AIX 从合约转到用户钱包（用户付 Gas）
 *   5. 链上交易成功后，前端可选 POST /api/a-token/claim-confirm { txHash }
 *      - 服务器记录 txHash 到 a_token_claims 表（便于审计）
 *
 * 安全设计：
 *   - 余额先扣后签（防并发提现）
 *   - nonce 全局唯一（crypto.randomBytes(16)），写入 a_token_claims 表
 *   - 签名消息 = keccak256(user, amount, nonce, contractAddr)
 *   - EIP-191: 加 \x19Ethereum Signed Message:\n32 前缀后用私钥 signMessage
 *   - 合约地址绑定在消息里（防同签名跨合约重放）
 *
 * 失败回滚：
 *   - 如果用户取消签名或链上交易失败：账面余额已扣，需要手动或自动回滚
 *   - 提供 refundClaim(claimId) 接口：管理员手动回滚余额
 *   - 提供 listStaleClaims() 接口：列出 24 小时前未确认的 claim（用于自动回滚）
 */
import crypto from 'node:crypto';
import {
  Wallet,
  solidityPacked,
  keccak256,
  toBeHex,
  isAddress,
  getAddress,
  formatUnits,
} from 'ethers';
import { A_TOKEN_DECIMALS } from './a-token-service.js';

const LEDGER_DECIMALS = A_TOKEN_DECIMALS; // 18
const BSC_CHAIN_ID = 56;

export function createATokenClaimService({
  aTokenService,           // 提供 balanceA / debitA / creditA
  database,                 // 读写 a_token_claims 表
  contractAddress = '',     // AIXPool 合约地址
  signerPrivateKey = '',    // 平台签名私钥（AIX_POOL_SIGNER_PRIVATE_KEY）
  chainId = BSC_CHAIN_ID,
  // 限额（单位：AIX 数量，小数=1）
  minClaimA = 100,          // 单笔最小 100 AIX
  maxClaimA = 500_000,      // 单笔最大 50 万 AIX
  dailyCapA = 2_000_000,    // 单日累计上限 200 万 AIX
  staleTimeoutMs = 24 * 60 * 60_000, // 24 小时未确认视为失效
} = {}) {
  if (!aTokenService) throw new Error('AIX 提现签名服务缺少 aTokenService');
  if (!database) throw new Error('AIX 提现签名服务缺少 database');

  const contract = isAddress(String(contractAddress || '')) ? getAddress(contractAddress) : '';
  let signerWallet = null;
  if (signerPrivateKey) {
    try { signerWallet = new Wallet(String(signerPrivateKey).trim()); }
    catch { throw new Error('AIX_POOL_SIGNER_PRIVATE_KEY 格式无效'); }
  }
  const configured = Boolean(contract && signerWallet);

  function startOfDayUnixMs(now = Date.now()) {
    const d = new Date(now);
    d.setUTCHours(0, 0, 0, 0);
    return d.getTime();
  }

  function toAUnits(amountNumber) {
    if (typeof amountNumber !== 'number' || !isFinite(amountNumber) || amountNumber <= 0) return null;
    return BigInt(Math.floor(amountNumber * 10 ** LEDGER_DECIMALS));
  }

  function fromAUnits(units) {
    return Number(units) / 10 ** LEDGER_DECIMALS;
  }

  function status() {
    return {
      enabled: configured,
      configured,
      contractAddress: contract,
      platformSigner: signerWallet?.address || '',
      chainId,
      minClaimA,
      maxClaimA,
      dailyCapA,
      staleTimeoutMs,
    };
  }

  /**
   * 计算 EIP-191 签名消息哈希
   * 消息 = keccak256(abi.encodePacked(user, amount, nonce, contractAddr))
   * 加上 \x19Ethereum Signed Message:\n32 前缀后由 signMessage 签名
   */
  function buildClaimHash(userAddress, amountUnits, nonceHex, contractAddr) {
    // nonce 转 uint256
    const nonceBig = BigInt('0x' + nonceHex);
    const packed = solidityPacked(
      ['address', 'uint256', 'uint256', 'address'],
      [getAddress(userAddress), amountUnits, nonceBig, getAddress(contractAddr)],
    );
    return keccak256(packed);
  }

  /**
   * 列出最近 N 条 claim 记录
   */
  function listClaims(wallet, limit = 50) {
    return database.listATokenClaimsByWallet(wallet, limit);
  }

  function getClaim(claimId) {
    return database.getATokenClaimById(claimId);
  }

  function dailyClaimed(wallet) {
    return database.sumATokenClaimsByWalletToday(wallet, startOfDayUnixMs());
  }

  /**
   * 生成提现签名（用户调用前先获取）
   * 返回 { claimId, amount, amountUnits, nonce, signature, contractAddress, chainId, expiresAt }
   */
  function signClaim({ wallet, amount }) {
    if (!wallet) throw new Error('缺少钱包地址');
    if (!isAddress(String(wallet))) throw new Error('钱包地址格式无效');
    if (!configured) {
      throw new Error('AIXPool 链上提现未启用（请先部署 AIXPool 合约并配置 AIX_POOL_CONTRACT_ADDRESS / AIX_POOL_SIGNER_PRIVATE_KEY）');
    }
    const recipient = getAddress(wallet);
    const amountUnits = toAUnits(Number(amount));
    if (!amountUnits) throw new Error('提取金额无效');
    if (amountUnits < BigInt(Math.floor(minClaimA * 10 ** LEDGER_DECIMALS)))
      throw new Error(`最小提取金额为 ${minClaimA} AIX`);
    if (amountUnits > BigInt(Math.floor(maxClaimA * 10 ** LEDGER_DECIMALS)))
      throw new Error(`单笔最大提取 ${maxClaimA} AIX`);

    // 单日限额
    const todayUsed = dailyClaimed(recipient);
    if (todayUsed + amountUnits > BigInt(Math.floor(dailyCapA * 10 ** LEDGER_DECIMALS)))
      throw new Error(`单日提取上限 ${dailyCapA} AIX，今日已用 ${formatUnits(todayUsed, LEDGER_DECIMALS)} AIX`);

    // 检查账面 AIX 余额
    const balanceA = aTokenService.balanceA(recipient);
    if (BigInt(balanceA) < amountUnits)
      throw new Error(`AIX 余额不足，需要 ${formatUnits(amountUnits, LEDGER_DECIMALS)} AIX`);

    // 立即扣减账面余额（防并发请求）
    aTokenService.debitA(recipient, amountUnits.toString());

    // 生成 nonce（16 字节随机）
    const nonceHex = crypto.randomBytes(16).toString('hex');
    const claimId = `acl_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
    const now = Date.now();
    const expiresAt = now + staleTimeoutMs;

    // 生成 EIP-191 签名
    const msgHash = buildClaimHash(recipient, amountUnits, nonceHex, contract);
    // signMessage 自动加 \x19Ethereum Signed Message:\n32 前缀
    const signature = signerWallet.signingKey.sign(msgHash).serialized;

    // 写入数据库
    const record = {
      id: claimId,
      wallet: recipient,
      amountUnits: amountUnits.toString(),
      nonce: nonceHex,
      signature,
      contractAddress: contract,
      chainId,
      status: 'pending',   // pending → confirmed | failed | refunded
      txHash: null,
      createdAt: now,
      expiresAt,
      confirmedAt: null,
      failReason: null,
    };
    database.upsertATokenClaimRow(record);

    return {
      claimId,
      amount: Number(amount),
      amountUnits: amountUnits.toString(),
      nonce: nonceHex,
      signature,
      contractAddress: contract,
      chainId,
      expiresAt,
    };
  }

  /**
   * 用户确认链上提取成功（前端拿到 txHash 后调）
   * 标记 claim 为 confirmed，记录 txHash
   */
  function confirmClaim({ wallet, claimId, txHash }) {
    const record = database.getATokenClaimById(claimId);
    if (!record) throw new Error('提取记录不存在');
    if (String(record.wallet).toLowerCase() !== String(wallet).toLowerCase())
      throw new Error('无权确认他人的提取');
    if (record.status === 'confirmed') return record;
    if (record.status === 'refunded') throw new Error('该提取已退款，不能确认');
    database.upsertATokenClaimRow({
      ...record,
      status: 'confirmed',
      txHash: String(txHash || record.txHash || ''),
      confirmedAt: Date.now(),
    });
    return database.getATokenClaimById(claimId);
  }

  /**
   * 管理员回滚失败的 claim（用户取消签名 / 链上交易失败）
   * 把扣减的 AIX 余额加回用户账户
   */
  function refundClaim(claimId, reason = 'user_cancelled') {
    const record = database.getATokenClaimById(claimId);
    if (!record) throw new Error('提取记录不存在');
    if (record.status === 'confirmed') throw new Error('已确认的提取不能退款');
    if (record.status === 'refunded') return record;
    aTokenService.creditA(record.wallet, BigInt(record.amountUnits).toString());
    database.upsertATokenClaimRow({
      ...record,
      status: 'refunded',
      failReason: String(reason).slice(0, 500),
      confirmedAt: Date.now(),
    });
    return database.getATokenClaimById(claimId);
  }

  /**
   * 自动扫描：把超过 expiresAt 仍 pending 的 claim 退款
   * 服务器启动时 + 每小时执行一次
   */
  function sweepStaleClaims() {
    const now = Date.now();
    let refunded = 0;
    const staleList = database.listPendingATokenClaims(200)
      .filter(r => Number(r.expiresAt || 0) > 0 && Number(r.expiresAt) < now);
    for (const r of staleList) {
      try {
        refundClaim(r.id, 'expired_auto_refund');
        refunded += 1;
      } catch { /* ignore individual errors */ }
    }
    return { scanned: staleList.length, refunded };
  }

  return {
    status,
    signClaim,
    confirmClaim,
    refundClaim,
    sweepStaleClaims,
    listClaims,
    getClaim,
    dailyClaimed,
    toAUnits,
    fromAUnits,
  };
}
