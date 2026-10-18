import { formatUnits } from 'ethers';

const USDT_DECIMALS = 6;
const key = value => String(value || '').toLowerCase();

// 代理数据服务：所有数据按代理绑定钱包的下级闭包过滤
export function createAgentService({ walletService, referralService, database }) {
  function downline(agentWallet) {
    return referralService.getDownlineWallets(agentWallet);
  }

  // 概览：下级用户数、有效数、总充值、总提现、平台余额、返佣已领/待领
  function dashboard(agentWallet) {
    const set = downline(agentWallet);
    const dash = walletService.adminDashboard();
    const users = dash.users.filter(u => set.has(key(u.address)));
    const realUsers = users.filter(u => u.isRealUser).length;
    const totalDeposited = users.reduce((s, u) => s + BigInt(u.confirmedDepositTotal ? Math.round(Number(u.confirmedDepositTotal) * 1e6) : 0), 0n);

    const allWithdrawals = walletService.adminListWithdrawals();
    const downlineWithdrawals = allWithdrawals.filter(r => set.has(key(r.wallet)));
    const totalWithdrawn = downlineWithdrawals
      .filter(r => r.status === 'paid' && /^\d+$/.test(String(r.amountUnits || '')))
      .reduce((s, r) => s + BigInt(r.amountUnits), 0n);
    const pendingWithdrawals = downlineWithdrawals.filter(r => ['pending_review', 'payout_failed'].includes(r.status)).length;

    const totalBalance = users.reduce((s, u) => s + BigInt(u.platformUsdtBalance ? Math.round(Number(u.platformUsdtBalance) * 1e6) : 0), 0n);

    // 返佣汇总：该钱包作为推荐人的交易返佣 + AI 返佣
    const tradeRewards = database.listReferralRewards(agentWallet, 5000);
    const aiRewards = database.listAiRewards(agentWallet, 5000).filter(item => item.kind === 'referral');
    const allRewards = [...tradeRewards, ...aiRewards];
    const earned = allRewards.filter(item => item.status !== 'pending').reduce((s, item) => s + BigInt(item.amountUnits || '0'), 0n);
    const claimable = allRewards.filter(item => item.status === 'pending').reduce((s, item) => s + BigInt(item.amountUnits || '0'), 0n);

    return {
      summary: {
        downlineUsers: users.length,
        realUsers,
        totalDepositedUsdt: formatUnits(totalDeposited, USDT_DECIMALS),
        totalWithdrawnUsdt: formatUnits(totalWithdrawn, USDT_DECIMALS),
        totalPlatformBalanceUsdt: formatUnits(totalBalance, USDT_DECIMALS),
        pendingWithdrawals,
        earnedUsdt: formatUnits(earned, USDT_DECIMALS),
        claimableUsdt: formatUnits(claimable, USDT_DECIMALS),
      },
    };
  }

  // 下级用户列表
  function users(agentWallet) {
    const set = downline(agentWallet);
    const dash = walletService.adminDashboard();
    return dash.users.filter(u => set.has(key(u.address)));
  }

  // 下级充值记录
  function deposits(agentWallet, status = '') {
    const set = downline(agentWallet);
    return walletService.adminListDeposits(status).filter(r => set.has(key(r.wallet)));
  }

  // 下级提现记录
  function withdrawals(agentWallet, status = '') {
    const set = downline(agentWallet);
    return walletService.adminListWithdrawals(status).filter(r => set.has(key(r.wallet)));
  }

  // 推荐返佣记录（该钱包作为推荐人）
  function referralRewards(agentWallet) {
    const tradeRewards = database.listReferralRewards(agentWallet, 5000);
    const aiRewards = database.listAiRewards(agentWallet, 5000).filter(item => item.kind === 'referral');
    const rows = [
      ...tradeRewards.map(r => ({ ...r, source:'trading_fee' })),
      ...aiRewards.map(r => ({ ...r, source:'ai_managed', sourceWallet: r.fromWallet })),
    ].sort((a, b) => Number(b.createdAt || b.slotAt || 0) - Number(a.createdAt || a.slotAt || 0));
    const earned = rows.filter(r => r.status !== 'pending').reduce((s, r) => s + BigInt(r.amountUnits || '0'), 0n);
    const claimable = rows.filter(r => r.status === 'pending').reduce((s, r) => s + BigInt(r.amountUnits || '0'), 0n);
    return {
      earnedUsdt: formatUnits(earned, USDT_DECIMALS),
      claimableUsdt: formatUnits(claimable, USDT_DECIMALS),
      rows: rows.map(r => ({
        id: r.id,
        sourceWallet: r.sourceWallet || r.fromWallet,
        kind: r.kind || r.rewardKind,
        source: r.source,
        amountUsdt: formatUnits(BigInt(r.amountUnits || '0'), USDT_DECIMALS),
        status: r.status,
        createdAt: r.createdAt || r.slotAt,
      })),
    };
  }

  return { dashboard, users, deposits, withdrawals, referralRewards };
}
