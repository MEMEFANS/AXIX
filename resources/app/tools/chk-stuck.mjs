// 一次性核验：站内 status IN ('pending','rejected') 的激活记录，逐条比对链上真实状态。
// 目的：找出「链上已付款成功、但站内尚未确认/被驳回」的漏单。
// 用法：在 /opt/wg-platform 下 node scripts/chk-stuck.mjs
import { getConfig, DATA_ROOT } from '../src/config.js';
import { createWalletService } from '../src/wallet-service.js';

const MAIN = '0xa71e0cfb92643ccf1fadcd45fcfb29b7b39c56e6';
const ROT  = '0xf9767c67a7f82f5b488f73b69e73017f635d333c';
const RPCS = ['https://bsc-rpc.publicnode.com', 'https://bsc-dataseed.binance.org'];
const PLAN_AMT = { '1': (2n * 10n ** 15n).toString(), '2': (5n * 10n ** 16n).toString() };

const cfg = getConfig();
const walletService = createWalletService({ ...cfg.wallet, dataRoot: DATA_ROOT, withdrawalPrivateKey: cfg.wallet.withdrawalPrivateKey });
const db = walletService.database;
const raw = db.db;

function tblNames() { return raw.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name); }
const tname = tblNames().find(t => /activation/i.test(t));
if (!tname) { console.error('未找到激活表'); process.exit(1); }
console.log('表:', tname);
console.log('列:', raw.prepare(`PRAGMA table_info(${tname})`).all().map(c => c.name).join(','));

const rows = raw.prepare(`SELECT * FROM ${tname} WHERE status IN ('pending','rejected') ORDER BY createdAt ASC`).all();
console.log(`待核验记录数 (pending+rejected): ${rows.length}`);

let rpcIdx = 0;
async function rpc(method, params) {
  const url = RPCS[rpcIdx % RPCS.length];
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(15000),
      });
      const j = await res.json();
      if (j.error) { rpcIdx++; await new Promise(r => setTimeout(r, 200)); continue; }
      return j.result;
    } catch (e) { rpcIdx++; await new Promise(r => setTimeout(r, 400)); }
  }
  return undefined; // 无法获取
}

const out = [];
for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const tx = String(r.txHash || '');
    const rec = {
        i: i + 1, plan: r.plan, wallet: r.wallet, status: r.status,
        bnb: (Number(BigInt(r.bnbAmountWei || '0')) / 1e18),
        created: new Date(Number(r.createdAt)).toLocaleString('zh-CN', { hour12: false }),
        tx: tx.slice(0, 12),
        txMissing: !tx || tx.length < 10,
    };
    if (!rec.txMissing) {
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
                    const v = BigInt(t2.value || '0').toString();
                    const want = PLAN_AMT[String(r.plan)] || '?';
                    rec.amtOk = (v === want);
                    rec.valBnb = Number(BigInt(t2.value || '0')) / 1e18;
                    const bn = parseInt(t2.blockNumber, 16);
                    rec.block = bn;
                }
            }
        }
    }
    out.push(rec);
    process.stdout.write(`\r核验进度 ${i + 1}/${rows.length}   `);
}
console.log('');

// 汇总判定
const suspects = out.filter(r => r.chain === '成功' && (r.toOk || r.amtOk) && (r.txMissing === false));
console.log('\n=== 全部待核验记录 ===');
for (const r of out) {
    const flag = r.chain === '成功' && (r.toOk !== false) && (r.amtOk !== false) ? '  << 链上已付款成功(漏单候选)' : '';
    console.log(`${String(r.i).padStart(2)}  plan${r.plan} ${r.bnb}BNB ${r.wallet} [${r.status}] ${r.created} tx=${r.tx}${r.txMissing ? '(无hash)' : ''} chain=${r.chain} toMatch=${r.toOk} fromMatch=${r.fromOk} amtMatch=${r.amtOk} val=${r.valBnb ?? ''}${flag}`);
}
console.log('\nSUMMARY', JSON.stringify({ total: out.length, chainSuccess: out.filter(r => r.chain === '成功').length, suspect: suspects.length }));
console.log('CHK_DONE');
process.exit(0);
