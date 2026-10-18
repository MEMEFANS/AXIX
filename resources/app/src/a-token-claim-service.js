// Legacy AIXPool authorizations do not expire on-chain. Never refund issued claims by timeout.
import crypto from 'node:crypto';
import {
  Wallet,
  solidityPacked,
  keccak256,
  hashMessage,
  getBytes,
  parseUnits,
  Interface,
  Contract,
  JsonRpcProvider,
  isAddress,
  getAddress,
  formatUnits,
} from 'ethers';
import { A_TOKEN_DECIMALS } from './a-token-service.js';

const LEDGER_DECIMALS = A_TOKEN_DECIMALS; // 18
const BSC_CHAIN_ID = 56;

export function createATokenClaimService({
  aTokenService,           // 提供 balanceA / debitA / creditA
  walletService,
  provider,
  rpcUrl,
  confirmations = 15,
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

  const chainProvider = provider || (rpcUrl ? new JsonRpcProvider(rpcUrl, chainId) : null);
  const pool = configured && chainProvider ? new Contract(contract, ['function isClaimUsed(address,uint256,uint256) view returns (bool)'], chainProvider) : null;

  function startOfDayUnixMs(now = Date.now()) {
    const d = new Date(now);
    d.setUTCHours(0, 0, 0, 0);
    return d.getTime();
  }

  function toAUnits(amountNumber) {
    try { const units = parseUnits(String(amountNumber), LEDGER_DECIMALS); return units > 0n ? units : null; }
    catch { return null; }
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
      automaticRefunds: false,
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
    const amountUnits = toAUnits(amount);
    if (!amountUnits) throw new Error('提取金额无效');
    if (amountUnits < parseUnits(String(minClaimA), LEDGER_DECIMALS))
      throw new Error(`最小提取金额为 ${minClaimA} AIX`);
    if (amountUnits > parseUnits(String(maxClaimA), LEDGER_DECIMALS))
      throw new Error(`单笔最大提取 ${maxClaimA} AIX`);

    // 单日限额
    const todayUsed = dailyClaimed(recipient);
    if (todayUsed + amountUnits > parseUnits(String(dailyCapA), LEDGER_DECIMALS))
      throw new Error(`单日提取上限 ${dailyCapA} AIX，今日已用 ${formatUnits(todayUsed, LEDGER_DECIMALS)} AIX`);

    // 检查账面 AIX 余额
    const balanceA = aTokenService.balanceA(recipient);
    if (BigInt(balanceA) < amountUnits)
      throw new Error(`AIX 余额不足，需要 ${formatUnits(amountUnits, LEDGER_DECIMALS)} AIX`);

    // 立即扣减账面余额（防并发请求）
    // Debit and claim persistence commit together below.

    // 生成 nonce（16 字节随机）
    const nonceHex = crypto.randomBytes(16).toString('hex');
    const claimId = `acl_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
    const now = Date.now();
    const expiresAt = now + staleTimeoutMs;

    // 生成 EIP-191 签名
    const msgHash = buildClaimHash(recipient, amountUnits, nonceHex, contract);
    // signMessage 自动加 \x19Ethereum Signed Message:\n32 前缀
    const signature = signerWallet.signingKey.sign(hashMessage(getBytes(msgHash))).serialized;

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
    if (!walletService?.beginAtomicUpdate) throw new Error('提取服务缺少原子账本支持');
    const update = walletService.beginAtomicUpdate();
    try {
      database.transaction(() => {
        aTokenService.debitA(recipient, amountUnits.toString());
        walletService.validateState();
        database.replaceWalletStateInside(update.exportState());
        database.upsertATokenClaimRow(record);
      });
      update.finish();
    } catch (error) { update.rollback(); throw error; }

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
  async function confirmClaim({ wallet, claimId, txHash }) {
    const record = database.getATokenClaimById(claimId);
    if (!record) throw new Error('提取记录不存在');
    if (String(record.wallet).toLowerCase() !== String(wallet).toLowerCase())
      throw new Error('无权确认他人的提取');
    if (record.status === 'confirmed') return record;
    if (record.status === 'refunded') throw new Error('该提取已退款，不能确认');
    if (!pool || !/^0x[0-9a-f]{64}$/i.test(String(txHash || ''))) throw new Error('无法核查链上提取交易');
    const network = await chainProvider.getNetwork();
    if (Number(network.chainId) !== Number(record.chainId)) throw new Error('提取网络不匹配');
    const receipt = await chainProvider.getTransactionReceipt(txHash);
    if (!receipt || receipt.status !== 1 || String(receipt.to).toLowerCase() !== record.contractAddress.toLowerCase()) throw new Error('提取交易尚未成功');
    const block = await chainProvider.getBlockNumber();
    if (block - receipt.blockNumber + 1 < confirmations) throw new Error('提取交易确认数不足');
    const eventInterface = new Interface(['event Harvested(address indexed user,uint256 amount,uint256 nonce,uint256 newReserve)']);
    const matched = receipt.logs.some(log => {
      if (String(log.address).toLowerCase() !== record.contractAddress.toLowerCase()) return false;
      try { const event = eventInterface.parseLog(log); return event?.name === 'Harvested' && event.args.user.toLowerCase() === record.wallet.toLowerCase() && event.args.amount === BigInt(record.amountUnits) && event.args.nonce === BigInt('0x' + record.nonce); } catch { return false; }
    });
    if (!matched || !await pool.isClaimUsed(record.wallet, record.amountUnits, BigInt('0x' + record.nonce))) throw new Error('链上交易与提取授权不匹配');
    database.upsertATokenClaimRow({
      ...record,
      status: 'confirmed',
      txHash: String(txHash || record.txHash || ''),
      confirmedAt: Date.now(),
    });
    return database.getATokenClaimById(claimId);
  }

  /**
   * 旧合约签名无法撤销。拒绝退款，避免仍有效的授权产生重复支出。
   */
  function refundClaim(claimId) {
    const record = database.getATokenClaimById(claimId);
    if (!record) throw new Error('提取记录不存在');
    if (record.status === 'confirmed') throw new Error('已确认的提取不能退款');
    if (record.status === 'refunded') return record;
    throw new Error('该合约的提取授权无法按超时撤销，禁止退款；请先完成链上授权作废及资金核对');
  }

  function sweepStaleClaims() {
    const staleList = database.listPendingATokenClaims(200).filter(r => Number(r.expiresAt || 0) > 0 && Number(r.expiresAt) < Date.now());
    return { scanned: staleList.length, refunded: 0, requiresReconciliation: staleList.length };
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
