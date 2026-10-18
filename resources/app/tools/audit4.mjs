// 全量确认记录链上 to 普查 → 逐收款地址「余额 - 已记账」= 未记账(漏单)金额
// 用法：cd /opt/wg-platform && node scripts/audit4.mjs
import { getConfig, DATA_ROOT } from '../src/config.js';
import { createWalletService } from '../src/wallet-service.js';

const RPCS = [
    'https://bsc-rpc.publicnode.com',
    'https://bsc-dataseed.binance.org',
    'https://bsc.publicnode.com',
    'https://1rpc.io/bnb',
    'https://bsc-dataseed1.defibit.io',
];

const cfg = getConfig();
const walletService = createWalletService({ ...cfg.wallet, dataRoot: DATA_ROOT, withdrawalPrivateKey: cfg.wallet.withdrawalPrivateKey });
const raw = walletService.database.db;

let rpcSeq = 0;
async function rpc(method, params, tries = 4) {
    let lastUrl = '';
    for (let a = 0; a < tries; a++) {
        const url = RPCS[(rpcSeq++) % RPCS.length];
        lastUrl = url;
        try {
            const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(12000) });
            const j = await res.json();
            if (j.error) { await new Promise(r => setTimeout(r, 100 + a * 150)); continue; }
            return j.result;
        } catch (e) { await new Promise(r => setTimeout(r, 120 + a * 200)); }
    }
    return undefined;
}

const rows = raw.prepare(`SELECT plan,tx_hash,wallet,bnb_amount_wei,created_at FROM a_token_activations WHERE status='confirmed' ORDER BY created_at`).all();
console.log(`confirmed 记录数 = ${rows.length}，开始链上普查...`);

const byAddrSum = new Map();   // to -> {Wei, cnt}
const byAddrPlan = new Map();  // to -> Map(plan->cnt)
const mismatch = [];          // 链上金额/付款人 与 DB 记录不符
const CONC = 16;
const sleep = ms => new Promise(r => setTimeout(r, ms));

let pending = rows.slice();
let failList = [];
for (let round = 1; round <= 6 && pending.length; round++) {
    const next = [];
    let p = 0;
    let done = 0;
    async function worker() {
        while (true) {
            const k = p++;
            if (k >= pending.length) return;
            const r = pending[k];
            const t2 = await rpc('eth_getTransactionByHash', [String(r.tx_hash || '')]);
            if (!t2) { next.push(r); }
            else {
                const to = String(t2.to || 'unknown').toLowerCase();
                const v = BigInt(t2.value || '0');
                const e = byAddrSum.get(to) || { Wei: 0n, cnt: 0 };
                e.Wei += v; e.cnt++; byAddrSum.set(to, e);
                if (!byAddrPlan.has(to)) byAddrPlan.set(to, new Map());
                const pm = byAddrPlan.get(to); const kk = String(r.plan); pm.set(kk, (pm.get(kk) || 0) + 1);
                const dbAmt = BigInt(r.bnb_amount_wei || '0');
                const fromOk = String(t2.from || '').toLowerCase() === String(r.wallet || '').toLowerCase();
                if (v !== dbAmt || !fromOk) {
                    if (mismatch.length < 400) mismatch.push({ plan: r.plan, wallet: r.wallet, tx: String(r.tx_hash), to,
                        onchain: Number(v) / 1e18, db: Number(dbAmt) / 1e18, fromOk,
                        when: new Date(Number(r.created_at)).toLocaleString('zh-CN', { hour12: false }) });
                }
            }
            done++;
            if ((done % 250) === 0) process.stdout.write(`\rround${round} ${done}/${pending.length}   `);
        }
    }
    await Promise.all(Array.from({ length: CONC }, worker));
    console.log(`\rround ${round}: 剩余未取到 ${next.length} 笔              `);
    pending = next;
    if (pending.length) await sleep(2000);
}
failList = pending.map(r => r.tx_hash);
let fails = failList.length;

