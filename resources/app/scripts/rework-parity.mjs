// 一次性运维：平级奖口径重算（2026-09-13 新规则）
// 旧口径：每次产出事件对链上同级节点实时发 10%（kind=miner_parity/stake_parity）→ 作废
// 新口径：直推且同级的下级，其当日团队收益（team+level_diff，不含直推/间推）的 10%，每日一条（kind=parity）
// 步骤：① 汇总并扣回所有旧平级奖入账（余额不足按余额扣）② 删除旧平级奖记录
//       ③ 按北京日逐日重算新平级奖（幂等，可重复执行；等级取当前快照）
// 用法：node scripts/rework-parity.mjs   跑完必须 systemctl restart wg-platform
import { getConfig, DATA_ROOT } from '../src/config.js';
import { createWalletService } from '../src/wallet-service.js';
import { createATokenTeamService } from '../src/a-token-team-service.js';
import { beijingDayStart, formatAix } from '../src/a-token-income.js';

const cfg = getConfig();
const walletService = createWalletService({ ...cfg.wallet, dataRoot: DATA_ROOT, withdrawalPrivateKey: cfg.wallet.withdrawalPrivateKey });
const teamService = createATokenTeamService({ database: walletService.database, walletService });
const db = walletService.database;

const OLD_KINDS = "('miner_parity','stake_parity')";
const TEAM_KINDS = "('miner_team','stake_team','miner_level_diff','stake_level_diff')";

// ── ①+② 扣回并删除旧平级奖 ──
const oldRows = db.db.prepare(`SELECT id, recipient_wallet AS w, amount_units AS a FROM a_token_team_rewards WHERE kind IN ${OLD_KINDS}`).all();
const owedByWallet = new Map();
for (const r of oldRows) {
  const w = String(r.w || '').toLowerCase();
  owedByWallet.set(w, (owedByWallet.get(w) || 0n) + BigInt(r.a || '0'));
}
let revokedTotal = 0n;
for (const [w, owed] of owedByWallet) {
  let available = 0n;
  try { available = walletService.balanceUnits(w, 'A'); } catch {}
  const revoke = owed < available ? owed : available;
  if (revoke > 0n) {
    walletService.debitBalance(w, 'A', revoke.toString());
    revokedTotal += revoke;
  }
  console.log(`扣回 ${w}：旧平级奖 ${formatAix(owed.toString())} AIX，实际扣 ${formatAix(revoke.toString())}${revoke < owed ? `（余额不足，少扣 ${formatAix((owed - revoke).toString())}）` : ''}`);
}
const del = db.db.prepare(`DELETE FROM a_token_team_rewards WHERE kind IN ${OLD_KINDS}`).run();
console.log(`已删除旧平级奖记录 ${del.changes} 条，合计扣回 ${formatAix(revokedTotal.toString())} AIX`);

// ── ③ 按北京日逐日重算 ──
const teamRows = db.db.prepare(`SELECT DISTINCT created_at FROM a_token_team_rewards WHERE kind IN ${TEAM_KINDS}`).all();
const days = [...new Set(teamRows.map(r => beijingDayStart(Number(r.created_at))))].sort((a, b) => a - b);
console.log(`需重算 ${days.length} 个北京日`);
let newCount = 0;
let newTotal = 0n;
for (const dayStart of days) {
  const r = teamService.settleParityRewards(dayStart + 3600000);
  if (r?.settled) {
    newCount += r.count;
    newTotal += BigInt(r.total || '0');
    console.log(`日槽 ${r.daySlot}：新增平级奖 ${r.count} 条，合计 ${r.totalA} AIX`);
  }
}
console.log(`重算完成：新平级奖 ${newCount} 条，合计 ${formatAix(newTotal.toString())} AIX`);
process.exit(0);
