import {
  Interface,
  JsonRpcProvider,
  Wallet,
  formatUnits,
  getAddress,
  isAddress,
  keccak256,
  parseUnits,
} from 'ethers';

const LEDGER_DECIMALS = 6;
const PAYOUT_STATES = new Set(['pending_auto', 'processing', 'signed', 'broadcast']);
const TRANSFER_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
];
const tokenInterface = new Interface(TRANSFER_ABI);

function chainAmount(amountUnits, tokenDecimals) {
  const value = BigInt(amountUnits);
  if (tokenDecimals >= LEDGER_DECIMALS) return value * (10n ** BigInt(tokenDecimals - LEDGER_DECIMALS));
  const divisor = 10n ** BigInt(LEDGER_DECIMALS - tokenDecimals);
  if (value % divisor !== 0n) throw new Error('提现金额不符合该网络的代币精度');
  return value / divisor;
}

function errorMessage(error) {
  return String(error?.shortMessage || error?.reason || error?.message || error || '自动出款失败');
}

export function createWithdrawalPayoutService({
  walletService,
  networks = [],
  withdrawalAddress = '',
  privateKey = '',
  enabled = false,
  isEnabled = null,
  pollIntervalMs = 15_000,
  bridgeService = null,
  swap = {},
} = {}) {
  const {
    enabled:swapEnabled = false,
    usdcContract = '',
    v3Router = '',
    v3Quoter = '',
    v3FeeTiers = [],
    slippageBps:swapSlippageBps = 30,
  } = swap || {};
  if (!walletService) throw new Error('自动出款服务缺少钱包账本');
  const requested = Boolean(enabled);
  const configuredAddress = isAddress(String(withdrawalAddress || '')) ? getAddress(withdrawalAddress) : '';
  let baseWallet = null;
  if (privateKey) {
    try { baseWallet = new Wallet(String(privateKey).trim()); }
    catch { throw new Error('PLATFORM_WITHDRAWAL_PRIVATE_KEY 格式无效'); }
  }
  if (requested && !baseWallet) throw new Error('已开启自动提现，但未配置 PLATFORM_WITHDRAWAL_PRIVATE_KEY');
  if (requested && !configuredAddress) throw new Error('已开启自动提现，但未配置有效的 PLATFORM_WITHDRAWAL_ADDRESS');
  if (baseWallet && configuredAddress && baseWallet.address.toLowerCase() !== configuredAddress.toLowerCase()) {
    throw new Error('自动提现私钥与 PLATFORM_WITHDRAWAL_ADDRESS 不匹配');
  }
  // 闪兑提现（USDC→USDT，PancakeSwap V3 纯链上）启动前校验（getAddress 接受小写/全大写/合法校验和地址）
  let swapUsdc = '';
  let swapRouter = '';
  let swapQuoter = '';
  if (swapEnabled) {
    try { swapUsdc = getAddress(String(usdcContract || '').trim()); } catch { swapUsdc = ''; }
    try { swapRouter = getAddress(String(v3Router || '').trim()); } catch { swapRouter = ''; }
    try { swapQuoter = getAddress(String(v3Quoter || '').trim()); } catch { swapQuoter = ''; }
  }
  const V3_ALLOWED_FEES = new Set([100, 500, 2500, 10000]);
  const swapFeeTiers = (Array.isArray(v3FeeTiers) ? v3FeeTiers : [])
    .map(value => Number(value))
    .filter(fee => V3_ALLOWED_FEES.has(fee));
  const swapReady = Boolean(swapEnabled && swapUsdc && swapRouter && swapQuoter && swapFeeTiers.length);
  if (requested && swapEnabled && !swapReady) {
    throw new Error('已开启闪兑提现，但 USDC 合约或 PancakeSwap V3 路由/报价合约地址配置无效');
  }
  const swapSlippagePct = Math.min(2, Math.max(0.1, Number(swapSlippageBps) / 100));

  const contexts = new Map((Array.isArray(networks) ? networks : []).map(item => {
    const id = String(item.id || '').toLowerCase();
    if (!id || !item.chainId || !isAddress(String(item.tokenContract || ''))) return null;
    const provider = item.provider || new JsonRpcProvider(String(item.rpcUrl || ''), Number(item.chainId), { staticNetwork:true });
    return [id, {
      id,
      chainId:Number(item.chainId),
      confirmations:Math.max(1, Number(item.confirmations) || 1),
      tokenContract:getAddress(String(item.tokenContract)),
      tokenDecimals:Number(item.tokenDecimals ?? LEDGER_DECIMALS),
      provider,
      signer:item.signer || baseWallet?.connect(provider) || null,
    }];
  }).filter(Boolean));
  const configured = Boolean(baseWallet && configuredAddress && contexts.size);
  const settingEnabled = () => typeof isEnabled === 'function' ? Boolean(isEnabled()) : requested;
  const isActive = () => configured && settingEnabled();
  const canProcessRecord = record => configured
    && (settingEnabled() || ['signed', 'broadcast'].includes(record?.status));
  const networkQueues = new Map();
  const inFlight = new Set();
  // 瞬时失败自动重试：最多 5 次出款尝试，间隔逐步拉长
  const MAX_PAYOUT_ATTEMPTS = 5;
  const RETRY_DELAYS_MS = [15_000, 45_000, 120_000, 300_000];
  const retryHolds = new Map();
  let timer = null;

  function status() {
    return {
      enabled:isActive(),
      requested:settingEnabled(),
      configured,
      signerAddress:baseWallet?.address || '',
      networks:[...contexts.keys()],
      swap:{
        enabled:swapReady,
        provider:swapEnabled ? 'pancake-v3' : 'direct',
        usdcContract:swapUsdc,
        router:swapRouter,
        feeTiers:swapFeeTiers,
        slippageBps:Math.round(swapSlippagePct * 100),
      },
    };
  }

  // ── PancakeSwap V3 纯链上兑换（USDC→USDT，V3 池把 USDT 直打用户地址）────────
  // 不依赖任何第三方 HTTP 服务：询价走链上 QuoterV2 合约，兑换走 V3 SwapRouter。
  const v3QuoterInterface = new Interface([
    'function quoteExactOutputSingle((address tokenIn,address tokenOut,uint256 amount,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountIn,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)',
  ]);
  const v3RouterInterface = new Interface([
    'function exactOutputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 deadline,uint256 amountOut,uint256 amountInMaximum,uint160 sqrtPriceLimitX96)) returns (uint256 amountIn)',
  ]);

  // 多费率池询价（精确输出：给定 USDT 提现额倒推 USDC 用量），返回 USDC 花费最少的费率池
  async function quoteV3(context, amountOut) {
    let best = null;
    for (const fee of swapFeeTiers) {
      try {
        const data = v3QuoterInterface.encodeFunctionData('quoteExactOutputSingle', [[
          swapUsdc, context.tokenContract, amountOut, fee, 0,
        ]]);
        const encoded = await context.provider.call({ to:swapQuoter, data });
        const [amountIn] = v3QuoterInterface.decodeFunctionResult('quoteExactOutputSingle', encoded);
        const needed = BigInt(amountIn);
        if (needed > 0n && (!best || needed < best.amountIn)) best = { amountIn:needed, fee };
      } catch { /* 该费率档无池或流动性不足，尝试下一档 */ }
    }
    if (!best) throw new Error('USDC 闪兑报价失败：链上流动性不足，请稍后重试或联系客服');
    return best;
  }

  // 构建 V3 精确输出兑换：amountOut 固定（用户足额收到），amountInMaximum 为平台花费的滑点上限；
  // recipient 直接填用户地址，V3 池在同一笔交易内把 USDT 打给用户，不经过平台其他账户。
  function buildV3Swap(context, fee, amountOut, amountInMaximum, recipient) {
    const data = v3RouterInterface.encodeFunctionData('exactOutputSingle', [[
      swapUsdc,
      context.tokenContract,
      fee,
      recipient,
      Math.floor(Date.now() / 1000) + 600,
      amountOut,
      amountInMaximum,
      0,
    ]]);
    return { to:swapRouter, data, value:0n };
  }

  async function readTokenBalance(context, token) {
    const data = tokenInterface.encodeFunctionData('balanceOf', [context.signer.address]);
    const encoded = await context.provider.call({ to:token, data });
    const [balance] = tokenInterface.decodeFunctionResult('balanceOf', encoded);
    return BigInt(balance);
  }

  // 余额读取防误判：相隔约 1.2 秒读两次，取较大值。
  // 避免单个 RPC 节点 eth_call 瞬时返回脏数据（如 0 或低值）导致把本来够钱的提现误挂起。
  async function readConfirmedBalance(context, token) {
    const first = await readTokenBalance(context, token);
    await new Promise(resolve => setTimeout(resolve, 1_200));
    try {
      const second = await readTokenBalance(context, token);
      return first > second ? first : second;
    } catch {
      return first;
    }
  }

  async function checkReceipt(record, context) {
    const receipt = await context.provider.getTransactionReceipt(record.txHash);
    if (!receipt) return false;
    if (Number(receipt.status) !== 1) {
      // 链上 revert（多为池子瞬时价格波动），抛出带标记的错误，由 process 统一决定自动重试或退款
      throw Object.assign(new Error('链上出款交易执行失败'), { chainFailed:true });
    }
    const currentBlock = await context.provider.getBlockNumber();
    const confirmations = Math.max(0, currentBlock - Number(receipt.blockNumber) + 1);
    if (confirmations < context.confirmations) return false;
    walletService.recordPaidPayout(record.id, confirmations);
    return true;
  }

  async function sendApproval(context, spender, amount) {
    const allowanceData = tokenInterface.encodeFunctionData('allowance', [context.signer.address, spender]);
    const encoded = await context.provider.call({ to:context.tokenContract, data:allowanceData });
    const [current] = tokenInterface.decodeFunctionResult('allowance', encoded);
    if (BigInt(current) >= amount) return;
    const approve = async value => {
      const data = tokenInterface.encodeFunctionData('approve', [spender, value]);
      const transaction = await context.signer.populateTransaction({ to:context.tokenContract, data });
      const raw = await context.signer.signTransaction(transaction);
      const response = await context.provider.broadcastTransaction(raw);
      const receipt = typeof response?.wait === 'function'
        ? await response.wait(context.confirmations)
        : await context.provider.waitForTransaction(response?.hash || keccak256(raw), context.confirmations);
      if (!receipt || Number(receipt.status) !== 1) throw new Error('跨链授权交易失败');
    };
    if (BigInt(current) > 0n) await approve(0n);
    await approve(amount);
  }

  // 通用 ERC20 授权（可指定任意 token 合约，用于 USDC→router 授权）
  async function sendTokenApproval(context, tokenAddress, spender, amount) {
    const allowanceData = tokenInterface.encodeFunctionData('allowance', [context.signer.address, spender]);
    const encoded = await context.provider.call({ to: tokenAddress, data: allowanceData });
    const [current] = tokenInterface.decodeFunctionResult('allowance', encoded);
    if (BigInt(current) >= amount) return;
    const approve = async value => {
      const data = tokenInterface.encodeFunctionData('approve', [spender, value]);
      const transaction = await context.signer.populateTransaction({ to: tokenAddress, data });
      const raw = await context.signer.signTransaction(transaction);
      const response = await context.provider.broadcastTransaction(raw);
      const receipt = typeof response?.wait === 'function'
        ? await response.wait(context.confirmations)
        : await context.provider.waitForTransaction(response?.hash || keccak256(raw), context.confirmations);
      if (!receipt || Number(receipt.status) !== 1) throw new Error('代币授权交易失败');
    };
    if (BigInt(current) > 0n) await approve(0n);
    await approve(amount);
  }

  async function checkBridgeReceipt(record, sourceContext, targetContext) {
    const sourceReceipt = await sourceContext.provider.getTransactionReceipt(record.txHash);
    if (!sourceReceipt) return false;
    if (Number(sourceReceipt.status) !== 1) {
      walletService.recordFailedPayout(record.id, '跨链提现源交易执行失败', { chainFailed:true });
      return true;
    }
    const result = await bridgeService.status({
      txHash:record.txHash,
      fromNetwork:bridgeService.settlementNetwork,
      toNetwork:record.network,
      tool:record.routeTool,
    });
    const status = String(result?.status || '').toUpperCase();
    if (['NOT_FOUND', 'PENDING', 'INVALID', ''].includes(status)) return false;
    if (status === 'FAILED') {
      walletService.recordFailedPayout(record.id, `跨链提现失败，需人工核对退款：${result?.substatusMessage || result?.substatus || '未知原因'}`, { terminal:true });
      return true;
    }
    if (status !== 'DONE') return false;
    const destinationHash = String(result?.receiving?.txHash || '');
    if (!/^0x[0-9a-fA-F]{64}$/.test(destinationHash)) throw new Error('跨链提现缺少目标链交易哈希');
    if (Number(result?.receiving?.chainId) !== targetContext.chainId
      || String(result?.receiving?.token?.address || '').toLowerCase() !== targetContext.tokenContract.toLowerCase()) {
      throw new Error('跨链提现目标资产不匹配');
    }
    const receipt = await targetContext.provider.getTransactionReceipt(destinationHash);
    if (!receipt || Number(receipt.status) !== 1) return false;
    let received = 0n;
    for (const log of receipt.logs || []) {
      if (String(log.address || '').toLowerCase() !== targetContext.tokenContract.toLowerCase()) continue;
      try {
        const parsed = tokenInterface.parseLog(log);
        if (parsed?.name === 'Transfer' && String(parsed.args[1]).toLowerCase() === record.address.toLowerCase()) {
          received += BigInt(parsed.args[2]);
        }
      } catch { /* unrelated log */ }
    }
    const requested = chainAmount(record.amountUnits, targetContext.tokenDecimals);
    if (received < requested) throw new Error('跨链提现实际到账低于用户申请金额');
    const currentBlock = await targetContext.provider.getBlockNumber();
    const confirmations = Math.max(0, currentBlock - Number(receipt.blockNumber) + 1);
    if (confirmations < targetContext.confirmations) return false;
    walletService.recordPaidPayout(record.id, confirmations, { destinationTxHash:destinationHash.toLowerCase(), receivedChainUnits:received.toString() });
    return true;
  }

  async function process(id) {
    if (!configured || inFlight.has(id)) return;
    inFlight.add(id);
    try {
      let record = walletService.payoutRecord(id);
      if (!record || !canProcessRecord(record)) return;
      record = walletService.claimPayout(id);
      if (!record || !PAYOUT_STATES.has(record.status)) return;
      const targetContext = contexts.get(String(record.network || '').toLowerCase());
      if (!targetContext) throw new Error(`自动出款不支持网络 ${record.network || '-'}`);
      const crossChain = Boolean(bridgeService?.enabled && record.network !== bridgeService.settlementNetwork);
      const context = crossChain ? contexts.get(bridgeService.settlementNetwork) : targetContext;
      if (!context) throw new Error('自动出款缺少平台结算网络');

      if (record.status === 'processing') {
        let transaction;
        let routeTool = '';
        let sourceAmount = chainAmount(record.amountUnits, context.tokenDecimals);

        // 闪兑开关已开但配置不全时，禁止静默回退到直转（那会错误地花平台 USDT 余额）
        if (swapEnabled && !crossChain && !swapReady) {
          throw new Error('闪兑提现未正确配置，请检查 USDC 合约与 PancakeSwap V3 合约地址');
        }

        // === USDC→USDT 闪兑提现（平台钱包持 USDC，经 PancakeSwap V3 纯链上兑换，USDT 直打用户）===
        if (swapReady && !crossChain) {
          const targetUsdt = sourceAmount;
          // 1. 多费率池链上询价，选 USDC 花费最少的池
          const { amountIn:usdcNeeded, fee } = await quoteV3(context, targetUsdt);
          // 2. 平台最多花费的 USDC（询价额 + 滑点上限）
          const swapBps = BigInt(Math.round(swapSlippagePct * 100));
          const usdcMax = usdcNeeded * (10000n + swapBps) / 10000n + 1n;
          // 3. 检查出款钱包 USDC 余额（二次确认读取，防 RPC 脏数据误判）
          const usdcBalance = await readConfirmedBalance(context, swapUsdc);
          if (usdcBalance < usdcMax) throw new Error('平台出款钱包 USDC 余额不足');
          // 4. 授权 V3 Router 动用本次 USDC（额度不超过滑点上限）
          await sendTokenApproval(context, swapUsdc, swapRouter, usdcMax);
          // 5. 兑换交易：recipient=用户地址，USDT 由 V3 池直接打给用户
          const swapTx = buildV3Swap(context, fee, targetUsdt, usdcMax, getAddress(record.address));
          transaction = await context.signer.populateTransaction({
            to:swapTx.to, data:swapTx.data, value:swapTx.value,
          });
          routeTool = `pancake-v3:f${fee}`;
        }

        // === 跨链桥提现（已禁用，保留兼容）===
        if (crossChain) {
          const quote = await bridgeService.withdrawalQuote({ wallet:record.address, network:record.network, amount:formatUnits(record.amountUnits, LEDGER_DECIMALS) });
          routeTool = quote.tool;
          sourceAmount = parseUnits(quote.fromAmount, context.tokenDecimals);
          if (!quote.approvalAddress) throw new Error('跨链报价缺少 USDT 授权地址');
          await sendApproval(context, quote.approvalAddress, sourceAmount);
          transaction = await context.signer.populateTransaction(quote.transactionRequest);
        }

        // === 直转提现（swap 未启用时的 fallback）===
        const amount = sourceAmount;
        if (!transaction && !crossChain) {
          const tokenBalance = await readConfirmedBalance(context, context.tokenContract);
          if (BigInt(tokenBalance) < amount) throw new Error('平台出款钱包 USDT 余额不足');
          const data = tokenInterface.encodeFunctionData('transfer', [record.address, amount]);
          transaction = await context.signer.populateTransaction({ to:context.tokenContract, data });
        }
        const rawTransaction = await context.signer.signTransaction(transaction);
        const txHash = keccak256(rawTransaction);
        record = walletService.recordSignedPayout(record.id, {
          txHash,
          rawTransaction,
          nonce:transaction.nonce,
          routeTool,
          sourceNetwork:context.id,
        });
      }

      if (record.status === 'signed') {
        try {
          const response = await context.provider.broadcastTransaction(record.rawTransaction);
          if (response?.hash && String(response.hash).toLowerCase() !== record.txHash.toLowerCase()) {
            throw new Error('节点返回的交易哈希与本地签名不一致');
          }
        } catch (error) {
          const known = await context.provider.getTransaction(record.txHash).catch(() => null);
          if (!known) throw error;
        }
        record = walletService.recordBroadcastPayout(record.id);
      }

      if (record.status === 'broadcast') {
        const settled = crossChain
          ? await checkBridgeReceipt(record, context, targetContext)
          : await checkReceipt(record, context);
        if (!settled && record.rawTransaction) {
          const known = await context.provider.getTransaction(record.txHash).catch(() => null);
          if (!known) await context.provider.broadcastTransaction(record.rawTransaction);
        }
      }
    } catch (error) {
      try {
        const fresh = walletService.payoutRecord(id);
        const reason = errorMessage(error);
        const chainFailed = error?.chainFailed === true;
        // 余额不足：挂起等待人工补币放行，不自动退款、不重试
        const insufficientFunds = /余额不足/.test(reason);
        // 其他配置/资金类问题重试无意义：私钥/配置错误、网络或资产不支持
        const nonRetryable = /未正确配置|不支持|私钥|不匹配/.test(reason);
        const attempts = Number(fresh?.attempts) || 1;
        if (fresh && PAYOUT_STATES.has(fresh.status) && insufficientFunds) {
          retryHolds.delete(id);
          walletService.holdPayout(id, { reason });
          console.error(`[自动出款] 出款钱包余额不足，挂起等待人工补币放行 id=${id} reason=${reason}`);
        } else if (fresh && PAYOUT_STATES.has(fresh.status) && !nonRetryable && attempts < MAX_PAYOUT_ATTEMPTS) {
          const delay = RETRY_DELAYS_MS[Math.min(attempts - 1, RETRY_DELAYS_MS.length - 1)];
          walletService.requeuePayout(id, { reason });
          retryHolds.set(id, Date.now() + delay);
          console.error(`[自动出款] 瞬时失败，${Math.round(delay/1000)}秒后自动重试 attempt=${attempts}/${MAX_PAYOUT_ATTEMPTS} id=${id} reason=${reason}`);
          setTimeout(() => {
            retryHolds.delete(id);
            enqueue(id).catch(() => {});
          }, delay).unref?.();
        } else {
          retryHolds.delete(id);
          walletService.recordFailedPayout(id, reason, { chainFailed });
        }
      } catch (inner) {
        console.error('[自动出款] 重试决策异常', inner);
        try { walletService.recordFailedPayout(id, errorMessage(error), { chainFailed:Boolean(error?.chainFailed) }); } catch { /* give up safely */ }
      }
    } finally {
      inFlight.delete(id);
    }
  }

  function enqueue(id) {
    if (!configured || !id) return Promise.resolve(false);
    const holdUntil = retryHolds.get(id);
    if (holdUntil && holdUntil > Date.now()) return Promise.resolve(false);
    if (holdUntil) retryHolds.delete(id);
    const record = walletService.payoutRecord(id);
    if (!record || !PAYOUT_STATES.has(record.status) || !canProcessRecord(record)) return Promise.resolve(false);
    const network = String(record.network || '').toLowerCase();
    const previous = networkQueues.get(network) || Promise.resolve();
    const queued = previous.catch(() => {}).then(() => process(id));
    const tracked = queued.finally(() => {
      if (networkQueues.get(network) === tracked) networkQueues.delete(network);
    });
    networkQueues.set(network, tracked);
    return tracked.then(() => true);
  }

  function scan() {
    if (!configured) return;
    const now = Date.now();
    for (const record of walletService.payoutQueue()) {
      const holdUntil = retryHolds.get(record.id);
      if (holdUntil) {
        if (holdUntil > now) continue;
        retryHolds.delete(record.id);
      }
      enqueue(record.id).catch(() => {});
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

  return { enqueue, scan, start, status, stop };
}