const fmt = w => (Number(w) / 1e18).toFixed(6);
console.log('\n=== 各收款地址：已记账金额 vs 链上余额 ===');
console.log('地址                                        记录数   已记账BNB      链上余额BNB   nonce  缺口(余额-记账)');
const addrs = [...byAddrSum.keys()].sort();
const result = [];
for (const a of addrs) {
    const rec = byAddrSum.get(a);
    const [bal, nonce] = await Promise.all([rpc('eth_getBalance', [a, 'latest']), rpc('eth_getTransactionCount', [a, 'latest'])]);
    const balW = bal ? BigInt(bal) : 0n;
    const nc = nonce ? BigInt(nonce) : 0n;
    const gap = balW - rec.Wei;
    result.push({ a, cnt: rec.cnt, rec: rec.Wei, bal: balW, nonce: nc, gap });
    const planStr = [...(byAddrPlan.get(a) || new Map()).entries()].map(([k, v]) => `p${k}:${v}`).join(' ');
    console.log(`${a}  ${String(rec.cnt).padStart(5)}   ${fmt(rec.Wei).padStart(10)}   ${fmt(balW).padStart(10)}   ${String(nc).padStart(4)}   ${fmt(gap).padStart(10)}   ${planStr}`);
}

console.log('\n=== 汇总 ===');
let totRec = 0n, totBal = 0n, totGap = 0n;
for (const r of result) { totRec += r.rec; totBal += r.bal; totGap += r.gap; }
console.log(`  已记账合计 = ${fmt(totRec)} BNB`);
console.log(`  链上余额合计 = ${fmt(totBal)} BNB`);
console.log(`  缺口合计(余额-记账) = ${fmt(totGap)} BNB`);

const suspect = result.filter(r => r.gap > 0n && r.nonce === 0n);
console.log('\n=== 缺口>0 且 nonce=0（未转出，缺口=漏单金额）===');
if (!suspect.length) console.log('  (无)');
for (const r of suspect) {
    console.log(`  ${r.a}  缺口 ${fmt(r.gap)} BNB  (已记账 ${fmt(r.rec)}, 余额 ${fmt(r.bal)})`);
    // 缺口可分解为若干笔付款
    for (const plan of ['1', '2']) {
        const amt = plan === '1' ? 2n * 10n ** 15n : 5n * 10n ** 16n;
        if (r.gap % amt === 0n && r.gap / amt > 0n) console.log(`     = ${r.gap / amt} 笔 plan${plan}(${plan === '1' ? '0.002' : '0.05'} BNB)`);
    }
}
if (failList.length) { console.log('\n=== 取不到交易的 tx（前若干）==='); console.log(failList.slice(0, 30).join('\n')); }

console.log('\n=== 链上金额/付款人 与 DB 记录不符 ===');
console.log(`不符条数 = ${mismatch.length}`);
for (const m of mismatch.slice(0, 80)) console.log(`  ${m.when} plan${m.plan} ${m.wallet} tx=${m.tx.slice(0, 12)} 链上=${m.onchain} DB=${m.db} fromOk=${m.fromOk} to=${m.to}`);
const overpay = mismatch.filter(m => m.onchain > m.db).reduce((s, m) => s + (m.onchain - m.db), 0);
const underpay = mismatch.filter(m => m.onchain < m.db).reduce((s, m) => s + (m.db - m.onchain), 0);
console.log(`  链上多于记录合计 = ${overpay.toFixed(6)} BNB；链上少于记录合计 = ${underpay.toFixed(6)} BNB`);

console.log('\nSUMMARY', JSON.stringify({ records: rows.length, fails, addrs: addrs.length, gapTotal: Number(totGap) / 1e18, suspect: suspect.map(r => ({ addr: r.a, gap: Number(r.gap) / 1e18 })) }));
console.log('AUDIT4_DONE');
process.exit(0);
