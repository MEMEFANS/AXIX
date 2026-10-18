// 抽样核验 confirmed 记录的链上 to/from/value，判断是否所有付款都进 MAIN/ROT
// 用法：cd /opt/wg-platform && node scripts/audit3.mjs
import { getConfig, DATA_ROOT } from '../src/config.js';
import { createWalletService } from '../src/wallet-service.js';

const MAIN = '0xa71e0cfb92643ccf1fadcd45fcfb29b7b39c56e6';
const ROT  = '0xf9767c67a7f82f5b488f73b69e73017f635d333c';
const RPCS = ['https://bsc-rpc.publicnode.com', 'https://bsc-dataseed.binance.org', 'https://bsc.publicnode.com'];
const PLAN_AMT = { '1': (2n * 10n ** 15n).toString(), '2': (5n * 10n ** 16n).toString() };

const cfg = getConfig();
const walletService = createWalletService({ ...cfg.wallet, dataRoot: DATA_ROOT, withdrawalPrivateKey: cfg.wallet.withdrawalPrivateKey });
const raw = walletService.database.db;

let rpcIdx = 0;
async function rpc(method, params) {
    for (let a = 0; a < 4; a++) {
        const url = RPCS[rpcIdx % RPCS.length];
        try {
            const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(15000) });
            const j = await res.json();
            if (j.error) { rpcIdx++; await new Promise(r => setTimeout(r, 120)); continue; }
            return j.result;
        } catch (e) { rpcIdx++; await new Promise(r => setTimeout(r, 250)); }
    }
    return undefined;
}

const all = raw.prepare(`SELECT wallet,plan,tx_hash,created_at FROM a_token_activations WHERE status='confirmed' ORDER BY created_at`).all();
console.log(`confirmed 总数 = ${all.length}`);

// 每天取前 3 条抽样
const byDay = new Map();
for (const r of all) { const d = Math.floor(Number(r.created_at) / 86400000); if (!byDay.has(d)) byDay.set(d, []); if (byDay.get(d).length < 3) byDay.get(d).push(r); }
const sample = [...byDay.values()].flat();
console.log(`抽样条数 = ${sample.length}`);

const toCount = new Map(); const amtBad = []; const fromBad = []; const fail = []; let ok = 0;
for (let i = 0; i < sample.length; i++) {
    const r = sample[i];
    const tx = String(r.tx_hash || '');
    const t2 = await rpc('eth_getTransactionByHash', [tx]);
    if (!t2) { fail.push(r); continue; }
    const to = String(t2.to || '').toLowerCase();
    toCount.set(to, (toCount.get(to) || 0) + 1);
    if (to !== MAIN && to !== ROT) console.log(`  [非本平台地址] ${new Date(Number(r.created_at)).toLocaleString('zh-CN',{hour12:false})} plan${r.plan} wallet=${r.wallet} to=${to} value=${Number(BigInt(t2.value||'0'))/1e18}`);
    if (BigInt(t2.value || '0').toString() !== (PLAN_AMT[String(r.plan)] || '?')) amtBad.push({ ...r, v: Number(BigInt(t2.value||'0'))/1e18 });
    if (String(t2.from || '').toLowerCase() !== String(r.wallet || '').toLowerCase()) fromBad.push({ ...r, from: t2.from });
    ok++;
    process.stdout.write(`\r核验 ${i + 1}/${sample.length}   `);
}
console.log('\n');
console.log('=== 链上 to 分布(抽样) ===');
for (const [k, v] of [...toCount.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${k}  ${v}`);
console.log('\n=== 金额不符 ==='); console.log(amtBad.length ? JSON.stringify(amtBad) : '(无)');
console.log('\n=== from != 记录钱包 (tx 哈希可能被冒用) ==='); console.log(fromBad.length ? JSON.stringify(fromBad) : '(无)');
console.log('\n=== 取不到交易 ==='); console.log(fail.length ? JSON.stringify(fail) : '(无)');
console.log('\nSUMMARY', JSON.stringify({ sample: sample.length, ok, toDistinct: toCount.size, amtBad: amtBad.length, fromBad: fromBad.length, fail: fail.length }));
console.log('AUDIT3_DONE');
process.exit(0);
