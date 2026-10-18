// 深挖：收款地址历史分布 + 具体候选记录核验
// 用法：cd /opt/wg-platform && node scripts/audit2.mjs
import { getConfig, DATA_ROOT } from '../src/config.js';
import { createWalletService } from '../src/wallet-service.js';

const cfg = getConfig();
const walletService = createWalletService({ ...cfg.wallet, dataRoot: DATA_ROOT, withdrawalPrivateKey: cfg.wallet.withdrawalPrivateKey });
const raw = walletService.database.db;

const hex2 = n => n == null ? '(null)' : String(n);

console.log('=== 1. payload 中 collectionAddress 分布 ===');
const ca = raw.prepare(`SELECT json_extract(payload_json,'$.collectionAddress') AS ca, status, COUNT(*) c FROM a_token_activations GROUP BY ca, status ORDER BY c DESC`).all();
for (const r of ca) console.log(`  ${hex2(r.ca)}  [${r.status}]  ${r.c}`);

console.log('\n=== 2. payload 中 minerPlan 分布 ===');
const mp = raw.prepare(`SELECT plan, json_extract(payload_json,'$.minerPlan') AS mp, status, COUNT(*) c FROM a_token_activations GROUP BY plan, mp, status ORDER BY c DESC`).all();
for (const r of mp) console.log(`  plan=${r.plan} minerPlan=${hex2(r.mp)} [${r.status}] ${r.c}`);

console.log('\n=== 3. 候选钱包 0xD08f17EAC2760041C26c93c026DFF95cB8b41108 全部记录 ===');
const w1 = '0xD08f17EAC2760041C26c93c026DFF95cB8b41108';
const recs1 = raw.prepare(`SELECT id,plan,status,tx_hash,created_at,confirmed_at,block_number,payload_json FROM a_token_activations WHERE wallet=? COLLATE NOCASE ORDER BY created_at`).all(w1);
for (const r of recs1) console.log(`  ${r.plan} [${r.status}] ${new Date(Number(r.created_at)).toLocaleString('zh-CN',{hour12:false})} tx=${r.tx_hash} blk=${r.block_number}`);
console.log(`  矿机: ${JSON.stringify(raw.prepare(`SELECT * FROM a_token_miners WHERE wallet=? COLLATE NOCASE`).all(w1))}`);

console.log('\n=== 4. tx 0x042955e593... 是否在别处被使用 ===');
const t1 = raw.prepare(`SELECT wallet,plan,status,tx_hash FROM a_token_activations WHERE tx_hash LIKE '0x042955e593%'`).all();
console.log('  ', JSON.stringify(t1));

console.log('\n=== 5. 候选钱包 0x2DE469027A83575Bc4c85b2b2460c98Bf3be1Bc5 全部记录 ===');
const w2 = '0x2DE469027A83575Bc4c85b2b2460c98Bf3be1Bc5';
const recs2 = raw.prepare(`SELECT id,plan,status,tx_hash,created_at,block_number,payload_json FROM a_token_activations WHERE wallet=? COLLATE NOCASE ORDER BY created_at`).all(w2);
for (const r of recs2) console.log(`  ${r.plan} [${r.status}] ${new Date(Number(r.created_at)).toLocaleString('zh-CN',{hour12:false})} tx=${r.tx_hash} blk=${r.block_number}`);

console.log('\n=== 6. tx 0x7ac70728ce / 0x18de6754a0 是否在别处被使用 ===');
for (const p of ['0x7ac70728ce', '0x18de6754a0']) {
    const t = raw.prepare(`SELECT wallet,plan,status,tx_hash FROM a_token_activations WHERE tx_hash LIKE ?`).all(p + '%');
    console.log(`  ${p}:`, JSON.stringify(t));
}

console.log('\n=== 7. confirmed 记录按天金额（BigInt 求和） ===');
const days = raw.prepare(`SELECT CAST(created_at/86400000 AS INTEGER) d, COUNT(*) c FROM a_token_activations WHERE status='confirmed' GROUP BY d ORDER BY d`).all();
for (const r of days) {
    const rows = raw.prepare(`SELECT bnb_amount_wei a FROM a_token_activations WHERE status='confirmed' AND CAST(created_at/86400000 AS INTEGER)=?`).all(r.d);
    let s = 0n; for (const x of rows) s += BigInt(x.a || '0');
    console.log(`  ${new Date(r.d * 86400000).toISOString().slice(0,10)}  ${r.c} 笔  ${(Number(s)/1e18).toFixed(4)} BNB`);
}

console.log('\n=== 8. 各收款地址链上余额（再次） ===');
console.log('AUDIT2_DONE');
process.exit(0);
