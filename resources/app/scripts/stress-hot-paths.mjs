// 性能/正确性压力脚本（仅本地临时验证，跑完即删）：
// 1) 派生索引正确性：开仓后价格暴跌 → liquidate() 必须仍然触发（索引不能漏算）
// 2) 规模性能：3 万账户下 processMarkPrice 每 tick 耗时、earningsLeaderboard 重算耗时
import fs from 'node:fs';
import path from 'node:path';
import { Wallet } from 'ethers';
import { createWalletService } from '../src/wallet-service.js';
import { createPlatformService } from '../src/platform-service.js';

const TMP = path.resolve('wg-stress-tmp');
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

const walletService = createWalletService({ dataRoot: TMP });
const platformService = createPlatformService({ dataRoot: TMP, walletService });

const user = Wallet.createRandom().address;
// 1) 开仓 → 暴跌 → 爆仓必须触发
walletService.creditBalance(user, 'USDT', 1000n * 10n ** 6n);
platformService.perpTrade(user, { symbol:'BTC', side:'buy', size:'0.01', price:'50000', leverage:10, marginMode:'isolated' });
const acct = platformService.profile(user);
console.log('开仓后 BTC 持仓 =', acct.perps.BTC.size);
platformService.processMarkPrice('perp', 'BTC', 5000); // 暴跌 90%，必爆仓
const acct2 = platformService.profile(user);
const liquidated = Number(acct2.perps.BTC.size) === 0;
console.log(liquidated ? '✓ 爆仓触发（索引未漏算）' : `✗ 爆仓未触发！size=${acct2.perps.BTC.size}`);
if (!liquidated) process.exit(1);

// 2) 规模压测：直接往 DB 种 3 万个账户（大部分空账户，2 个有仓位的在索引外账户里）
const db = platformService.database;
const now = Date.now();
const seedOne = db.db.prepare(`INSERT INTO platform_accounts(address,updated_at,payload_json) VALUES(?,?,?)
  ON CONFLICT(address) DO UPDATE SET updated_at=excluded.updated_at, payload_json=excluded.payload_json`);
function emptyAccount(addr) {
  const perps = {}; for (const s of ['BTC','ETH','BNB','SOL','XRP','DOGE']) perps[s] = { sizeUnits:'0', entryPriceUnits:'0', marginUnits:'0', realizedPnlUnits:'0', feeUnits:'0', fundingPnlUnits:'0', leverage:1, marginMode:'isolated' };
  return { address: addr, strategyBalanceUnits:'0', spot:{ BTC:'0', ETH:'0', BNB:'0', SOL:'0', XRP:'0', DOGE:'0' }, perps,
    internalStrategies:{}, staking:{ principalUnits:'0', rewardUnits:'0', rewardRemainder:'0' } };
}
const insertMany = (rows) => db.transaction(() => { for (const [a, p] of rows) seedOne.run(a.toLowerCase(), now, JSON.stringify(p)); });
const rows = [];
for (let i = 0; i < 30_000; i++) rows.push([`0x${(0x100000 + i).toString(16).padStart(40, '0')}`, emptyAccount(`0x${(0x100000 + i).toString(16).padStart(40, '0')}`)]);
insertMany(rows);
// 一个账户有仓位（验证索引重建后仍能扫到）
const holder = '0xaaaabbbbccccdddd111122223333444455556666';
const holderAcct = emptyAccount(holder);
holderAcct.perps.ETH = { sizeUnits:'100000000', entryPriceUnits:'3000000000', marginUnits:'5000000', realizedPnlUnits:'0', feeUnits:'0', fundingPnlUnits:'0', leverage:5, marginMode:'isolated' };
seedOne.run(holder, now, JSON.stringify(holderAcct));
console.log('已种入 30,001 个账户');

// 重新创建服务（模拟重启加载）
const walletService2 = createWalletService({ dataRoot: TMP });
const svc = createPlatformService({ dataRoot: TMP, walletService: walletService2 });

// 3) processMarkPrice tick 性能（1000 次）
let t0 = performance.now();
for (let i = 0; i < 1000; i++) svc.processMarkPrice('perp', 'BTC', 50000 + (i % 100));
let t1 = performance.now();
console.log(`processMarkPrice ×1000：${(t1 - t0).toFixed(1)}ms（均 ${(t1 - t0) / 1000}ms/tick）`);

// 4) 索引重建后持仓账户仍被风控覆盖：ETH 跌到 1 → holder 必须爆仓
svc.processMarkPrice('perp', 'ETH', 1);
const h = svc.profile(holder);
const holderOk = Number(h.perps.ETH.size) === 0;
console.log(holderOk ? '✓ 索引重建后有仓账户仍被爆仓覆盖' : `✗ 有仓账户未被风控！size=${h.perps.ETH.size}`);
if (!holderOk) process.exit(1);

// 5) 风云榜重算性能（冷缓存）
t0 = performance.now();
const lb = svc.earningsLeaderboard({ limit: 100, address: '' });
t1 = performance.now();
console.log(`earningsLeaderboard 冷算：${(t1 - t0).toFixed(1)}ms，total=${lb.total}`);

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* Windows 下 sqlite 句柄未释放时可能 EPERM，目录留给下次覆盖 */ }
console.log('STRESS_OK');
