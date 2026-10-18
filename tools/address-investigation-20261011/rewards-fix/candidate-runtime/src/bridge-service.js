import { formatUnits, getAddress, isAddress, parseUnits } from 'ethers';

const DEFAULT_API_URL = 'https://li.quest/v1';
const LEDGER_DECIMALS = 6;

function normalizeAddress(value, label) {
  if (!isAddress(String(value || ''))) throw new Error(`${label}地址无效`);
  return getAddress(String(value));
}

function asBigInt(value, label) {
  try {
    const parsed = BigInt(String(value));
    if (parsed <= 0n) throw new Error();
    return parsed;
  } catch {
    throw new Error(`${label}金额无效`);
  }
}

function ledgerToChainUnits(amountUnits, network) {
  const value = BigInt(amountUnits);
  if (network.tokenDecimals >= LEDGER_DECIMALS) {
    return value * (10n ** BigInt(network.tokenDecimals - LEDGER_DECIMALS));
  }
  const divisor = 10n ** BigInt(LEDGER_DECIMALS - network.tokenDecimals);
  if (value % divisor !== 0n) throw new Error('金额不符合源链 USDT 精度');
  return value / divisor;
}

function chainToLedgerUnits(amountUnits, network) {
  const value = BigInt(amountUnits);
  if (network.tokenDecimals >= LEDGER_DECIMALS) {
    return value / (10n ** BigInt(network.tokenDecimals - LEDGER_DECIMALS));
  }
  return value * (10n ** BigInt(LEDGER_DECIMALS - network.tokenDecimals));
}

function tokenAddress(token) {
  return String(typeof token === 'string' ? token : token?.address || '');
}

