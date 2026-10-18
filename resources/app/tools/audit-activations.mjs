// 一次性审计：A) 收款地址余额对账  B) pending/rejected 记录的链上真伪核验
// 用法：在 /opt/wg-platform 下 node scripts/audit-activations.mjs
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
    for (let attempt = 0; attempt < 4; attempt++) {
        const url = RPCS[rpcIdx % RPCS.length];
        try {
            const res = await fetch(url, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
                signal: AbortSignal.timeout(15000),
            });
            const j = await res.json();
            if (j.error) { rpcIdx++; await new Promise(r => setTimeout(r, 150)); continue; }
            return j.result;
        } catch (e) { rpcIdx++; await new Promise(r => setTimeout(r, 300)); }
    }
    return undefined;
}
const hex2bi = h => h ? BigInt(h) : 0n;
const fmt = w => (Number(w) / 1e18).toFixed(6);

// ── A. 余额对账 ──────────────────────────────────────────────
console.log('=== A. 收款地址链上状态 ===');
const addrInfo = {};
for (const [name, a] of [['MAIN', MAIN], ['ROT', ROT]]) {
    const [bal, nonce] = await Promise.all([
        rpc('eth_getBalance', [a, 'latest']),
        rpc('eth_getTransactionCount', [a, 'latest']),
    ]);
    addrInfo[name] = { bal: hex2bi(bal), nonce: Number(hex2bi(nonce)) };
    console.log(`  ${name} ${a}  balance=${fmt(hex2bi(bal))} BNB  nonce(对外发出tx数)=${Number(hex2bi(nonce))}`);
}
const totalOnchain = addrInfo.MAIN.bal + addrInfo.ROT.bal;
const anySent = addrInfo.MAIN.nonce > 0 || addrInfo.ROT.nonce > 0;
console.log(`  合计链上余额 = ${fmt(totalOnchain)} BNB${anySent ? '  << 注意: 有对外转账, 余额!=总流入' : '  (两个地址均未对外发过 tx → 余额 = 历史总流入)'}`);

const sums = raw.prepare(`SELECT status, COUNT(*) c FROM a_token_activations GROUP BY status`).all();
console.log('\n=== 站内记录按状态汇总 ===');
let recTotal = 0n;
for (const r of sums) {
    // 注意: SUM 可能溢出, 这里用逐行 BigInt 重算
    const rows = raw.prepare(`SELECT bnb_amount_wei FROM a_token_activations WHERE status=?`).all(r.status);
    let s = 0n; for (const x of rows) s += BigInt(x.bnb_amount_wei || '0');
    recTotal += s;
    console.log(`  ${r.status}: ${r.c} 笔, 合计 ${fmt(s)} BNB`);
}
console.log(`  全部记录合计 = ${fmt(recTotal)} BNB`);
const confirmedRows = raw.prepare(`SELECT bnb_amount_wei FROM a_token_activations WHERE status='confirmed'`).all();
let confSum = 0n; for (const x of confirmedRows) confSum += BigInt(x.bnb_amount_wei || '0');
console.log(`  其中 confirmed = ${fmt(confSum)} BNB`);
const minCreated = raw.prepare(`SELECT MIN(created_at) m FROM a_token_activations`).get().m;
console.log(`  最早记录时间 = ${new Date(Number(minCreated)).toLocaleString('zh-CN', { hour12: false })}`);

if (!anySent) {
    console.log(`\n  >>> 对账: 链上总流入 ${fmt(totalOnchain)} vs 站内全部记录 ${fmt(recTotal)} BNB`);
    console.log(`  >>> 差额(链上-站内) = ${fmt(totalOnchain - recTotal)} BNB ${totalOnchain > recTotal ? '(链上多于站内 → 可能存在漏单)' : '(站内>=链上 → 无漏单)'}`);
}

// ── B. pending/rejected 链上核验 ─────────────────────────────
console.log('\n=== B. pending/rejected 记录链上核验 ===');
const rows = raw.prepare(`SELECT id,wallet,plan,bnb_amount_wei,tx_hash,status,created_at FROM a_token_activations WHERE status IN ('pending','rejected') ORDER BY created_at ASC`).all();
console.log(`待核验 ${rows.length} 笔`);
const out = [];
for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const tx = String(r.tx_hash || '');
    const rec = { plan: r.plan, wallet: r.wallet, status: r.status, bnb: Number(BigInt(r.bnb_amount_wei || '0')) / 1e18,
        created: new Date(Number(r.created_at)).toLocaleString('zh-CN', { hour12: false }), tx: tx.slice(0, 12), noHash: tx.length < 10 };
    if (!rec.noHash) {
        const rcpt = await rpc('eth_getTransactionReceipt', [tx]);
        if (rcpt === undefined) rec.chain = 'RPC失败';
        else if (rcpt === null) rec.chain = '链上无此交易';
        else {
            rec.chain = rcpt.status === '0x1' ? '成功' : '失败';
            if (rcpt.status === '0x1') {
                const t2 = await rpc('eth_getTransactionByHash', [tx]);
                if (t2) {
                    const to = String(t2.to || '').toLowerCase();
                    rec.toOk = (to === MAIN || to === ROT);
                    rec.fromOk = String(t2.from || '').toLowerCase() === String(r.wallet || '').toLowerCase();
                    rec.amtOk = BigInt(t2.value || '0').toString() === (PLAN_AMT[String(r.plan)] || '?');
                    rec.valBnb = Number(BigInt(t2.value || '0')) / 1e18;
                }
            }
        }
    }
    out.push(rec);
    process.stdout.write(`\r核验 ${i + 1}/${rows.length}   `);
}
console.log('');
const suspects = out.filter(r => r.chain === '成功' && r.toOk && r.amtOk);
console.log('--- 逐条 ---');
for (let i = 0; i < out.length; i++) {
    const r = out[i];
    const flag = (r.chain === '成功' && r.toOk && r.amtOk) ? '   <<< 链上已成功付款(漏单候选)' : '';
    console.log(`${String(i + 1).padStart(2)} plan${r.plan} ${r.bnb} ${r.wallet} [${r.status}] ${r.created} tx=${r.tx}${r.noHash ? '(无hash)' : ''} chain=${r.chain} to=${r.toOk} from=${r.fromOk} amt=${r.amtOk} val=${r.valBnb ?? ''}${flag}`);
}
console.log('\nSUMMARY', JSON.stringify({ stuckTotal: out.length, chainSuccess: out.filter(r => r.chain === '成功').length, suspect: suspects.length }));
console.log('AUDIT_DONE');
process.exit(0);
