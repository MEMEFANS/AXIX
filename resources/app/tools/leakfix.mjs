// 漏单补发：对最近 24h 扫描出的「链上已付款、站内无记录」记录补写 pending 激活行
// 用法（只读核对）：cd /opt/wg-platform && node scripts/leakfix.mjs
// 用法（真正补写）：cd /opt/wg-platform && node scripts/leakfix.mjs apply
import { getConfig, DATA_ROOT } from '../src/config.js';
import { createWalletService } from '../src/wallet-service.js';
import { createATokenService } from '../src/a-token-service.js';
import { createATokenTeamService } from '../src/a-token-team-service.js';
import { createATokenMinerService } from '../src/a-token-miner-service.js';
import { createReferralService } from '../src/referral-service.js';
import { createLotteryService } from '../src/lottery-service.js';

const MAIN = '0xa71e0cfb92643ccf1fadcd45fcfb29b7b39c56e6';
const APPLY = process.argv[2] === 'apply';
const VERIFY = process.argv[2] === 'verify';

const RPC_LIST = [
    'https://bsc-rpc.publicnode.com',
    'https://bsc-dataseed.binance.org',
    'https://bsc-dataseed1.defibit.io',
    'https://1rpc.io/bnb',
];
async function rpc(method, params) {
    let lastErr;
    for (const url of RPC_LIST) {
        try {
            const r = await fetch(url, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
            });
            const j = await r.json();
            if (j.error) throw new Error(j.error.message);
            return j.result;
        } catch (e) { lastErr = e; }
    }
    throw lastErr;
}
async function chainTx(txHash) {
    const t = await rpc('eth_getTransactionByHash', [txHash]);
    if (!t) return null;
    return {
        from: (t.from || '').toLowerCase(),
        to: (t.to || '').toLowerCase(),
        value: BigInt(t.value).toString(),
        block: parseInt(t.blockNumber, 16),
    };
}

// 2026-10-13 15:03 ~ 10-14 15:02 (24h) 链上已付款但 DB 无记录
const ITEMS = [
    { plan: '1', wallet: '0xce8b685870b305e49936b45e2ff634b91fe84dcb', value: '0.002', ts: '2026-10-13T16:35:10+08:00', tx: '0x8938624f79cac1d71c0c1969d7d9ce7cf4beac1e883122bd05b8de4bbc553a26', blk: 127371697 },
    { plan: '1', wallet: '0x892999253afae98fce5922a9bb15be83b6028fb2', value: '0.002', ts: '2026-10-13T20:48:11+08:00', tx: '0x943d128bcf3130cff5e3d14bb2b60fe879944f2a52ee7e174b5800f03286a291', blk: 127405389 },
    { plan: '1', wallet: '0xea619c65ba7364942e0b578805bca2fb4ed24afc', value: '0.002', ts: '2026-10-13T21:55:11+08:00', tx: '0x4f4c65c6a88a16645c4d287e05e798ad7398993d3623e2997858158c619a334e', blk: 127414321 },
    { plan: '2', wallet: '0xea619c65ba7364942e0b578805bca2fb4ed24afc', value: '0.05', ts: '2026-10-13T21:55:33+08:00', tx: '0xd76fb755a5d9417c5ac2869da13c5bb2a1b476077e9ff95a95e30cd10d44d86b', blk: 127414370 },
    { plan: '1', wallet: '0x5db39dffb5fb433c08e12b6b6169abee1648c5cc', value: '0.002', ts: '2026-10-13T22:39:37+08:00', tx: '0xd10f07a16b208ac8e19aee444f2ae9ba81e86ed031df856b92d8472b06d3ca22', blk: 127420243 },
    { plan: '1', wallet: '0xaf188184ff71b8f10c938e73d789b05cc259e36f', value: '0.002', ts: '2026-10-13T22:39:52+08:00', tx: '0x689c73fe8f8f598f4c9b44297cd81d2c87a2a61bb808c68754f0312f5ccf8090', blk: 127420277 },
    { plan: '1', wallet: '0xd9883ad234c9e835ce36a38efead0848f596de11', value: '0.002', ts: '2026-10-13T22:45:07+08:00', tx: '0xcea4c0337fa89bf8e646e1963d3f4086083ecfb61ba38dce034e02727f4ce5c0', blk: 127420976 },
    { plan: '1', wallet: '0x1e5259a2e11f9400fb8a5fb6ca2db3f97d97fbea', value: '0.002', ts: '2026-10-14T13:44:33+08:00', tx: '0xce420838b74db6f52f2c68a8d5cb1aeb81ee8fb8bf598e7684223e9cb0ac6680', blk: 127540871 },
    { plan: '1', wallet: '0x26fb89246c1f9977ed8d66dd463c6af071d87af1', value: '0.002', ts: '2026-10-14T13:45:13+08:00', tx: '0x067025e30e8a9f8a2d1e3499830a6cb36bf2aa954bdcc0896f0bd09dbec32189', blk: 127540959 },
    { plan: '1', wallet: '0xa03e55277f2798f96546124880f31dbd9db0208c', value: '0.002', ts: '2026-10-14T13:47:14+08:00', tx: '0xa3e2ce0729dfc39416d90350286f3f998675fe67929e2859f93c5fc1a70bba6e', blk: 127541228 },
    { plan: '1', wallet: '0xdb1174843fee926e88c38c6598e381bf8d28aa71', value: '0.002', ts: '2026-10-14T13:48:30+08:00', tx: '0x0254d07e38f5fb78ad9557190e783946ea7ec137d36a4b4e6bb508cca814f266', blk: 127541397 },
];

