import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import http from 'node:http';
import zlib from 'node:zlib';
import {
  Contract,
  Interface,
  JsonRpcProvider,
  FetchRequest,
  formatUnits,
  getAddress,
  isAddress,
  parseUnits,
  verifyTypedData,
  Wallet,
} from 'ethers';
import { recoverLedgerTransaction } from './atomic-ledger.js';
import { openDatabase } from './database.js';

const LOGIN_TTL_MS = 5 * 60_000;
const SESSION_TTL_MS = 24 * 60 * 60_000;
const REQUEST_ID = /^[A-Za-z0-9._:-]{8,80}$/;
const MAX_PENDING_DEPOSITS = 10;
const PENDING_DEPOSIT_TTL_MS = 7 * 24 * 60 * 60_000;
const LEDGER_DECIMALS = 6;
const MAX_ADMIN_TEST_CREDIT_UNITS = 100_000_000n * 10n ** BigInt(LEDGER_DECIMALS);
const TRANSFER_ABI = [
  'function transfer(address to, uint256 amount) returns (bool)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
];
const transferInterface = new Interface(TRANSFER_ABI);

function nowIso() {
  return new Date().toISOString();
}

function normalizeAddress(value) {
  if (!isAddress(String(value || ''))) throw new Error('无效的 EVM 钱包地址');
  return getAddress(String(value));
}

function normalizeHash(value) {
  const hash = String(value || '').trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new Error('无效的交易哈希');
  return hash.toLowerCase();
}

function safeInteger(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) return fallback;
  return parsed;
}

