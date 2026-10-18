// 临时：手动触发一次 A10 池日结，并打印两地址的到账（幂等，与定时器同键不会重复）
import { getConfig, DATA_ROOT } from '../src/config.js';
import { createWalletService } from '../src/wallet-service.js';
import { createATokenService } from '../src/a-token-service.js';
import { createATokenTeamService } from '../src/a-token-team-service.js';

const cfg = getConfig();
const walletService = createWalletService({ ...cfg.wallet, dataRoot: DATA_ROOT, withdrawalPrivateKey: cfg.wallet.withdrawalPrivateKey });
const aTokenService = createATokenService({ database: walletService.database, walletService });
const teamService = createATokenTeamService({ database: walletService.database, walletService });
const db = walletService.database;
const parse = (s) => { try { return JSON.parse(s || '{}'); } catch { return {}; } };
const fmt = (u) => Number(BigInt(u)) / 1e18;

const targets = ['0x1e76dd0a5d00d20b4e367ba7c16000c1f529d59d', '0x14599a1ea252a3c0ae174026db1d8829412b4022'];

const before = {};
for (const w of targets) before[w] = fmt(walletService.balanceUnits(w, 'A'));

const r = teamService.settleA10Pool();
console.log('结算结果:', JSON.stringify(r));
if (r?.settled) {
  console.log(`结算日期(北京): ${r.settleDate} ｜ 参与A10: ${r.participantCount} 人 ｜ 池总额: ${fmt(r.total)} AIX ｜ 人均: ${fmt(r.perShare)} AIX`);
}

console.log('== 两地址本次到账 ==');
for (const w of targets) {
  const row = db.db.prepare("SELECT payload_json FROM a_token_team_rewards WHERE lower(recipient_wallet)=? AND kind='a10_pool_share' ORDER BY created_at DESC LIMIT 1").get(w);
  const p = row ? parse(row.payload_json) : null;
  const after = fmt(walletService.balanceUnits(w, 'A'));
  console.log(w, '->', p ? `到账 ${fmt(p.amountUnits)} AIX` : '本次无记录', `｜ 余额 ${before[w]} -> ${after}`);
}
process.exit(0);