const cfg = getConfig();
const walletService = createWalletService({ ...cfg.wallet, dataRoot: DATA_ROOT, withdrawalPrivateKey: cfg.wallet.withdrawalPrivateKey });
const db = walletService.database;

const PLAN_META = { '1': { minerPlan: 'mini120', wei: (2n * 10n ** 15n).toString() }, '2': { minerPlan: 'pro1500', wei: (5n * 10n ** 16n).toString() } };

const FIXED = ['0x5db39dffb5fb433c08e12b6b6169abee1648c5cc', '0xaf188184ff71b8f10c938e73d789b05cc259e36f', '0xd9883ad234c9e835ce36a38efead0848f596de11'];

if (VERIFY) {
    const aTokenService = createATokenService({ database: db, walletService });
    const teamService = createATokenTeamService({ database: db, walletService });
    const minerService = createATokenMinerService({ aTokenService, database: db, teamService });
    const referralService = createReferralService({ database: db, walletService });
    const lotteryService = createLotteryService({ database: db, walletService, referralService });
    console.log('=== 补单结果核验 ===');
    for (const w of FIXED) {
        const acts = (db.listATokenActivationsByWallet(w) || []).map(a => ({ status: a.status, bnb: a.bnbAmountWei, tx: a.txHash, blk: a.blockNumber, created: a.createdAt ? new Date(a.createdAt).toISOString() : '?' }));
        const miners = (db.listATokenMiners(w) || []).map(m => ({ plan: m.plan, status: m.status, exp: m.expiresAt ? new Date(m.expiresAt).toISOString() : '?' }));
        const pts = lotteryService.getPoints(w);
        const flows = (lotteryService.listFlows(w, 10) || []).map(f => ({ type: f.type, change: f.change, refId: f.refId, at: f.createdAt ? new Date(f.createdAt).toISOString() : '?' }));
        console.log(`\n${w}\n  激活: ${JSON.stringify(acts)}\n  矿机: ${JSON.stringify(miners)}\n  积分: ${pts}\n  流水: ${JSON.stringify(flows)}`);
    }
    console.log('VERIFY_DONE');
    process.exit(0);
}

console.log(`模式: ${APPLY ? 'APPLY(写入)' : 'CHECK(只读)'}  共 ${ITEMS.length} 条`);

let written = 0, skipped = 0;
for (const it of ITEMS) {
    const w = it.wallet;
    const wl = w.toLowerCase();
    const meta = PLAN_META[it.plan];
    const txExists = db.getATokenActivationByTx(it.tx);
    const cnt = db.countATokenActivationsByWalletPlan(w, it.plan);
    const miners = db.listATokenMiners(w).filter(m => m.plan === meta.minerPlan);
    console.log(`\n${it.ts} plan${it.plan} ${it.value} ${w}`);
    console.log(`   tx=${it.tx}  已存在同tx记录=${!!txExists}  该钱包plan${it.plan}记录数=${cnt}  已有${meta.minerPlan}矿机=${miners.length}(${miners.map(m => m.status).join(',')})`);
    if (cnt > 0 && !APPLY) {
        const own = db.listATokenActivationsByWallet(w).filter(a => String(a.plan) === String(it.plan));
        for (const a of own) {
            const d = a.createdAt ? new Date(a.createdAt).toISOString() : '?';
            console.log(`     已有记录: status=${a.status} bnb=${a.bnbAmountWei} tx=${a.txHash} blk=${a.blockNumber} createdAt=${d} wal=${a.wallet}`);
        }
    }
    if (txExists) { console.log('   -> 跳过（记录已存在）'); skipped++; continue; }
    if (cnt > 0) { console.log('   -> 跳过（该钱包已有该套餐记录，可能是重复付款）'); skipped++; continue; }

    // 链上核验：from 必须是该钱包本人，to 必须是收款地址，value 必须等于套餐金额
    let ok = true;
    try {
        const c = await chainTx(it.tx);
        if (!c) { console.log('   !! 链上查不到该交易'); ok = false; }
        else {
            const fromOk = c.from === wl;
            const valOk = c.value === meta.wei;
            console.log(`   链上: from=${c.from} to=${c.to} value=${c.value} blk=${c.block}  from匹配=${fromOk} 金额匹配=${valOk}`);
            if (!(fromOk && valOk)) { ok = false; console.log('   !! 链上核验不通过，放弃补写'); }
            else if (c.to !== MAIN) { console.log(`   .. 收款地址为轮换地址 ${c.to}（非主地址）`); }
        }
    } catch (e) { ok = false; console.log('   !! 链上核验失败:', e.message); }
    if (!ok) { skipped++; continue; }

    if (!APPLY) { console.log('   -> 待补写'); continue; }
    const now = Date.now();
    const record = {
        id: `ata_${it.plan}_${now}_${wl.slice(2, 10)}`,
        wallet: w, plan: it.plan,
        bnbAmountWei: meta.wei,
        txHash: it.tx, blockNumber: it.blk,
        status: 'pending', confirmedAt: null,
        createdAt: Date.parse(it.ts),
        payload: {
            plan: it.plan, bnb: it.value, minerPlan: meta.minerPlan, wallet: w,
            collectionAddress: MAIN,
            manualFix: `20261014 链上漏单补单: ${it.value} BNB -> 主收款地址, 链上成功, 站内从未提交`,
        },
    };
    db.upsertATokenActivationRow(record);
    console.log(`   -> 已写入 pending: ${record.id}`);
    written++;
}
console.log(`\nSUMMARY ${JSON.stringify({ mode: APPLY ? 'apply' : 'check', total: ITEMS.length, written, skipped })}`);
console.log('LEAKFIX_DONE');
process.exit(0);