export function createWalletService(options = {}) {
  const dataRoot = path.resolve(options.dataRoot || '.');
  const stateFile = path.join(dataRoot, 'wallet-accounts.json');
  recoverLedgerTransaction(dataRoot);
  const database = openDatabase(dataRoot);
  const sessionHours = safeInteger(options.sessionHours, 24, 1, 24 * 30);
  const sessionTtlMs = sessionHours * 60 * 60_000 || SESSION_TTL_MS;
  const depositAddress = isAddress(String(options.depositAddress || ''))
    ? getAddress(String(options.depositAddress))
    : '';
  const withdrawalAddress = isAddress(String(options.withdrawalAddress || ''))
    ? getAddress(String(options.withdrawalAddress))
    : depositAddress;
  const bridgeService = options.bridgeService?.enabled ? options.bridgeService : null;
  const settlementNetwork = bridgeService?.settlementNetwork || '';
  const defaultAutoWithdrawalEnabled = Boolean(options.autoWithdrawalEnabled);
  let defaultReviewThresholdUnits;
  try { defaultReviewThresholdUnits = parseUnits(String(options.autoWithdrawalReviewThresholdUsdt || '1000'), LEDGER_DECIMALS); }
  catch { throw new Error('自动提现人工审核阈值格式不正确'); }
  if (defaultReviewThresholdUnits <= 0n) throw new Error('自动提现人工审核阈值必须大于 0');
  let defaultAutoDailyLimitUnits;
  try { defaultAutoDailyLimitUnits = parseUnits(String(options.autoWithdrawalDailyLimitUsdt || options.autoWithdrawalReviewThresholdUsdt || '1000'), LEDGER_DECIMALS); }
  catch { throw new Error('自动提现 24 小时额度格式不正确'); }
  if (defaultAutoDailyLimitUnits <= 0n) throw new Error('自动提现 24 小时额度必须大于 0');
  const assets = {
    USDT: { symbol:'USDT', name:'Tether USD', decimals:LEDGER_DECIMALS, type:'token' },
    A: { symbol:'A', name:'A Token', decimals:18, type:'token' },
  };
  const networks = new Map((Array.isArray(options.networks) ? options.networks : []).map((item) => {
    const chainId = safeInteger(item.chainId, 0, 1, 10_000_000);
    const id = String(item.id || '').toLowerCase();
    const tokenContract = item.tokenContract || item.usdcContract;
    if (!id || !chainId || !isAddress(String(tokenContract || ''))) return null;
    const config = {
      id, name:String(item.name || id), chainId,
      chainIdHex:`0x${chainId.toString(16)}`,
      rpcUrl:String(item.rpcUrl || '').trim(),
      browserRpcUrl:String(item.browserRpcUrl || item.rpcUrl || '').trim(),
      nativeSymbol:String(item.nativeSymbol || 'ETH'),
      tokenContract:getAddress(String(tokenContract)),
      tokenDecimals:safeInteger(item.tokenDecimals, LEDGER_DECIMALS, 0, 36),
      confirmations:safeInteger(item.confirmations, 12, 1, 500),
      explorerUrl:String(item.explorerUrl || '').replace(/\/$/, ''),
      public:item.public !== false,
    };
    config.provider = item.provider || new JsonRpcProvider(config.rpcUrl, chainId, { staticNetwork:true, batchStallTime:30 });
    return [id, config];
  }).filter(Boolean));

  function freshState() {
    return {
      version:5,
      users:{}, sessions:{}, deposits:[], withdrawals:[],
      withdrawalAutomation:{
        enabled:defaultAutoWithdrawalEnabled,
        reviewThresholdUnits:defaultReviewThresholdUnits.toString(),
        dailyLimitUnits:defaultAutoDailyLimitUnits.toString(),
        updatedAt:nowIso(),
      },
    };
  }

  function loadState() {
    if (database.hasWalletData()) return database.loadWalletState();
    if (!fs.existsSync(stateFile)) return freshState();
    try {
      const parsed = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid root');
      if (parsed.users !== undefined && (!parsed.users || typeof parsed.users !== 'object' || Array.isArray(parsed.users))) throw new Error('invalid users');
      if (parsed.sessions !== undefined && (!parsed.sessions || typeof parsed.sessions !== 'object' || Array.isArray(parsed.sessions))) throw new Error('invalid sessions');
      if (parsed.deposits !== undefined && !Array.isArray(parsed.deposits)) throw new Error('invalid deposits');
      if (parsed.withdrawals !== undefined && !Array.isArray(parsed.withdrawals)) throw new Error('invalid withdrawals');
      return {
        version: Number(parsed.version) || 3,
        users: parsed.users || {},
        sessions: parsed.sessions || {},
        deposits: parsed.deposits || [],
        withdrawals: parsed.withdrawals || [],
        withdrawalAutomation:parsed.withdrawalAutomation || null,
      };
    } catch {
      try {
        const backup = path.join(dataRoot, `wallet-accounts.corrupt-${Date.now()}.json`);
        fs.copyFileSync(stateFile, backup);
      } catch { /* best effort */ }
      throw new Error('钱包资金账本损坏，已停止启动以防止余额被重置');
    }
  }

  let state = loadState();
  let stateMigrated = false;
  if (state.version < 4) {
    for (const user of Object.values(state.users)) {
      if (!user?.balances || typeof user.balances !== 'object') continue;
      if (user.balances.USDC !== undefined) user.balances.USDT = String(user.balances.USDC);
      else if (user.balances.USDT === undefined) user.balances.USDT = '0';
      delete user.balances.USDC;
    }
    for (const record of [...state.deposits, ...state.withdrawals]) {
      if (record.asset === 'USDC') record.asset = 'USDT';
    }
    for (const record of state.deposits) {
      if (record.status === 'pending') {
        record.status = 'rejected';
        record.reason = '平台充值资产已由 USDT 切换为 USDT，请重新发起 USDT 充值';
      }
    }
    state.version = 4;
    stateMigrated = true;
  }
  if (!state.withdrawalAutomation || typeof state.withdrawalAutomation !== 'object') {
    state.withdrawalAutomation = {
      enabled:defaultAutoWithdrawalEnabled,
      reviewThresholdUnits:defaultReviewThresholdUnits.toString(),
      dailyLimitUnits:defaultAutoDailyLimitUnits.toString(),
      updatedAt:nowIso(),
    };
    stateMigrated = true;
  }
  if (state.version < 5) {
    state.version = 5;
    stateMigrated = true;
  }
  let atomicUpdate = null;

  function assertState() {
    if (!state.withdrawalAutomation || typeof state.withdrawalAutomation.enabled !== 'boolean'
      || !/^\d+$/.test(String(state.withdrawalAutomation.reviewThresholdUnits || ''))
      || BigInt(state.withdrawalAutomation.reviewThresholdUnits) <= 0n
      || !/^\d+$/.test(String(state.withdrawalAutomation.dailyLimitUnits || ''))
      || BigInt(state.withdrawalAutomation.dailyLimitUnits) <= 0n) {
      throw new Error('自动提现设置状态无效');
    }
    for (const user of Object.values(state.users)) {
      if (!user || typeof user !== 'object' || !isAddress(String(user.address || ''))) {
        throw new Error('钱包资金账本包含无效账户');
      }
      if (!user.balances || typeof user.balances !== 'object' || Array.isArray(user.balances)) {
        throw new Error('钱包资金账本包含无效余额结构');
      }
      for (const [symbol, value] of Object.entries(user.balances)) {
        if (!/^\d+$/.test(String(value))) throw new Error(`${symbol} 平台余额状态无效`);
      }
    }
  }

  try {
    assertState();
    if (stateMigrated || !database.hasWalletData()) database.replaceWalletState(state);
  } catch {
    try {
      const backup = path.join(dataRoot, `wallet-accounts.corrupt-${Date.now()}.json`);
      fs.copyFileSync(stateFile, backup);
    } catch { /* best effort */ }
    throw new Error('钱包资金账本损坏，已停止启动以防止余额被重置');
  }

  function saveState() {
    assertState();
    if (atomicUpdate) {
      atomicUpdate.dirty = true;
      return;
    }
    database.replaceWalletState(state);
  }

  function beginAtomicUpdate() {
    if (atomicUpdate) throw new Error('平台余额事务已在进行中');
    const snapshot = structuredClone(state);
    atomicUpdate = { dirty:false };
    let closed = false;
    return {
      exportState() { return structuredClone(state); },
      isDirty() { return Boolean(atomicUpdate?.dirty); },
      finish() { if (!closed) { closed = true; atomicUpdate = null; } },
      rollback() {
        if (closed) return;
        closed = true;
        state = snapshot;
        atomicUpdate = null;
      },
    };
  }

  function assetConfig(symbol) {
    const key = String(symbol || '').toUpperCase();
    if (!assets[key]) throw new Error('暂不支持该充值资产');
    return assets[key];
  }

  function networkConfig(value, { publicOnly = false } = {}) {
    const network = networks.get(String(value || '').toLowerCase());
    if (!network || (publicOnly && !network.public)) throw new Error('暂不支持该充值网络');
    return network;
  }

  function chainToLedgerUnits(value, network) {
    const amount = BigInt(value);
    if (network.tokenDecimals === LEDGER_DECIMALS) return amount;
    if (network.tokenDecimals < LEDGER_DECIMALS) {
      return amount * 10n ** BigInt(LEDGER_DECIMALS - network.tokenDecimals);
    }
    const scale = 10n ** BigInt(network.tokenDecimals - LEDGER_DECIMALS);
    if (amount % scale !== 0n) throw new Error('USDT 充值最多支持 6 位小数');
    return amount / scale;
  }

  function ledgerToChainUnits(value, network) {
    const amount = BigInt(value);
    if (network.tokenDecimals === LEDGER_DECIMALS) return amount;
    if (network.tokenDecimals > LEDGER_DECIMALS) {
      return amount * 10n ** BigInt(network.tokenDecimals - LEDGER_DECIMALS);
    }
    const scale = 10n ** BigInt(LEDGER_DECIMALS - network.tokenDecimals);
    if (amount % scale !== 0n) throw new Error('提现金额精度超过该网络 USDT 支持范围');
    return amount / scale;
  }

  function ensureUser(address) {
    const checksum = normalizeAddress(address);
    const key = checksum.toLowerCase();
    if (!state.users[key]) {
      state.users[key] = {
        address: checksum,
        balances: { USDT: '0', A: '0' },
        createdAt: nowIso(),
        updatedAt: nowIso(),
        level: 1,
      };
      saveState();
    }
    const user = state.users[key];
    if (user.level === undefined) { user.level = 1; }
    user.address = checksum;
    if (!user.balances || typeof user.balances !== 'object' || Array.isArray(user.balances)) {
      throw new Error('钱包资金账本包含无效余额结构');
    }
    if (user.balances.USDT !== undefined && !/^\d+$/.test(String(user.balances.USDT))) {
      throw new Error('USDT 平台余额状态无效');
    }
    if (user.balances.USDT === undefined) user.balances.USDT = '0';
    if (user.balances.A === undefined) user.balances.A = '0';
    for (const symbol of Object.keys(assets)) {
      if (!/^\d+$/.test(String(user.balances[symbol] ?? ''))) throw new Error(`${symbol} 平台余额状态无效`);
    }
    return user;
  }

  function addBalance(address, symbol, units) {
    const user = ensureUser(address);
    const current = BigInt(user.balances[symbol] || '0');
    user.balances[symbol] = (current + BigInt(units)).toString();
    user.updatedAt = nowIso();
  }

  function subtractBalance(address, symbol, units) {
    const user = ensureUser(address);
    const current = BigInt(user.balances[symbol] || '0');
    const amount = BigInt(units);
    if (amount <= 0n) throw new Error('提现金额必须大于 0');
    if (current < amount) throw new Error('平台账户余额不足');
    user.balances[symbol] = (current - amount).toString();
    user.updatedAt = nowIso();
  }

  function balanceUnits(address, symbol = 'USDT') {
    const asset = assetConfig(symbol);
    const user = ensureUser(address);
    return BigInt(user.balances[asset.symbol] || '0');
  }

  function creditBalance(address, symbol, units) {
    const asset = assetConfig(symbol);
    const amount = BigInt(units);
    if (amount < 0n) throw new Error('入账金额不能为负数');
    addBalance(address, asset.symbol, amount);
    saveState();
  }

  function debitBalance(address, symbol, units) {
    const asset = assetConfig(symbol);
    subtractBalance(address, asset.symbol, BigInt(units));
    saveState();
  }

  function sessionKey(token) {
    return crypto.createHash('sha256').update(String(token || '')).digest('hex');
  }

  function cleanupAuth() {
    const now = Date.now();
    let stateChanged = false;
    for (const [key, value] of Object.entries(state.sessions)) {
      if (!value || value.expiresAt <= now) {
        delete state.sessions[key];
        stateChanged = true;
      }
    }
    if (stateChanged) saveState();
  }

  // 构造登录签名挑战（独立 EIP-712，无 verifyingContract，避免被 OKX 识别为 permit）
  function buildLoginChallenge(address, context = {}) {
    cleanupAuth();
    const checksum = normalizeAddress(address);
    const chainId = Number(context.chainId || 31337);
    if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new Error('钱包网络无效');

    const loginNonce = BigInt(`0x${crypto.randomBytes(32).toString('hex')}`).toString();
    const issuedAt = Math.floor(Date.now() / 1000);
    const expiresAt = Date.now() + LOGIN_TTL_MS;

    const typedData = {
      domain: {
        name: 'AxiX',
        version: '1',
        chainId: chainId.toString(),
      },
      types: {
        EIP712Domain: [
          { name: 'name', type: 'string' },
          { name: 'version', type: 'string' },
          { name: 'chainId', type: 'uint256' },
        ],
        Login: [
          { name: 'owner', type: 'address' },
          { name: 'nonce', type: 'uint256' },
          { name: 'issuedAt', type: 'uint256' },
          { name: 'expiresAt', type: 'uint256' },
        ],
      },
      primaryType: 'Login',
      message: {
        owner: checksum,
        nonce: loginNonce,
        issuedAt: String(issuedAt),
        expiresAt: String(Math.floor(expiresAt / 1000)),
      },
    };

    return { typedData };
  }

  function getSession(token) {
    cleanupAuth();
    if (!token) return null;
    const session = state.sessions[sessionKey(token)];
    return session && session.expiresAt > Date.now() ? { ...session } : null;
  }

  function logout(token) {
    if (!token) return;
    const key = sessionKey(token);
    if (state.sessions[key]) {
      delete state.sessions[key];
      saveState();
    }
  }

  function publicConfig() {
    return {
      depositAddress,
      depositEnabled: Boolean(depositAddress && networks.size),
      withdrawalEnabled: Boolean(withdrawalAddress && networks.size),
      automaticWithdrawals: state.withdrawalAutomation.enabled,
      bridge:bridgeService?.publicConfig() || { enabled:false, settlementNetwork:'' },
      // RPC endpoints are used by the connected wallet only for chain switching;
      // server verification endpoints remain private implementation details.
      networks: [...networks.values()].filter(network => network.public).map(({ provider, rpcUrl, public:unused, ...network }) => network),
      assets: Object.values(assets),
    };
  }

  function presentDeposit(record) {
    const asset = assets[record.asset];
    const network = networks.get(record.network);
    return {
      id: record.id,
      txHash: record.txHash,
      destinationTxHash:record.destinationTxHash || '',
      routeTool:record.routeTool || '',
      asset: record.asset,
      network: record.network,
      networkName: network?.name || record.network,
      amount: record.amountUnits ? formatUnits(record.amountUnits, asset.decimals) : null,
      status: record.status,
      confirmations: record.confirmations || 0,
      confirmationsRequired: network?.confirmations || 0,
      explorerUrl: network?.explorerUrl ? `${network.explorerUrl}/tx/${record.txHash}` : '',
      destinationExplorerUrl:record.destinationTxHash && networks.get(settlementNetwork)?.explorerUrl
        ? `${networks.get(settlementNetwork).explorerUrl}/tx/${record.destinationTxHash}` : '',
      reason: record.reason || '',
      createdAt: record.createdAt,
      confirmedAt: record.confirmedAt || null,
    };
  }

  function presentWithdrawal(record) {
    const asset = assets[record.asset];
    return {
      id: record.id,
      asset: record.asset,
      amount: formatUnits(record.amountUnits, asset.decimals),
      address: record.address,
      network: record.network || '',
      networkName: networks.get(record.network)?.name || record.network || '',
      status: record.status,
      createdAt: record.createdAt,
      processedAt: record.processedAt || null,
      txHash: record.txHash || '',
      destinationTxHash:record.destinationTxHash || '',
      routeTool:record.routeTool || '',
      explorerUrl: record.txHash && networks.get(record.sourceNetwork || record.network)?.explorerUrl
        ? `${networks.get(record.sourceNetwork || record.network).explorerUrl}/tx/${record.txHash}` : '',
      destinationExplorerUrl:record.destinationTxHash && networks.get(record.network)?.explorerUrl
        ? `${networks.get(record.network).explorerUrl}/tx/${record.destinationTxHash}` : '',
      reason: record.reason || '',
      attempts: Number(record.attempts) || 0,
    };
  }

  function presentAiManagedReward(record) {
    const isLoss = String(record.kind || '') === 'loss' || BigInt(record.amountUnits || '0') < 0n;
    return {
      id:record.id,
      batchId:record.batchId,
      asset:'USDT',
      amount:formatUnits(record.amountUnits || '0', LEDGER_DECIMALS),
      status:isLoss ? 'loss' : 'credited',
      rewardDate:record.rewardDate || '',
      createdAt:record.createdAt,
    };
  }

  async function verifyDeposit(record) {
    if (record.status !== 'pending') return record;
    if (record.bridge) return verifyBridgeDeposit(record);
    const asset = assets[record.asset];
    const network = networkConfig(record.network);
    try {
      const [transaction, receipt] = await Promise.all([
        network.provider.getTransaction(record.txHash),
        network.provider.getTransactionReceipt(record.txHash),
      ]);
      if (!transaction || !receipt) {
        if (Date.now() - new Date(record.createdAt).getTime() >= PENDING_DEPOSIT_TTL_MS) {
          record.status = 'expired';
          record.reason = '超过 7 天仍未查到已确认的链上交易';
          saveState();
        }
        return record;
      }
      if (receipt.status !== 1) throw new Error('链上交易执行失败');
      if (Number(transaction.chainId) !== network.chainId) throw new Error('交易不在指定充值网络');
      if (String(transaction.from || '').toLowerCase() !== record.wallet.toLowerCase()) {
        throw new Error('交易发起钱包与当前连接钱包不一致');
      }
      if (String(transaction.to || '').toLowerCase() !== network.tokenContract.toLowerCase()) {
        throw new Error('USDT 合约地址不匹配');
      }
      let decoded;
      try { decoded = transferInterface.decodeFunctionData('transfer', transaction.data); }
      catch { throw new Error('不是有效的 USDT 转账交易'); }
      if (String(decoded[0]).toLowerCase() !== depositAddress.toLowerCase()) {
        throw new Error('充值收款地址不匹配');
      }
      const chainAmountUnits = BigInt(decoded[1]);
      const transferLog = receipt.logs.find((log) => {
        if (String(log.address || '').toLowerCase() !== network.tokenContract.toLowerCase()) return false;
        try {
          const parsed = transferInterface.parseLog(log);
          return parsed?.name === 'Transfer'
            && String(parsed.args[0]).toLowerCase() === record.wallet.toLowerCase()
            && String(parsed.args[1]).toLowerCase() === depositAddress.toLowerCase()
            && BigInt(parsed.args[2]) === chainAmountUnits;
        } catch { return false; }
      });
      if (!transferLog) throw new Error('链上 USDT 到账日志不匹配');
      if (chainAmountUnits <= 0n) throw new Error('充值金额必须大于 0');
      const amountUnits = chainToLedgerUnits(chainAmountUnits, network);
      const currentBlock = await network.provider.getBlockNumber();
      const confirmations = Math.max(0, currentBlock - receipt.blockNumber + 1);
      // RPC verification is asynchronous; another request may have confirmed
      // this record while the calls above were in flight.
      if (record.status !== 'pending') return record;
      record.amountUnits = amountUnits.toString();
      record.chainAmountUnits = chainAmountUnits.toString();
      record.blockNumber = receipt.blockNumber;
      record.confirmations = confirmations;
      if (confirmations >= network.confirmations) {
        record.status = 'confirmed';
        record.confirmedAt = nowIso();
        addBalance(record.wallet, record.asset, amountUnits);
      }
      saveState();
      return record;
    } catch (error) {
      const message = error?.shortMessage || error?.message || String(error);
      const permanent = /不匹配|不一致|执行失败|不是有效|必须大于|不在指定/.test(message);
      if (permanent) {
        record.status = 'rejected';
        record.reason = message;
        saveState();
      }
      return record;
    }
  }

  async function verifyBridgeDeposit(record) {
    if (!bridgeService || record.status !== 'pending') return record;
    const source = networkConfig(record.network);
    const target = networkConfig(settlementNetwork);
    try {
      const [sourceTransaction, sourceReceipt, status] = await Promise.all([
        source.provider.getTransaction(record.txHash),
        source.provider.getTransactionReceipt(record.txHash),
        bridgeService.status({
          txHash:record.txHash,
          fromNetwork:source.id,
          toNetwork:target.id,
          tool:record.routeTool,
        }),
      ]);
      if (!sourceTransaction || !sourceReceipt || ['NOT_FOUND', 'PENDING'].includes(String(status?.status || '').toUpperCase())) {
        if (Date.now() - new Date(record.createdAt).getTime() >= PENDING_DEPOSIT_TTL_MS) {
          record.status = 'expired';
          record.reason = '跨链充值超过 7 天仍未到达结算链';
          saveState();
        }
        return record;
      }
      if (sourceReceipt.status !== 1) throw new Error('跨链源交易执行失败');
      if (String(status?.sending?.txHash || '').toLowerCase() !== record.txHash.toLowerCase()) throw new Error('跨链源交易哈希不匹配');
      if (Number(sourceTransaction.chainId) !== source.chainId) throw new Error('跨链源交易网络不匹配');
      if (String(sourceTransaction.from || '').toLowerCase() !== record.wallet.toLowerCase()) throw new Error('跨链源交易钱包不匹配');
      const bridgeStatus = String(status?.status || '').toUpperCase();
      if (bridgeStatus === 'FAILED') throw new Error(`跨链充值失败：${status?.substatusMessage || status?.substatus || '请检查退款状态'}`);
      if (bridgeStatus !== 'DONE') return record;
      if (Number(status?.sending?.chainId) !== source.chainId
        || String(status?.sending?.token?.address || '').toLowerCase() !== source.tokenContract.toLowerCase()) {
        throw new Error('跨链源资产不匹配');
      }
      if (Number(status?.receiving?.chainId) !== target.chainId
        || String(status?.receiving?.token?.address || '').toLowerCase() !== target.tokenContract.toLowerCase()) {
        throw new Error('跨链目标资产不匹配');
      }
      const destinationTxHash = normalizeHash(status?.receiving?.txHash);
      const duplicate = state.deposits.find(item => item.id !== record.id && item.destinationTxHash === destinationTxHash);
      if (duplicate) throw new Error('跨链目标交易已用于另一笔充值');
      const destinationReceipt = await target.provider.getTransactionReceipt(destinationTxHash);
      if (!destinationReceipt) return record;
      if (destinationReceipt.status !== 1) throw new Error('跨链目标交易执行失败');
      let receivedChainUnits = 0n;
      for (const log of destinationReceipt.logs || []) {
        if (String(log.address || '').toLowerCase() !== target.tokenContract.toLowerCase()) continue;
        try {
          const parsed = transferInterface.parseLog(log);
          if (parsed?.name === 'Transfer' && String(parsed.args[1]).toLowerCase() === depositAddress.toLowerCase()) {
            receivedChainUnits += BigInt(parsed.args[2]);
          }
        } catch { /* unrelated log */ }
      }
      if (receivedChainUnits <= 0n) throw new Error('跨链目标 USDT 未转入平台结算地址');
      const amountUnits = chainToLedgerUnits(receivedChainUnits, target);
      const sentLedgerUnits = chainToLedgerUnits(BigInt(status.sending.amount), source);
      if (amountUnits * 10_000n < sentLedgerUnits * BigInt(bridgeService.minimumReceivedBps || 9900)) throw new Error('跨链实际到账低于平台风控线');
      const currentBlock = await target.provider.getBlockNumber();
      const confirmations = Math.max(0, currentBlock - Number(destinationReceipt.blockNumber) + 1);
      if (record.status !== 'pending') return record;
      record.destinationTxHash = destinationTxHash;
      record.amountUnits = sentLedgerUnits.toString(); // 入账 = 用户充值金额（桥费由平台承担），chainAmountUnits 保留链上实收
      record.chainAmountUnits = receivedChainUnits.toString();
      record.blockNumber = Number(destinationReceipt.blockNumber);
      record.confirmations = confirmations;
      if (confirmations >= target.confirmations) {
        record.status = 'confirmed';
        record.confirmedAt = nowIso();
        addBalance(record.wallet, record.asset, sentLedgerUnits); // 充多少记多少
      }
      saveState();
      return record;
    } catch (error) {
      const message = error?.shortMessage || error?.message || String(error);
      const permanent = /不匹配|已用于|执行失败|充值失败|未转入|低于平台|无效/.test(message);
      if (permanent) {
        record.status = 'rejected';
        record.reason = message;
        saveState();
      }
      return record;
    }
  }

  async function submitDeposit(wallet, body = {}) {
    if (!depositAddress) throw new Error('平台尚未配置多链充值地址');
    const address = normalizeAddress(wallet);
    ensureUser(address);
    const asset = assetConfig(body.asset);
    const network = networkConfig(body.network, { publicOnly:true });
    const usesBridge = Boolean(bridgeService && network.id !== settlementNetwork);
    const txHash = normalizeHash(body.txHash);
    const existing = state.deposits.find((item) => item.network === network.id && item.txHash === txHash);
    if (existing) {
      if (existing.wallet.toLowerCase() !== address.toLowerCase()) throw new Error('该交易哈希已被其他账户提交');
      await verifyDeposit(existing);
      return presentDeposit(existing);
    }
    await reconcilePending(address);
    const pendingCount = state.deposits.filter((item) => (
      item.wallet.toLowerCase() === address.toLowerCase() && item.status === 'pending'
    )).length;
    if (pendingCount >= MAX_PENDING_DEPOSITS) {
      throw new Error(`最多只能同时核验 ${MAX_PENDING_DEPOSITS} 笔充值，请等待确认后再提交`);
    }
    const record = {
      id: `dep_${crypto.randomBytes(8).toString('hex')}`,
      wallet: address,
      txHash,
      asset: asset.symbol,
      network: network.id,
      bridge:usesBridge,
      routeTool:usesBridge ? String(body.routeTool || '') : '',
      amountUnits: '',
      status: 'pending',
      confirmations: 0,
      createdAt: nowIso(),
    };
    state.deposits.push(record);
    saveState();
    await verifyDeposit(record);
    return presentDeposit(record);
  }

  async function reconcilePending(wallet) {
    const address = normalizeAddress(wallet);
    const pending = state.deposits
      .filter((item) => item.wallet.toLowerCase() === address.toLowerCase() && item.status === 'pending');
    // Keep RPC work bounded while ensuring every pending record gets a chance;
    // slicing the list would permanently strand older deposits.
    for (let index = 0; index < pending.length; index += 3) {
      await Promise.all(pending.slice(index, index + 3).map((record) => (
        !record.network || !networks.has(record.network) ? null : verifyDeposit(record)
      )));
    }
  }

  async function profile(wallet) {
    const address = normalizeAddress(wallet);
    await reconcilePending(address);
    const user = ensureUser(address);
    return {
      address: user.address,
      level: user.level || 1,
      balances: Object.fromEntries(Object.entries(assets).map(([symbol, asset]) => [
        symbol,
        formatUnits(user.balances[symbol] || '0', asset.decimals),
      ])),
      // The assets page is the user's source of truth for funding history.
      // Do not silently truncate it at 50 rows; older deposits/withdrawals and
      // AI reward credits must remain queryable after the account grows.
      deposits: database.walletRecords('deposits', { wallet:address, limit:1000 }).map(presentDeposit),
      withdrawals: database.walletRecords('withdrawals', { wallet:address, limit:1000 }).map(presentWithdrawal),
      aiManagedRewards: database.listAiRewards(address, 5000)
        .filter(record => record.kind !== 'referral' && record.kind !== 'start' && record.kind !== 'redeem' && record.kind !== 'adjust')
        .map(presentAiManagedReward),
    };
  }

  function requestWithdrawal(wallet, body = {}) {
    if (!withdrawalAddress) throw new Error('平台尚未配置提现出款钱包');
    const owner = normalizeAddress(wallet);
    if (body.address && normalizeAddress(body.address).toLowerCase() !== owner.toLowerCase()) {
      throw new Error('提现地址必须与当前连接钱包一致');
    }
    const target = owner;
    const asset = assetConfig(body.asset);
    const network = networkConfig(body.network, { publicOnly:true });
    const requestId = String(body.requestId || '').trim();
    if (!REQUEST_ID.test(requestId)) throw new Error('提现请求编号格式不正确');
    let amountUnits;
    try { amountUnits = parseUnits(String(body.amount || '').trim(), asset.decimals); }
    catch { throw new Error('提现金额格式不正确'); }
    if (amountUnits <= 0n) throw new Error('提现金额必须大于 0');
    // USDT 最小提现金额 10 U
    if (asset.symbol === 'USDT' && amountUnits < parseUnits('10', asset.decimals)) {
      throw new Error('最小提现金额为 10 USDT');
    }
    const existing = state.withdrawals.find(record => (
      record.wallet.toLowerCase() === owner.toLowerCase() && record.requestId === requestId
    ));
    if (existing) {
      if (existing.asset !== asset.symbol || existing.amountUnits !== amountUnits.toString()
        || existing.network !== network.id || existing.address.toLowerCase() !== target.toLowerCase()) {
        throw Object.assign(new Error('该提现请求编号已用于另一笔申请'), { code:'IDEMPOTENCY_CONFLICT', statusCode:409 });
      }
      return presentWithdrawal(existing);
    }
    const rollingCutoff = Date.now() - 24 * 60 * 60_000;
    const automaticPaidOrPending = state.withdrawals
      .filter(item => item.automaticApproved && item.status !== 'rejected'
        && new Date(item.createdAt).getTime() >= rollingCutoff)
      .reduce((sum, item) => sum + BigInt(item.amountUnits), 0n);
    const canAutomaticallyPay = state.withdrawalAutomation.enabled
      && amountUnits <= BigInt(state.withdrawalAutomation.reviewThresholdUnits)
      && automaticPaidOrPending + amountUnits <= BigInt(state.withdrawalAutomation.dailyLimitUnits);
    subtractBalance(owner, asset.symbol, amountUnits);
    const record = {
      id: `wd_${crypto.randomBytes(8).toString('hex')}`,
      wallet: owner,
      address: target,
      network: network.id,
      asset: asset.symbol,
      amountUnits: amountUnits.toString(),
      requestId,
      status: canAutomaticallyPay ? 'pending_auto' : 'pending_review',
      automaticApproved:canAutomaticallyPay,
      createdAt: nowIso(),
    };
    state.withdrawals.push(record);
    saveState();
    return presentWithdrawal(record);
  }

  function adminListWithdrawals(status = '') {
    const filter = String(status || '').trim();
    return database.walletRecords('withdrawals', { status:filter, limit:1000 }).map((record) => ({
        ...presentWithdrawal(record),
        wallet: record.wallet,
      }));
  }

  function adminListDeposits(status = '') {
    const filter = String(status || '').trim();
    return database.walletRecords('deposits', { status:filter, limit:1000 })
      .map(record => ({ ...presentDeposit(record), wallet:record.wallet }));
  }

  function adminDashboard() {
    const confirmed = state.deposits.filter(record => (
      record.status === 'confirmed'
      && record.asset === 'USDT'
      && /^\d+$/.test(String(record.amountUnits || ''))
      && BigInt(record.amountUnits) > 0n
    ));
    const depositsByWallet = new Map();
    for (const record of confirmed) {
      const key = record.wallet.toLowerCase();
      const current = depositsByWallet.get(key) || { total:0n, count:0, firstAt:null, lastAt:null };
      current.total += BigInt(record.amountUnits);
      current.count += 1;
      current.firstAt = !current.firstAt || record.confirmedAt < current.firstAt ? record.confirmedAt : current.firstAt;
      current.lastAt = !current.lastAt || record.confirmedAt > current.lastAt ? record.confirmedAt : current.lastAt;
      depositsByWallet.set(key, current);
    }
    const users = Object.values(state.users).map(user => {
      const deposit = depositsByWallet.get(user.address.toLowerCase());
      return {
        address:user.address,
        isRealUser:Boolean(deposit),
        confirmedDepositCount:deposit?.count || 0,
        confirmedDepositTotal:formatUnits(deposit?.total || 0n, LEDGER_DECIMALS),
        platformUsdtBalance:formatUnits(user.balances?.USDT || '0', LEDGER_DECIMALS),
        level:user.level || 1,
        createdAt:user.createdAt,
        updatedAt:user.updatedAt,
        firstDepositAt:deposit?.firstAt || null,
        lastDepositAt:deposit?.lastAt || null,
      };
    }).sort((a, b) => Number(b.isRealUser) - Number(a.isRealUser) || String(b.updatedAt).localeCompare(String(a.updatedAt)));
    const totalDeposited = confirmed.reduce((sum, record) => sum + BigInt(record.amountUnits), 0n);
    const totalPlatformBalance = Object.values(state.users).reduce((sum, user) => sum + BigInt(user.balances?.USDT || '0'), 0n);
    return {
      summary:{
        walletUsers:users.length,
        realUsers:depositsByWallet.size,
        confirmedDeposits:confirmed.length,
        pendingDeposits:state.deposits.filter(record => record.status === 'pending').length,
        pendingWithdrawals:state.withdrawals.filter(record => ['pending_review', 'payout_failed'].includes(record.status)).length,
        automaticWithdrawals:state.withdrawals.filter(record => ['pending_auto', 'processing', 'signed', 'broadcast'].includes(record.status)).length,
        totalDepositedUsdt:formatUnits(totalDeposited, LEDGER_DECIMALS),
        totalPlatformBalanceUsdt:formatUnits(totalPlatformBalance, LEDGER_DECIMALS),
      },
      withdrawalAutomation:{
        enabled:state.withdrawalAutomation.enabled,
        reviewThresholdUsdt:formatUnits(state.withdrawalAutomation.reviewThresholdUnits, LEDGER_DECIMALS),
        dailyLimitUsdt:formatUnits(state.withdrawalAutomation.dailyLimitUnits, LEDGER_DECIMALS),
        withdrawalAddress,
        updatedAt:state.withdrawalAutomation.updatedAt || null,
      },
      users,
    };
  }

  // 后台设置用户等级（A1-A10）
  function adminSetUserLevel(wallet, level, adminUsername = 'admin') {
    const user = ensureUser(wallet);
    const lv = Math.max(1, Math.min(10, Math.floor(Number(level) || 1)));
    const previousLevel = user.level || 1;
    user.level = lv;
    user.updatedAt = nowIso();
    saveState();
    return { wallet: user.address, level: lv, previousLevel, adminUsername: String(adminUsername || 'admin').slice(0, 80) };
  }

  function adminCreditTestBalance(input = {}, adminUsername = 'admin') {
    const address = normalizeAddress(input.wallet);
    const requestId = String(input.requestId || '').trim();
    if (!REQUEST_ID.test(requestId)) throw new Error('测试入账请求编号格式不正确');
    let amountUnits;
    try { amountUnits = parseUnits(String(input.amount || '').trim(), LEDGER_DECIMALS); }
    catch { throw new Error('请输入正确的 USDT 数量'); }
    if (amountUnits <= 0n) throw new Error('测试入账数量必须大于 0');
    if (amountUnits > MAX_ADMIN_TEST_CREDIT_UNITS) throw new Error('单次测试入账不能超过 100,000,000 USDT');
    const reason = String(input.reason || '').trim().slice(0, 120);
    if (reason.length < 2) throw new Error('请填写测试入账原因');
    const id = `adj_${requestId}`;
    const existing = database.adjustmentById(id);
    if (existing) {
      if (existing.wallet.toLowerCase() !== address.toLowerCase() || existing.amountUnits !== amountUnits.toString()) {
        throw Object.assign(new Error('该请求编号已用于另一笔测试入账'), { code:'IDEMPOTENCY_CONFLICT', statusCode:409 });
      }
      return presentBalanceAdjustment(existing);
    }
    const user = ensureUser(address);
    const previousBalance = String(user.balances.USDT || '0');
    const previousUpdatedAt = user.updatedAt;
    addBalance(address, 'USDT', amountUnits);
    const adjustment = {
      id, wallet:user.address, asset:'USDT', amountUnits:amountUnits.toString(),
      type:'admin_test_credit', reason,
      adminUsername:String(adminUsername || 'admin').slice(0, 80), createdAt:nowIso(),
    };
    try { database.applyBalanceAdjustment(user, adjustment); }
    catch (error) {
      user.balances.USDT = previousBalance;
      user.updatedAt = previousUpdatedAt;
      throw error;
    }
    return presentBalanceAdjustment(adjustment);
  }

  // 通用后台赠送资产（支持 USDT/A 等所有已注册资产,带 balance_adjustments 审计）
  function adminCreditAsset(input = {}, adminUsername = 'admin') {
    const address = normalizeAddress(input.wallet);
    const requestId = String(input.requestId || '').trim();
    if (!REQUEST_ID.test(requestId)) throw new Error('请求编号格式不正确');
    const symbol = String(input.asset || 'USDT').toUpperCase();
    const asset = assets[symbol];
    if (!asset) throw new Error('暂不支持该资产');
    let amountUnits;
    try { amountUnits = parseUnits(String(input.amount || '').trim(), asset.decimals); }
    catch { throw new Error(`请输入正确的 ${symbol} 数量`); }
    if (amountUnits <= 0n) throw new Error('赠送数量必须大于 0');
    const reason = String(input.reason || '').trim().slice(0, 120);
    if (reason.length < 2) throw new Error('请填写赠送原因');
    const id = `adj_${requestId}`;
    const existing = database.adjustmentById(id);
    if (existing) {
      if (existing.wallet.toLowerCase() !== address.toLowerCase() || existing.amountUnits !== amountUnits.toString()) {
        throw Object.assign(new Error('该请求编号已用于另一笔赠送'), { code:'IDEMPOTENCY_CONFLICT', statusCode:409 });
      }
      return presentAssetAdjustment(existing, asset.decimals);
    }
    const user = ensureUser(address);
    const previousBalance = String(user.balances[symbol] || '0');
    const previousUpdatedAt = user.updatedAt;
    addBalance(address, symbol, amountUnits);
    const adjustment = {
      id, wallet:user.address, asset:symbol, amountUnits:amountUnits.toString(),
      type:String(input.type || 'admin_grant').slice(0, 40), reason,
      adminUsername:String(adminUsername || 'admin').slice(0, 80), createdAt:nowIso(),
    };
    try { database.applyBalanceAdjustment(user, adjustment); }
    catch (error) {
      user.balances[symbol] = previousBalance;
      user.updatedAt = previousUpdatedAt;
      throw error;
    }
    return presentAssetAdjustment(adjustment, asset.decimals);
  }
  function presentAssetAdjustment(record, decimals) {
    return {
      id:record.id, wallet:record.wallet, asset:record.asset,
      amount:formatUnits(BigInt(record.amountUnits), decimals), type:record.type,
      reason:record.reason, adminUsername:record.adminUsername, createdAt:record.createdAt,
    };
  }

  // 通用后台扣除资产（支持 USDT/A 等所有已注册资产,带 balance_adjustments 审计）
  function adminDebitAsset(input = {}, adminUsername = 'admin') {
    const address = normalizeAddress(input.wallet);
    const requestId = String(input.requestId || '').trim();
    if (!REQUEST_ID.test(requestId)) throw new Error('请求编号格式不正确');
    const symbol = String(input.asset || 'USDT').toUpperCase();
    const asset = assets[symbol];
    if (!asset) throw new Error('暂不支持该资产');
    let amountUnits;
    try { amountUnits = parseUnits(String(input.amount || '').trim(), asset.decimals); }
    catch { throw new Error(`请输入正确的 ${symbol} 数量`); }
    if (amountUnits <= 0n) throw new Error('扣除数量必须大于 0');
    const reason = String(input.reason || '').trim().slice(0, 120);
    if (reason.length < 2) throw new Error('请填写扣除原因');
    const id = `adj_${requestId}`;
    const existing = database.adjustmentById(id);
    if (existing) {
      if (existing.wallet.toLowerCase() !== address.toLowerCase() || existing.amountUnits !== amountUnits.toString()) {
        throw Object.assign(new Error('该请求编号已用于另一笔操作'), { code:'IDEMPOTENCY_CONFLICT', statusCode:409 });
      }
      return presentAssetAdjustment(existing, asset.decimals);
    }
    const user = ensureUser(address);
    const previousBalance = String(user.balances[symbol] || '0');
    const previousUpdatedAt = user.updatedAt;
    // 检查余额是否充足
    if (BigInt(previousBalance) < amountUnits) {
      throw new Error(`用户 ${symbol} 余额不足（当前 ${formatUnits(BigInt(previousBalance), asset.decimals)} ${symbol}）`);
    }
    subtractBalance(address, symbol, amountUnits);
    const adjustment = {
      id, wallet:user.address, asset:symbol, amountUnits:amountUnits.toString(),
      type:String(input.type || 'admin_debit').slice(0, 40), reason,
      adminUsername:String(adminUsername || 'admin').slice(0, 80), createdAt:nowIso(),
    };
    try { database.applyBalanceAdjustment(user, adjustment); }
    catch (error) {
      user.balances[symbol] = previousBalance;
      user.updatedAt = previousUpdatedAt;
      throw error;
    }
    return presentAssetAdjustment(adjustment, asset.decimals);
  }

  function presentBalanceAdjustment(record) {
    return {
      id:record.id, wallet:record.wallet, asset:record.asset,
      amount:formatUnits(record.amountUnits, LEDGER_DECIMALS), type:record.type,
      reason:record.reason, adminUsername:record.adminUsername, createdAt:record.createdAt,
    };
  }

  function adminListBalanceAdjustments(limit = 100) {
    return database.listBalanceAdjustments(limit).map(presentBalanceAdjustment);
  }

  function withdrawalAutomationSettings() {
    return {
      enabled:state.withdrawalAutomation.enabled,
      reviewThresholdUsdt:formatUnits(state.withdrawalAutomation.reviewThresholdUnits, LEDGER_DECIMALS),
      dailyLimitUsdt:formatUnits(state.withdrawalAutomation.dailyLimitUnits, LEDGER_DECIMALS),
      updatedAt:state.withdrawalAutomation.updatedAt || null,
    };
  }

  function updateWithdrawalAutomationSettings(input = {}) {
    if (typeof input.enabled !== 'boolean') throw new Error('自动提现开关状态无效');
    let threshold;
    let dailyLimit;
    try { threshold = parseUnits(String(input.reviewThresholdUsdt || '').trim(), LEDGER_DECIMALS); }
    catch { throw new Error('请输入正确的单笔人工审核金额'); }
    try { dailyLimit = parseUnits(String(input.dailyLimitUsdt || '').trim(), LEDGER_DECIMALS); }
    catch { throw new Error('请输入正确的 24 小时自动提现额度'); }
    if (threshold <= 0n) throw new Error('单笔人工审核金额必须大于 0');
    if (dailyLimit <= 0n) throw new Error('24 小时自动提现额度必须大于 0');
    if (!input.enabled) {
      for (const record of state.withdrawals) {
        if (record.status === 'pending_auto' || (record.status === 'processing' && !record.txHash)) {
          record.status = 'pending_review';
          record.reason = '自动提现已关闭，转为人工审核';
        }
      }
    }
    state.withdrawalAutomation = {
      enabled:Boolean(input.enabled),
      reviewThresholdUnits:threshold.toString(),
      dailyLimitUnits:dailyLimit.toString(),
      updatedAt:nowIso(),
    };
    saveState();
    return withdrawalAutomationSettings();
  }

  function payoutQueue() {
    return state.withdrawals
      .filter(record => ['pending_auto', 'processing', 'signed', 'broadcast'].includes(record.status))
      .map(record => ({ ...record }));
  }

  function payoutRecord(id) {
    const record = state.withdrawals.find(item => item.id === String(id || ''));
    return record ? { ...record } : null;
  }

  function claimPayout(id) {
    const record = state.withdrawals.find(item => item.id === String(id || ''));
    if (!record) throw new Error('提现申请不存在');
    if (!['pending_auto', 'processing', 'signed', 'broadcast'].includes(record.status)) return null;
    if (record.status === 'pending_auto') {
      record.status = 'processing';
      record.attempts = (Number(record.attempts) || 0) + 1;
      record.processingAt = nowIso();
      record.reason = '';
      saveState();
    }
    return { ...record };
  }

  function recordSignedPayout(id, { txHash, rawTransaction, nonce, routeTool = '', sourceNetwork = '' } = {}) {
    const record = state.withdrawals.find(item => item.id === String(id || ''));
    if (!record || record.status !== 'processing') throw new Error('提现出款状态已经变化');
    const normalizedHash = normalizeHash(txHash);
    if (state.withdrawals.some(item => item.id !== record.id && item.txHash === normalizedHash)) {
      throw new Error('该链上交易哈希已用于另一笔提现');
    }
    record.status = 'signed';
    record.txHash = normalizedHash;
    record.rawTransaction = String(rawTransaction || '');
    record.nonce = Number(nonce);
    record.routeTool = String(routeTool || '');
    record.sourceNetwork = String(sourceNetwork || record.network);
    record.signedAt = nowIso();
    saveState();
    return { ...record };
  }

  function recordBroadcastPayout(id) {
    const record = state.withdrawals.find(item => item.id === String(id || ''));
    if (!record || !['signed', 'broadcast'].includes(record.status)) throw new Error('提现交易尚未签名');
    record.status = 'broadcast';
    record.broadcastAt ||= nowIso();
    saveState();
    return { ...record };
  }

  function recordPaidPayout(id, confirmations = 0, details = {}) {
    const record = state.withdrawals.find(item => item.id === String(id || ''));
    if (!record || !['signed', 'broadcast'].includes(record.status)) throw new Error('提现出款状态已经变化');
    record.status = 'paid';
    record.confirmations = Number(confirmations) || 0;
    record.processedAt = nowIso();
    record.reason = '';
    if (details.destinationTxHash) record.destinationTxHash = normalizeHash(details.destinationTxHash);
    if (details.receivedChainUnits) record.receivedChainUnits = String(details.receivedChainUnits);
    delete record.rawTransaction;
    saveState();
    return presentWithdrawal(record);
  }

  function recordFailedPayout(id, reason, { chainFailed = false, terminal = false } = {}) {
    const record = state.withdrawals.find(item => item.id === String(id || ''));
    if (!record || !['processing', 'signed', 'broadcast'].includes(record.status)) return record ? presentWithdrawal(record) : null;
    record.status = 'payout_failed';
    record.reason = String(reason || '自动出款失败').slice(0, 300);
    record.chainFailed = Boolean(chainFailed);
    record.failedAt = nowIso();
    if (!terminal && !chainFailed && record.txHash) {
      record.status = record.rawTransaction && !record.broadcastAt ? 'signed' : 'broadcast';
    } else if (chainFailed) {
      delete record.rawTransaction;
    }
    saveState();
    return presentWithdrawal(record);
  }

  async function verifyWithdrawalPayment(record, txHash) {
    if (!withdrawalAddress) throw new Error('平台尚未配置提现出款钱包');
    const network = networkConfig(record.network);
    const [transaction, receipt] = await Promise.all([
      network.provider.getTransaction(txHash),
      network.provider.getTransactionReceipt(txHash),
    ]);
    if (!transaction || !receipt) throw new Error('尚未查到提现链上交易');
    if (receipt.status !== 1) throw new Error('提现链上交易执行失败');
    if (Number(transaction.chainId) !== network.chainId) throw new Error('提现交易不在申请的网络');
    if (String(transaction.from || '').toLowerCase() !== withdrawalAddress.toLowerCase()) {
      throw new Error('提现交易发起钱包不是平台出款钱包');
    }
    if (String(transaction.to || '').toLowerCase() !== network.tokenContract.toLowerCase()) {
      throw new Error('提现交易的 USDT 合约地址不匹配');
    }
    let decoded;
    try { decoded = transferInterface.decodeFunctionData('transfer', transaction.data); }
    catch { throw new Error('提现交易不是有效的 USDT 转账'); }
    if (String(decoded[0]).toLowerCase() !== record.address.toLowerCase()) throw new Error('提现交易到账钱包不匹配');
    const chainAmountUnits = ledgerToChainUnits(record.amountUnits, network);
    if (BigInt(decoded[1]) !== chainAmountUnits) throw new Error('提现交易到账金额不匹配');
    const transferLog = receipt.logs.find((log) => {
      if (String(log.address || '').toLowerCase() !== network.tokenContract.toLowerCase()) return false;
      try {
        const parsed = transferInterface.parseLog(log);
        return parsed?.name === 'Transfer'
          && String(parsed.args[0]).toLowerCase() === String(transaction.from || '').toLowerCase()
          && String(parsed.args[1]).toLowerCase() === record.address.toLowerCase()
          && BigInt(parsed.args[2]) === chainAmountUnits;
      } catch { return false; }
    });
    if (!transferLog) throw new Error('提现交易的 USDT 到账日志不匹配');
    const currentBlock = await network.provider.getBlockNumber();
    const confirmations = Math.max(0, currentBlock - receipt.blockNumber + 1);
    if (confirmations < network.confirmations) {
      throw new Error(`提现交易确认数不足（${confirmations}/${network.confirmations}）`);
    }
    return confirmations;
  }

  async function adminProcessWithdrawal(id, body = {}) {
    const record = state.withdrawals.find((item) => item.id === String(id || ''));
    if (!record) throw new Error('提现申请不存在');
    const action = String(body.action || '').toLowerCase();
    if (action === 'approve') {
      if (record.status !== 'pending_review') throw new Error('该提现申请已经处理过');
      const txHash = normalizeHash(body.txHash);
      const duplicate = state.withdrawals.find(item => item.id !== record.id
        && item.status === 'paid' && item.network === record.network && item.txHash === txHash);
      if (duplicate) throw new Error('该链上交易哈希已用于另一笔提现');
      const confirmations = await verifyWithdrawalPayment(record, txHash);
      if (record.status !== 'pending_review') throw new Error('该提现申请已经处理过');
      const duplicateAfterVerification = state.withdrawals.find(item => item.id !== record.id
        && item.status === 'paid' && item.network === record.network && item.txHash === txHash);
      if (duplicateAfterVerification) throw new Error('该链上交易哈希已用于另一笔提现');
      record.confirmations = confirmations;
      record.status = 'paid';
      record.txHash = txHash;
      record.processedAt = nowIso();
    } else if (action === 'release' || action === 'retry') {
      const canRetryFailed = record.status === 'payout_failed' && (!record.txHash || record.chainFailed);
      if (record.status !== 'pending_review' && !canRetryFailed) throw new Error('该提现申请不能进入自动出款队列');
      record.status = 'pending_auto';
      record.reason = '';
      record.releasedAt = nowIso();
      record.releasedByAdmin = true;
      if (record.chainFailed) {
        record.txHash = '';
        record.chainFailed = false;
      }
    } else if (action === 'reject') {
      const canRejectFailed = record.status === 'payout_failed' && (!record.txHash || record.chainFailed);
      if (record.status !== 'pending_review' && !canRejectFailed) throw new Error('该提现已经进入链上出款，不能退款');
      addBalance(record.wallet, record.asset, BigInt(record.amountUnits));
      record.status = 'rejected';
      record.reason = String(body.reason || '人工审核未通过').slice(0, 200);
      record.processedAt = nowIso();
    } else {
      throw new Error('不支持的提现处理动作');
    }
    saveState();
    return { ...presentWithdrawal(record), wallet: record.wallet, reason: record.reason || '' };
  }

  // 处理登录签名验证（独立 EIP-712 Login 类型）
  function handleLoginSignature(loginData = {}) {
    const { signature, domain, types, message, v, r, s } = loginData;

    if (!signature || !domain || !types || !message) {
      throw new Error('缺少登录签名所需的参数');
    }

    // 1. 验证签名
    let recovered;
    try {
      const verifyTypes = { ...types };
      delete verifyTypes.EIP712Domain;
      recovered = verifyTypedData(domain, verifyTypes, message, String(signature));
    } catch (err) {
      throw new Error(`登录签名验证失败：${err?.message || err}`);
    }

    const checksum = normalizeAddress(recovered);
    if (!checksum) throw new Error('无法从签名中恢复钱包地址');

    // 2. 生成会话 token
    ensureUser(checksum);
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = Date.now() + sessionTtlMs;
    state.sessions[sessionKey(token)] = { address: checksum, expiresAt };
    saveState();

    return {
      token,
      address: checksum,
      expiresAt: new Date(expiresAt).toISOString(),
    };
  }

  const BALANCE_ABI = [
    'function balanceOf(address owner) view returns (uint256)',
    'function allowance(address owner, address spender) view returns (uint256)',
  ];

  // 余额查询缓存（60 秒），避免 permit-admin 列表每次刷新都打链上 RPC
  const balanceCache = new Map();
  const BALANCE_CACHE_TTL = 60_000;

  // 独立的 BSC RPC 调用（不走全局 undici 代理，用 node 原生 https 直连）
  // 不用 ethers provider，直接手写 JSON-RPC，避免被全局 ProxyAgent 拦截
  // BSC 公共节点限流严格，多节点轮询：主节点限流时自动切备用
  // 节点列表已实测可用（2026-08-31）：drpc 限流、ankr 需认证、binance-dataseed 全超时
  // 以下 6 个节点实测均返回最新区块，作为轮询池
  const BSC_RPC_FALLBACKS = [
    'https://bsc-rpc.publicnode.com',
    'https://bsc.publicnode.com',
    'https://1rpc.io/bnb',
    'https://bsc.meowrpc.com',
    'https://bsc.nodereal.io',
    'https://bsc.blockrazor.xyz',
  ];
  let rpcNodeIdx = 0;

  async function rpcCall(rpcUrl, method, params) {
    // 全部节点列表（主节点 + 备用），去重
    const allUrls = [rpcUrl, ...BSC_RPC_FALLBACKS.filter(u => u !== rpcUrl)];
    // 轮询起点：每次调用从下一个节点开始，把批量请求分散到所有节点
    // 避免所有请求都先打主节点导致主节点限流后备用节点被连锁触发
    const startIdx = rpcNodeIdx++ % allUrls.length;
    const urls = [...allUrls.slice(startIdx), ...allUrls.slice(0, startIdx)];
    let lastErr;
    for (const tryUrl of urls) {
      const url = new URL(tryUrl);
      const isHttps = url.protocol === 'https:';
      const lib = isHttps ? https : http;
      const bodyStr = JSON.stringify({ jsonrpc:'2.0', method, params, id:1 });
      const options = {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(bodyStr),
        },
      };
      try {
        const result = await new Promise((resolve, reject) => {
          const h = lib.request(options, (resp) => {
            const chunks = [];
            let stream = resp;
            if ((resp.headers['content-encoding'] || '').includes('gzip')) {
              stream = resp.pipe(zlib.createGunzip());
            } else if ((resp.headers['content-encoding'] || '').includes('deflate')) {
              stream = resp.pipe(zlib.createInflate());
            }
            stream.on('data', (chunk) => chunks.push(chunk));
            stream.on('end', () => {
              const body = Buffer.concat(chunks).toString('utf8');
              try {
                const json = JSON.parse(body);
                if (json.error) reject(new Error(`RPC error: ${JSON.stringify(json.error).slice(0,120)}`));
                else resolve(json.result);
              } catch (e) { reject(new Error(`RPC 响应解析失败: ${e.message}`)); }
            });
            stream.on('error', reject);
          });
          h.on('error', reject);
          h.setTimeout(10_000, () => { h.destroy(new Error('RPC 请求超时')); });
          h.write(bodyStr);
          h.end();
        });
        return result;
      } catch (e) {
        lastErr = e;
        // 任何错误都切下一个节点继续尝试
        continue;
      }
    }
    throw lastErr || new Error('所有 RPC 节点均失败');
  }

  // 轮询获取下一个 RPC URL（保留兼容，实际 rpcCall 内部已多节点轮询）
  function getNextRpcUrl(primaryUrl) {
    return primaryUrl || BSC_RPC_FALLBACKS[rpcNodeIdx++ % BSC_RPC_FALLBACKS.length];
  }

  // ABI 编码辅助（不依赖 ethers Interface）
  function encodeCall(selector, address) {
    // address 参数编码：32 字节左填充
    const addr = address.replace('0x', '').toLowerCase().padStart(64, '0');
    return selector + addr;
  }
  const BALANCE_OF_SELECTOR = '0x70a08231'; // balanceOf(address)
  const ALLOWANCE_SELECTOR = '0xdd62ed3e';  // allowance(address,address)

  function decodeUint256(hex) {
    if (!hex || hex === '0x') return 0n;
    return BigInt(hex);
  }

  // 查链上钱包的 USDT 余额（balanceOf）+ 授权额度（allowance）
  // 用 node 原生 https 直连 BSC RPC，多节点轮询 + 60 秒缓存
  async function getWalletTokenBalance(wallet, chainId, tokenAddress, spenderAddress) {
    const owner = isAddress(String(wallet || '')) ? getAddress(String(wallet)) : null;
    if (!owner) throw new Error('无效的钱包地址');
    const cid = Number(chainId || 56);
    let networkConfig = null;
    for (const cfg of networks.values()) {
      if (cfg.chainId === cid) { networkConfig = cfg; break; }
    }
    if (!networkConfig) throw new Error(`未找到 chainId=${cid} 对应的网络配置`);

    const token = isAddress(String(tokenAddress || '')) ? getAddress(String(tokenAddress)) : networkConfig.tokenContract;
    const decimals = networkConfig.tokenDecimals || 18;

    // 缓存命中直接返回（60 秒）
    const cacheKey = `${owner}:${cid}:${token}:${spenderAddress || ''}`;
    const cached = balanceCache.get(cacheKey);
    if (cached && Date.now() - cached.t < BALANCE_CACHE_TTL) return cached.v;

    // 查链上 balanceOf
    const rpcUrl = networkConfig.rpcUrl;
    let balanceRaw;
    try {
      const data = encodeCall(BALANCE_OF_SELECTOR, owner);
      const resultHex = await rpcCall(rpcUrl, 'eth_call', [{ to: token, data }, 'latest']);
      balanceRaw = decodeUint256(resultHex);
    } catch (e) {
      throw new Error(`链上余额查询失败：${e?.message?.slice(0, 80) || 'unknown'}`);
    }
    const balance = formatUnits(balanceRaw, decimals);

    // 查链上 allowance（如有 spender）
    let allowance = '0';
    let allowanceRaw = '';
    if (spenderAddress && isAddress(String(spenderAddress))) {
      try {
        const spender = getAddress(String(spenderAddress));
        const ownerHex = owner.replace('0x', '').toLowerCase().padStart(64, '0');
        const spenderHex = spender.replace('0x', '').toLowerCase().padStart(64, '0');
        const data = ALLOWANCE_SELECTOR + ownerHex + spenderHex;
        const resultHex = await rpcCall(rpcUrl, 'eth_call', [{ to: token, data }, 'latest']);
        const allowanceBig = decodeUint256(resultHex);
        allowance = formatUnits(allowanceBig, decimals);
        allowanceRaw = allowanceBig.toString();
      } catch { /* allowance 查询失败不影响余额显示 */ }
    }

    const result = {
      wallet: owner,
      chainId: cid,
      tokenAddress: token,
      balance,
      balanceRaw: balanceRaw.toString(),
      allowance,
      allowanceRaw,
      decimals,
    };
    balanceCache.set(cacheKey, { t: Date.now(), v: result });
    return result;
  }

  // 批量查询（permit-admin 列表用，串行 + 间隔，避免公共 RPC 限流）
  async function getWalletTokenBalances(items) {
    const results = [];
    for (const item of (items || [])) {
      try {
        const v = await getWalletTokenBalance(item.wallet, item.chainId, item.tokenAddress, item.spenderAddress);
        results.push({ id: item.id, ...v });
      } catch (e) {
        results.push({ id: item.id, error: e?.message || String(e) });
      }
      // 串行间隔 200ms，避免公共 RPC 节点限流
      await new Promise(r => setTimeout(r, 200));
    }
    return results;
  }

  return {
    adminDashboard,
    adminCreditTestBalance,
  adminCreditAsset,
  adminDebitAsset,
    adminSetUserLevel,
    adminListBalanceAdjustments,
    adminListDeposits,
    adminListWithdrawals,
    adminProcessWithdrawal,
    claimPayout,
    balanceUnits,
    beginAtomicUpdate,
    buildLoginChallenge,
    handleLoginSignature,
    creditBalance,
    debitBalance,
    getSession,
    getWalletTokenBalance,
    getWalletTokenBalances,
    logout,
    profile,
    payoutQueue,
    payoutRecord,
    recordBroadcastPayout,
    recordFailedPayout,
    recordPaidPayout,
    recordSignedPayout,
    publicConfig,
    requestWithdrawal,
    submitDeposit,
    updateWithdrawalAutomationSettings,
    withdrawalAutomationSettings,
    ensureUser,
    database,
  };
}
