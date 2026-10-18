// 团队分润规则测试（不连生产库，mock 依赖直接驱动 distributeMinerReward）
// 规则：直推15% + 间推10% + 逐层减法模型；同级链上拿0且不占空间，
//       平级奖改为按日结算（settleParityRewards：直推同级下级当日团队收益 team+level_diff 的10%），不在本文件覆盖
// 命名口径（2026-09-13）：产单人 A0 且下方无级别 → 拿满档位 = 团队奖(team)；下方已有级别拿过 → 级差(level_diff)
// 运行：node tools/test-team-split.mjs
import { createATokenTeamService } from '../src/a-token-team-service.js';

const UNIT = 10n ** 18n;
const toCoin = (units) => Number(units / UNIT) + (Number(units % UNIT) / Number(UNIT));

function makeMock(levels, links) {
  const rewards = [];
  const database = {
    listReferralLinks: () => links,
    getATokenTeamLevel: (addr) => ({ wallet: addr, level: levels[String(addr).toLowerCase()] ?? 0 }),
    insertATokenTeamRewardRow: (row) => { rewards.push(row); return { inserted: true }; },
    upsertATokenTeamLevelRow: () => {},
    listATokenStakes: () => [],
    listATokenMiners: () => [],
    listReferralLinksArchive: () => [],
    transaction: (fn) => fn(),
    db: { isTransaction: false, prepare: () => ({ all: () => [], get: () => undefined, run: () => {} }) },
  };
  const walletService = {
    creditBalance: () => {},
    balanceUnits: () => 0n,
    beginAtomicUpdate: () => ({ isDirty: () => false, exportState: () => ({}), finish: () => {}, rollback: () => {} }),
    replaceWalletStateInside: () => {},
  };
  const svc = createATokenTeamService({ database, walletService });
  return { svc, rewards };
}

// path: ['A0','A1','A3',...]，第 0 个是产单人，其后依次为直推/间推/...
function levelOf(tag) { const m = String(tag).match(/A(\d+)/); return m ? Number(m[1]) : 0; }

function runCase(name, path, expect, opts = {}) {
  const levels = {};
  path.forEach((tag) => { levels[tag.toLowerCase()] = levelOf(tag); });
  const links = [];
  for (let i = 0; i < path.length - 1; i++) links.push({ wallet: path[i], referrerWallet: path[i + 1] });
  // 生产库中每个注册用户都有自己的推荐行（最顶级 referrer 为空），链上最后一个上级也要有行才会入链
  links.push({ wallet: path[path.length - 1], referrerWallet: '' });
  const { svc, rewards } = makeMock(levels, links);
  const res = svc.distributeMinerReward(path[0], 100n * UNIT, `m_${name.replace(/\W/g, '')}`, 1790000000000);
  if (!res.distributed) { console.log(`FAIL  ${name} → 未分发: ${res.reason}`); allOk = false; return false; }
  // 归并展示：direct / indirect / team(团队奖) / diff(级差) / parity —— 按实际 kind 严格断言
  const clean = {};
  for (const r of rewards) {
    const who = r.recipientWallet;
    clean[who] ??= {};
    let k = r.kind.replace(/^miner_/, '');
    if (k === 'level_diff') k = 'diff';
    clean[who][k] = (clean[who][k] || 0) + toCoin(BigInt(r.amountUnits));
  }
  let ok = true;
  const lines = [];
  for (const [tag, expKinds] of Object.entries(expect)) {
    const addr = tag;
    const actual = clean[addr] || {};
    for (const [k, ev] of Object.entries(expKinds)) {
      const av = actual[k] ?? 0;
      const pass = Math.abs(av - ev) < 1e-9;
      if (!pass) ok = false;
      lines.push(`    ${tag}.${k}: 期望 ${ev} / 实际 ${av} ${pass ? 'OK' : '<< FAIL'}`);
    }
  }
  // 多出的实际发放也打出来
  for (const [who, kinds] of Object.entries(clean)) {
    for (const [k, v] of Object.entries(kinds)) {
      const expectedHere = expect[who] && expect[who][k] !== undefined;
      if (!expectedHere) { ok = false; lines.push(`    多出发放 ${who}.${k}: ${v} << FAIL`); }
    }
  }
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) { console.log('  实际发放：', JSON.stringify(clean)); console.log(lines.join('\n')); }
  else { for (const l of lines) console.log(l); }
  return ok;
}

const results = [];
let allOk = true;
function T(name, path, expect) { results.push(() => { allOk = runCase(name, path, expect) && allOk; }); }

