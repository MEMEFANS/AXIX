// 链上漏单扫描：扫描指定块区间内所有「付款到我方收款地址」的交易，与 DB 记录比对
// 用法：cd /opt/wg-platform && node scripts/leakscan.mjs [hours]
import { getConfig, DATA_ROOT } from '../src/config.js';
import { createWalletService } from '../src/wallet-service.js';

const HOURS = Number(process.argv[2] || 24);
const RPCS = [
    'https://bsc-rpc.publicnode.com',
    'https://bsc.publicnode.com',
    'https://bsc-dataseed.binance.org',
    'https://bsc-dataseed1.defibit.io',
    'https://bsc-dataseed1.ninicoin.io',
    'https://1rpc.io/bnb',
    'https://binance.llamarpc.com',
];
const ADDRS = new Set([
    '0xa71e0cfb92643ccf1fadcd45fcfb29b7b39c56e6',
    '0xf9767c67a7f82f5b488f73b69e73017f635d333c',
    '0x11ebcbbb74d6900a22c1d9afb1182effd5408af2',
    '0x1271d01b13689bd47f793ab1e0b8651343700ddb',
    '0x1accee7ec8247a69ff350b32cb4338588f4146ec',
    '0x2c68a7ac9f240f7c47dc816f255c5892cea068ca',
    '0x40fac4707ad234bed31bc258b183d77d6bb27b28',
    '0xac308f10939507ede8a7db722955a88d12d7e430',
    '0xacda06bb87da7f01b4004b05911b2e1591d3ef35',
    '0xf70ffa2b4215faff51eb32466bdb9bbcbf4a975f',
]);
const AMT = new Set(['2000000000000000', '50000000000000000']);

const cfg = getConfig();
const walletService = createWalletService({ ...cfg.wallet, dataRoot: DATA_ROOT, withdrawalPrivateKey: cfg.wallet.withdrawalPrivateKey });
const raw = walletService.database.db;

const known = new Set();
for (const r of raw.prepare(`SELECT tx_hash FROM a_token_activations`).all()) known.add(String(r.tx_hash || '').toLowerCase());
console.log(`DB 已知 tx 数 = ${known.size}`);

const hits = new Map(); // txHash -> hit
let seq = 0;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchBatch(nums, tries) {
    const ep = RPCS[(seq++) % RPCS.length];
    for (let a = 0; a < tries; a++) {
        try {
            const body = nums.map((n, i) => ({ jsonrpc: '2.0', id: i, method: 'eth_getBlockByNumber', params: ['0x' + n.toString(16), true] }));
            const res = await fetch(ep, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
            const j = await res.json();
            if (!Array.isArray(j)) { await sleep(150); continue; }
            const byId = new Map(j.map(x => [x.id, x]));
            const got = new Map();
            for (let i = 0; i < nums.length; i++) {
                const x = byId.get(i);
                if (x && x.result) got.set(nums[i], x.result);
                else if (x && !x.error && x.result === null) got.set(nums[i], { transactions: [], timestamp: '0x0' });
            }
            if (got.size === nums.length) return got;
            if (got.size > 0) return got; // 部分成功，其余留待下一轮
            await sleep(150);
        } catch (e) { await sleep(200); }
    }
    return new Map();
}

function harvest(blockNum, blk) {
    if (!blk || !blk.transactions) return;
    const ts = parseInt(blk.timestamp, 16) * 1000;
    for (const t of blk.transactions) {
        const to = String(t.to || '').toLowerCase();
        if (!ADDRS.has(to)) continue;
        if (!AMT.has(BigInt(t.value || '0').toString())) continue;
        const h = String(t.hash).toLowerCase();
        hits.set(h, { block: blockNum, ts, tx: h, from: String(t.from || '').toLowerCase(), to, value: Number(BigInt(t.value)) / 1e18 });
    }
}

(async () => {
    // 取最新块
    let latest = 0;
    for (const ep of RPCS) {
        try {
            const res = await fetch(ep, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }), signal: AbortSignal.timeout(10000) });
            const j = await res.json();
            if (j.result) { const v = parseInt(j.result, 16); if (v > latest) latest = v; }
        } catch (e) { }
    }
    const to = latest;
    const from = Math.max(1, to - Math.round(HOURS * 7900));
    console.log(`扫描区间: ${from} .. ${to}  (${to - from} 块, 约 ${HOURS}h)`);

    const BATCH = 6, CONC = 40;
    let remaining = [];
    for (let b = from; b <= to; b += BATCH) { const c = []; for (let k = b; k < b + BATCH && k <= to; k++) c.push(k); remaining.push(c); }
    const t0 = Date.now();
    for (let round = 1; round <= 7 && remaining.length; round++) {
        const next = [];
        let p = 0, done = 0;
        async function worker() {
            while (true) {
                const k = p++;
                if (k >= remaining.length) return;
                const nums = remaining[k];
                const m = await fetchBatch(nums, 2);
                for (const n of nums) { const blk = m.get(n); if (blk) harvest(n, blk); else next.push(n); }
                done++;
                if ((done % 200) === 0) process.stdout.write(`\rround${round} ${done}/${remaining.length} 命中${hits.size} 待重试${next.length}   `);
            }
        }
        await Promise.all(Array.from({ length: CONC }, worker));
        const sp = ((Date.now() - t0) / 1000);
        console.log(`\rround ${round}: 完成 ${remaining.length} 组, 命中 ${hits.size}, 剩余缺块 ${next.length}, 耗时 ${sp.toFixed(0)}s          `);
        // 重新分组剩余块
        remaining = [];
        for (let i = 0; i < next.length; i += BATCH) remaining.push(next.slice(i, i + BATCH));
        if (remaining.length) await sleep(1500);
    }
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    const hitArr = [...hits.values()];
    const notInDb = hitArr.filter(h => !known.has(h.tx));
    console.log(`\n扫描完成 ${secs}s, 命中我方收款 ${hitArr.length} 笔, 仍缺块 ${remaining.length} 组`);
    console.log(`\n=== 链上付款但我方 DB 无记录（漏单候选）: ${notInDb.length} 笔 ===`);
    for (const h of notInDb.sort((a, b) => a.ts - b.ts)) {
        console.log(`  ${new Date(h.ts).toLocaleString('zh-CN', { hour12: false })}  ${h.value} BNB  from=${h.from}  to=${h.to}  tx=${h.tx}  blk=${h.block}`);
    }
    const byTo = {};
    for (const h of hitArr) byTo[h.to] = (byTo[h.to] || 0) + h.value;
    console.log('\n=== 本次窗口命中的链上流入按地址 ===');
    for (const [a, v] of Object.entries(byTo)) console.log(`  ${a}  ${v.toFixed(6)} BNB`);
    console.log('\nSUMMARY', JSON.stringify({ from, to, hours: HOURS, secs: Number(secs), hits: hitArr.length, notInDb: notInDb.length, missingGroups: remaining.length }));
    console.log('LEAKSCAN_DONE');
    process.exit(0);
})();