export function createBridgeService({
  enabled = false,
  apiUrl = DEFAULT_API_URL,
  apiKey = '',
  settlementNetwork = 'arbitrum',
  networks = [],
  depositAddress = '',
  allowedBridges = ['across', 'stargateV2'],
  slippageBps = 30,
  minimumReceivedBps = 9900,
  fetchImpl = globalThis.fetch,
} = {}) {
  const networkMap = new Map((Array.isArray(networks) ? networks : []).map(network => [String(network.id || '').toLowerCase(), network]));
  const settlement = networkMap.get(String(settlementNetwork || '').toLowerCase());
  const receiver = depositAddress ? normalizeAddress(depositAddress, '平台结算') : '';
  const tools = [...new Set((Array.isArray(allowedBridges) ? allowedBridges : []).map(String).filter(Boolean))];
  const active = Boolean(enabled && settlement && receiver && tools.length && typeof fetchImpl === 'function');
  const baseUrl = String(apiUrl || DEFAULT_API_URL).replace(/\/$/, '');
  const maxSlippage = Math.min(0.03, Math.max(0.0001, Number(slippageBps) / 10_000));
  const minBps = Math.min(10_000, Math.max(9000, Number(minimumReceivedBps) || 9900));

  function headers() {
    return apiKey ? { 'x-lifi-api-key':String(apiKey) } : {};
  }

  async function readJson(url) {
    const response = await fetchImpl(url, { headers:headers(), signal:AbortSignal.timeout(15_000) });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(String(body?.message || body?.error || `跨链报价服务返回 ${response.status}`));
    return body;
  }

  function publicConfig() {
    return {
      enabled:active,
      settlementNetwork:settlement?.id || '',
      settlementNetworkName:settlement?.name || '',
      allowedBridges:tools,
      slippageBps:Math.round(maxSlippage * 10_000),
      minimumReceivedBps:minBps,
    };
  }

  function validateQuote(quote, { source, target, sender, recipient, amountUnits }) {
    if (!quote || !tools.includes(String(quote.tool || ''))) throw new Error('报价未使用平台允许的跨链桥');
    const action = quote.action || {};
    if (Number(action.fromChainId) !== Number(source.chainId) || Number(action.toChainId) !== Number(target.chainId)) {
      throw new Error('跨链报价网络不匹配');
    }
    if (tokenAddress(action.fromToken).toLowerCase() !== String(source.tokenContract).toLowerCase()
      || tokenAddress(action.toToken).toLowerCase() !== String(target.tokenContract).toLowerCase()) {
      throw new Error('跨链报价 USDT 合约不匹配');
    }
    if (String(action.fromAddress || '').toLowerCase() !== sender.toLowerCase()
      || String(action.toAddress || '').toLowerCase() !== recipient.toLowerCase()) {
      throw new Error('跨链报价钱包地址不匹配');
    }
    const sourceAmount = ledgerToChainUnits(amountUnits, source);
    if (asBigInt(action.fromAmount, '跨链发送') !== sourceAmount) throw new Error('跨链报价发送金额不匹配');
    const minimum = chainToLedgerUnits(asBigInt(quote.estimate?.toAmountMin, '跨链最小到账'), target);
    if (minimum * 10_000n < BigInt(amountUnits) * BigInt(minBps)) throw new Error('跨链报价最小到账低于平台风控线');
    const tx = quote.transactionRequest || {};
    if (!isAddress(String(tx.to || '')) || !/^0x[0-9a-fA-F]*$/.test(String(tx.data || ''))) {
      throw new Error('跨链报价交易数据无效');
    }
    if (tx.from && String(tx.from).toLowerCase() !== sender.toLowerCase()) throw new Error('跨链交易发起钱包不匹配');
    if (tx.chainId && Number(tx.chainId) !== Number(source.chainId)) throw new Error('跨链交易链 ID 不匹配');
    return {
      mode:'bridge',
      tool:String(quote.tool),
      fromNetwork:source.id,
      toNetwork:target.id,
      fromAmount:formatUnits(sourceAmount, source.tokenDecimals),
      estimatedReceived:formatUnits(asBigInt(quote.estimate?.toAmount, '跨链预计到账'), target.tokenDecimals),
      minimumReceived:formatUnits(asBigInt(quote.estimate?.toAmountMin, '跨链最小到账'), target.tokenDecimals),
      approvalAddress:isAddress(String(quote.estimate?.approvalAddress || '')) ? getAddress(quote.estimate.approvalAddress) : '',
      transactionRequest:{
        from:sender,
        to:getAddress(tx.to),
        data:String(tx.data),
        value:String(tx.value || '0x0'),
        chainId:Number(source.chainId),
        ...(tx.gasLimit ? { gasLimit:String(tx.gasLimit) } : {}),
      },
    };
  }

  async function quote({ fromNetwork, toNetwork, sender, recipient, amount }) {
    if (!active) throw new Error('平台跨链功能尚未启用');
    const source = networkMap.get(String(fromNetwork || '').toLowerCase());
    const target = networkMap.get(String(toNetwork || '').toLowerCase());
    if (!source || !target || source.id === target.id) throw new Error('跨链报价网络无效');
    const from = normalizeAddress(sender, '发送钱包');
    const to = normalizeAddress(recipient, '接收钱包');
    let amountUnits;
    try { amountUnits = parseUnits(String(amount || '').trim(), LEDGER_DECIMALS); }
    catch { throw new Error('跨链金额格式不正确'); }
    if (amountUnits <= 0n) throw new Error('跨链金额必须大于 0');
    const params = new URLSearchParams({
      fromChain:String(source.chainId),
      toChain:String(target.chainId),
      fromToken:String(source.tokenContract),
      toToken:String(target.tokenContract),
      fromAmount:ledgerToChainUnits(amountUnits, source).toString(),
      fromAddress:from,
      toAddress:to,
      allowBridges:tools.join(','),
      slippage:String(maxSlippage),
      order:'CHEAPEST',
    });
    const result = await readJson(`${baseUrl}/quote?${params}`);
    return validateQuote(result, { source, target, sender:from, recipient:to, amountUnits });
  }

  async function depositQuote({ wallet, network, amount }) {
    const source = networkMap.get(String(network || '').toLowerCase());
    if (!source) throw new Error('暂不支持该充值网络');
    if (source.id === settlement.id) return { mode:'direct', settlementNetwork:settlement.id };
    return quote({ fromNetwork:source.id, toNetwork:settlement.id, sender:wallet, recipient:receiver, amount });
  }

  async function withdrawalQuote({ wallet, network, amount }) {
    const target = networkMap.get(String(network || '').toLowerCase());
    if (!target) throw new Error('暂不支持该提现网络');
    if (target.id === settlement.id) return { mode:'direct', settlementNetwork:settlement.id };
    let requestedUnits;
    try { requestedUnits = parseUnits(String(amount || '').trim(), LEDGER_DECIMALS); }
    catch { throw new Error('提现跨链金额格式不正确'); }
    // The platform pays bridge fees so the user's requested amount remains the
    // minimum destination amount instead of silently shrinking after fees.
    const fundedUnits = (requestedUnits * 10_000n + BigInt(minBps) - 1n) / BigInt(minBps);
    const result = await quote({
      fromNetwork:settlement.id,
      toNetwork:target.id,
      sender:receiver,
      recipient:wallet,
      amount:formatUnits(fundedUnits, LEDGER_DECIMALS),
    });
    const minimumUnits = parseUnits(result.minimumReceived, target.tokenDecimals);
    if (chainToLedgerUnits(minimumUnits, target) < requestedUnits) throw new Error('跨链报价无法保证用户提现数量');
    return { ...result, requestedAmount:formatUnits(requestedUnits, LEDGER_DECIMALS) };
  }

  async function status({ txHash, fromNetwork, toNetwork, tool = '' }) {
    if (!active) throw new Error('平台跨链功能尚未启用');
    const source = networkMap.get(String(fromNetwork || '').toLowerCase());
    const target = networkMap.get(String(toNetwork || '').toLowerCase());
    if (!source || !target) throw new Error('跨链状态网络无效');
    if (tool && !tools.includes(String(tool))) throw new Error('跨链工具不在平台允许列表');
    const params = new URLSearchParams({ txHash:String(txHash), fromChain:String(source.chainId), toChain:String(target.chainId) });
    if (tool) params.set('bridge', String(tool));
    return readJson(`${baseUrl}/status?${params}`);
  }

  return { publicConfig, depositQuote, withdrawalQuote, status, settlementNetwork:settlement?.id || '', minimumReceivedBps:minBps, enabled:active };
}
