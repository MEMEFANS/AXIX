import crypto from 'node:crypto';
import { formatUnits } from 'ethers';
import { A_TOKEN_DECIMALS, USDT_DECIMALS } from './a-token-service.js';

// A 币互转：按用户ID（8位数字+字母）转账，转让方承担手续费，接收方得净额。
// 手续费率与 AIX 交易卖盘一致，按转让方直推有效人数阶梯：
//   直推 0~1→50%, 2~3→40%, 4~5→30%, 6~7→20%, 8~9→10%, ≥10→3%
// 手续费去向：50% 销毁 + 50% 进 A10 团队分红池（日结均分给所有 A10 用户）。
const BPS = 10_000n;
const MIN_TRANSFER_A = 20n * 10n ** BigInt(A_TOKEN_DECIMALS);   // 互转最低 20 AIX
const FEE_RATE_BPS_DEFAULT = 5000n;   // 默认 50%
const BURN_SHARE_BPS = 5000n;         // 手续费的 50% 销毁
const DIVIDEND_SHARE_BPS = 5000n;     // 手续费的 50% 进 A10 分红池
const id = prefix => `${prefix}_${crypto.randomBytes(8).toString('hex')}`;

export function createATokenTransferService({ aTokenService, database, referralService = null, teamService = null, walletService = null, clock = () => Date.now() }) {
  const db = database;

  // 直推人数 → 手续费率（bps）；与 a-token-order-service 卖盘阶梯完全一致
  function feeBpsByDirectCount(n) {
    const cnt = Number(n) || 0;
    if (cnt >= 10) return 300n;
    if (cnt >= 8)  return 1000n;
    if (cnt >= 6)  return 2000n;
    if (cnt >= 4)  return 3000n;
    if (cnt >= 2)  return 4000n;
    return FEE_RATE_BPS_DEFAULT;
  }

  function minerDirectCountOf(wallet) {
    try { return referralService?.minerDirectCount?.(String(wallet || '').toLowerCase()) ?? 0; }
    catch { return 0; }
  }

  // 后台费率覆盖（service_settings.a_token_fee_overrides）：指定地址直接用配置费率（bps），优先于直推阶梯
  function feeOverrideBpsOf(wallet) {
    try {
      const raw = db.getSetting?.('a_token_fee_overrides');
      if (!raw) return null;
      const bps = Number(JSON.parse(raw)?.wallets?.[String(wallet || '').toLowerCase()]);
      return Number.isFinite(bps) && bps >= 0 && bps <= 10000 ? BigInt(Math.floor(bps)) : null;
    } catch { return null; }
  }

  // 转让方费率快照：后台覆盖优先，其次按直推阶梯；手续费内部分配（50% 销毁 / 50% 分红池）不变
  function feeRatesFor(wallet) {
    const directCount = minerDirectCountOf(wallet);
    const fee = feeOverrideBpsOf(wallet) ?? feeBpsByDirectCount(directCount);
    return { fee, directCount, burnShare: BURN_SHARE_BPS, dividendShare: DIVIDEND_SHARE_BPS };
  }

  function resolveRecipient(toUserId) {
    const userId = String(toUserId || '').trim().toUpperCase();
    if (!userId) throw new Error('请输入接收方用户ID');
    const row = aTokenService.getUserId(userId);
    if (!row) throw new Error('接收方用户ID不存在');
    return row.wallet;
  }

  // 报价预览（不扣款、不入库）：供前端打开弹窗/输入数量时展示阶梯费率
  function quote(fromWallet, amountInput) {
    const rates = feeRatesFor(fromWallet);
    const feePct = (Number(rates.fee) / 100).toFixed(0) + '%';
    const out = {
      directCount: rates.directCount,
      feeRateBps: Number(rates.fee),
      feePct,
      amount: '0', fee: '0', burn: '0', dividend: '0', net: '0',
    };
    const raw = String(amountInput ?? '').trim();
    if (!raw) return out;
    const a = aTokenService.parseA(raw, '转让数量');
    const feeA = a * rates.fee / BPS;
    // 手续费固定 50% 销毁 + 50% 进 A10 池（不受销毁开关影响）
    const burnA = feeA * rates.burnShare / BPS;
    const dividendA = feeA - burnA;
    const netA = a - feeA;
    return {
      ...out,
      amount: formatUnits(a, A_TOKEN_DECIMALS),
      fee: formatUnits(feeA, A_TOKEN_DECIMALS),
      burn: formatUnits(burnA, A_TOKEN_DECIMALS),
      dividend: formatUnits(dividendA, A_TOKEN_DECIMALS),
      net: formatUnits(netA, A_TOKEN_DECIMALS),
    };
  }

  function transferByUserId(fromWallet, toUserId, amountInput, requestId = '') {
    // 后台封禁名单：封禁地址不可发起 AIX 互转（静默封禁沿用静默文案，不暴露封禁状态）
    if (walletService?.isAccountBlocked?.(fromWallet)) {
      if (walletService.isSilentAccountBlocked?.(fromWallet)) {
        throw Object.assign(new Error('账户操作不可用'), { code: 'ACCOUNT_ACTION_DISABLED' });
      }
      throw new Error('该账户已被封禁，无法互转');
    }
    // 幂等：同一转让方同一 requestId 重复提交（网络重试/签名重放）直接返回已有结果，防双转
    const reqId = String(requestId || '').trim();
    if (reqId && db.getATokenTransferByRequestId) {
      const existing = db.getATokenTransferByRequestId(fromWallet, reqId);
      if (existing) {
        return {
          ok: true, idempotent: true,
          toUserId: existing.toUserId,
          amount: existing.payload?.amount, net: existing.payload?.net,
          fee: existing.payload?.fee, burn: existing.payload?.burn,
          dividend: existing.payload?.dividend,
          feePct: existing.payload?.feePct, directCount: existing.payload?.directCount,
          transferId: existing.id,
        };
      }
    }
    const toWallet = resolveRecipient(toUserId);
    // 接收方在封禁名单：拒绝转入（统一提示，不暴露对方封禁状态）
    if (walletService?.isAccountBlocked?.(toWallet)) throw new Error('接收方账户暂无法接收互转');
    if (toWallet.toLowerCase() === String(fromWallet).toLowerCase()) throw new Error('不能向自己转账');
    const a = aTokenService.parseA(amountInput, '转让数量');
    if (a < MIN_TRANSFER_A) throw new Error(`AIX 互转最低 ${formatUnits(MIN_TRANSFER_A, A_TOKEN_DECIMALS)} 个起`);
    if (aTokenService.balanceA(fromWallet) < a) throw new Error('A 币余额不足');
    // 手续费按转让方直推人数阶梯（与 AIX 交易卖盘一致）：0~1→50% … ≥10→3%
    const rates = feeRatesFor(fromWallet);
    const feeA = a * rates.fee / BPS;
    // 手续费固定 50% 销毁 + 50% 进 A10 池（不受销毁开关影响）
    const burnA = feeA * rates.burnShare / BPS;
    const dividendA = feeA - burnA;
    const netA = a - feeA;
    if (netA <= 0n) throw new Error('转让数量过小');
    // 执行：扣转让方总额 → 销毁/分红 → 给接收方净额
    const t = clock();
    const transferId = id('atx');
    aTokenService.debitA(fromWallet, a);
    if (burnA > 0n) aTokenService.burn(burnA, 'transfer', '互转手续费销毁');
    if (dividendA > 0n) { try { teamService?.distributeToA10Pool(dividendA, transferId, t); } catch {} }
    aTokenService.creditA(toWallet, netA);
    const transfer = {
      id: transferId, fromWallet, toWallet, toUserId: String(toUserId).trim().toUpperCase(),
      amountUnits: a.toString(), feeUnits: feeA.toString(),
      burnUnits: burnA.toString(), dividendUnits: dividendA.toString(),
      feeRateBps: Number(rates.fee), directCount: rates.directCount,
      requestId: reqId,
      createdAt: t,
      payload: { amount: formatUnits(a, A_TOKEN_DECIMALS), net: formatUnits(netA, A_TOKEN_DECIMALS),
        fee: formatUnits(feeA, A_TOKEN_DECIMALS), burn: formatUnits(burnA, A_TOKEN_DECIMALS),
        dividend: formatUnits(dividendA, A_TOKEN_DECIMALS), feePct: (Number(rates.fee) / 100).toFixed(0) + '%', directCount: rates.directCount },
    };
    db.insertATokenTransferRow(transfer);
    return {
      ok: true,
      toUserId: transfer.toUserId,
      amount: formatUnits(a, A_TOKEN_DECIMALS),
      net: formatUnits(netA, A_TOKEN_DECIMALS),
      fee: formatUnits(feeA, A_TOKEN_DECIMALS),
      burn: formatUnits(burnA, A_TOKEN_DECIMALS),
      dividend: formatUnits(dividendA, A_TOKEN_DECIMALS),
      feePct: (Number(rates.fee) / 100).toFixed(0) + '%',
      directCount: rates.directCount,
      transferId: transfer.id,
    };
  }

  function myTransfers(wallet, limit = 50) {
    return db.listATokenTransfers(wallet, limit).map(t => ({
      ...t,
      amount: formatUnits(BigInt(t.amountUnits), A_TOKEN_DECIMALS),
      fee: formatUnits(BigInt(t.feeUnits), A_TOKEN_DECIMALS),
      direction: String(t.fromWallet).toLowerCase() === String(wallet).toLowerCase() ? 'out' : 'in',
      counterparty: String(t.fromWallet).toLowerCase() === String(wallet).toLowerCase() ? t.toWallet : t.fromWallet,
    }));
  }

  return { transferByUserId, myTransfers, resolveRecipient, quote };
}