// 1. 单直推 A1，产单人 A0：A1 = 直推15 + 团队奖10
T('用例1 A0→A1（直推A1拿团队奖）', ['A0', 'A1'], {
  A1: { direct: 15, team: 10 },
});

// 2. 全正序 A0→A1→A2→A9：A1=15+团队奖10，A2=间推10+级差10（A1已拿档位），A9=级差60
T('用例2 A0→A1→A2→A9（标准正序链）', ['A0', 'A1', 'A2', 'A9'], {
  A1: { direct: 15, team: 10 },
  A2: { indirect: 10, diff: 10 },
  A9: { diff: 60 },
});

// 3. 倒挂链 A0→A1→A3→A2→A5：A2 拿0不占空间，A5=50−(10+30)=10（A5伞下有级别→级差）
T('用例3 A0→A1→A3→A2→A5（倒挂不占空间）', ['A0', 'A1', 'A3', 'A2', 'A5'], {
  A1: { direct: 15, team: 10 },
  A3: { indirect: 10, diff: 20 },
  A2: {},
  A5: { diff: 10 },
});

// 4. 产单人有级别 A2，直推 A5：A5 = 15 + 级差30（有级别拿级差，不叫团队奖）
T('用例4 A2产单→A5（有级别产单=级差）', ['A2', 'A5'], {
  A5: { direct: 15, diff: 30 },
});

// 5. 产单人 A2，链 A2→A5→A9：A5=15+30，A9=间推10+(90−70)=20
T('用例5 A2→A5→A9（级差逐层扣减）', ['A2', 'A5', 'A9'], {
  A5: { direct: 15, diff: 30 },
  A9: { indirect: 10, diff: 20 },
});

// 6. 同级不占空间：A0→A2→A2b→A9：A2 团队奖20，A2b 同级链上拿0（平级改按日结算）且不占空间，A9 级差 90−20=70
T('用例6 A0→A2→A2→A9（同级拿0不占空间）', ['A0', 'A2', 'A2b', 'A9'], {
  A2: { direct: 15, team: 20 },
  A2b: { indirect: 10 },
  A9: { diff: 70 },
});

// 7. A0 中间层穿透：A0→A1→A0b→A9：A0b 档位0穿透（仍拿间推固定10），A9=90−10=80（A9伞下有A1→级差）
T('用例7 A0→A1→A0→A9（A0中间层穿透）', ['A0', 'A1', 'A0b', 'A9'], {
  A1: { direct: 15, team: 10 },
  A0b: { indirect: 10 },
  A9: { diff: 80 },
});

// 8. A10 截断：A0→A1→A10→A9：A10 拿间推固定10但不参与级差，级差链遇 A10 终止，A9 拿0
T('用例8 A0→A1→A10→A9（A10截断）', ['A0', 'A1', 'A10', 'A9'], {
  A1: { direct: 15, team: 10 },
  A10: { indirect: 10 },
  A9: {},
});

// 9. 长链 A0→A1→A2→A3→A4→A9：A2=级差10，A3 同级(30−30=0)拿0不占空间，A4=级差10，A9=级差20
T('用例9 A0→A1→A2→A3→A4→A9（长链）', ['A0', 'A1', 'A2', 'A3', 'A4', 'A9'], {
  A1: { direct: 15, team: 10 },
  A2: { indirect: 10, diff: 10 },
  A3: {},
  A4: { diff: 10 },
  A9: { diff: 20 },
});

// 10. 双倒挂：A0→A1→A3→A2→A2b→A9：A2、A2b 都拿0不占空间，A9=90−40=50（级差）
T('用例10 A0→A1→A3→A2→A2→A9（连续倒挂）', ['A0', 'A1', 'A3', 'A2', 'A2b', 'A9'], {
  A1: { direct: 15, team: 10 },
  A3: { indirect: 10, diff: 20 },
  A9: { diff: 50 },
});

// 11. 产单人级别高于直推上级：A5产单→A2→A9：A2 倒挂拿0（下级比自己高），A9=90−50=40
T('用例11 A5产单→A2→A9（产单人级别高于上级）', ['A5', 'A2', 'A9'], {
  A2: { direct: 15 },
  A9: { indirect: 10, diff: 40 },
});

// 12. 极端：全 A0 链只有直推：A0→A0b：A0b=直推15，无级差
T('用例12 A0→A0（无级别直推）', ['A0', 'A0b'], {
  A0b: { direct: 15 },
});

for (const t of results) t();
console.log(allOk ? '\n全部用例通过 ✓' : '\n存在失败用例 ✗');
process.exit(allOk ? 0 : 1);
