// 平级奖按日结算测试（2026-09-13 新口径）
// 规则：只给「直推且同级」的上级发 = 下级当日【团队奖+级差】(miner/stake_team + miner/stake_level_diff)
//       合计的 10%；不含直推15%/间推10%/平级奖本身；每个北京日槽每对上下级一条，同日只补差不重发。
// 内存表 mock，端到端：distributeMinerReward/手工插桩团队收益 → settleParityRewards
// 运行：node tools/test-parity-split.mjs
import { createATokenTeamService } from '../src/a-token-team-service.js';

const UNIT = 10n ** 18n;
const coin = (units) => Number(BigInt(units)) / Number(UNIT);
const k = (s) => String(s || '').toLowerCase();
const DAY1 = Date.parse('2026-09-24T12:00:00+08:00');
const DAY2 = Date.parse('2026-09-25T12:00:00+08:00');

function makeMock(levels, links) {
  const rows = [];                                   // a_token_team_rewards 内存表
  const balance = new Map();                         // key `${wallet}|A` → bigint
  const credited = [];                               // 每次入账流水
  const database = {
    listReferralLinks: () => links,
    getATokenTeamLevel: (addr) => ({ wallet: addr, level: levels[k(addr)] ?? 0 }),
    upsertATokenTeamLevelRow: () => {},
    insertATokenTeamRewardRow: (row) => {
      if (rows.some((r) => r.id === row.id)) return { inserted: false };
      rows.push({
        id: row.id, recipient_wallet: row.recipientWallet, source_wallet: row.sourceWallet,
        kind: row.kind, amount_units: row.amountUnits, created_at: row.createdAt, payload_json: null,
      });
      return { inserted: true };
    },
    listATokenStakes: () => [], listATokenMiners: () => [], listReferralLinksArchive: () => [],
    transaction: (fn) => fn(),
    db: {
      isTransaction: false,
      prepare(sql) {
        // ① 产出分发幂等检查
        if (sql.includes('SELECT id FROM a_token_team_rewards')) {
          return { all: (addr) => rows.filter((r) => k(r.source_wallet) === k(addr)).map((r) => ({ id: r.id })) };
        }
        // ② 平级奖：取当日 team/level_diff 行
        if (sql.includes('recipient_wallet AS w')) {
          return {
            all: (from, to) => rows
              .filter((r) => ['miner_team', 'stake_team', 'miner_level_diff', 'stake_level_diff'].includes(r.kind))
              .filter((r) => r.created_at >= from && r.created_at < to)
              .map((r) => ({ w: r.recipient_wallet, a: r.amount_units })),
          };
        }
        // ③ 查已有平级奖记录
        if (sql.includes('SELECT amount_units FROM a_token_team_rewards WHERE id=?')) {
          return { get: (id) => { const r = rows.find((x) => x.id === id); return r ? { amount_units: r.amount_units } : undefined; } };
        }
        // ④ 同日补差更新
        if (sql.startsWith('UPDATE a_token_team_rewards')) {
          return { run: (amount, payload, id) => { const r = rows.find((x) => x.id === id); if (r) { r.amount_units = amount; r.payload_json = payload; } } };
        }
        throw new Error('unexpected SQL in mock: ' + sql.slice(0, 60));
      },
    },
  };
  const walletService = {
    creditBalance: (w, coinName, amount) => {
      const key = `${k(w)}|${coinName}`;
      balance.set(key, (balance.get(key) || 0n) + BigInt(amount));
      credited.push({ w: k(w), amount: BigInt(amount) });
    },
    balanceUnits: (w, coinName) => balance.get(`${k(w)}|${coinName}`) || 0n,
    beginAtomicUpdate: () => ({ isDirty: () => false, exportState: () => ({}), finish: () => {}, rollback: () => {} }),
    replaceWalletStateInside: () => {},
  };
  const svc = createATokenTeamService({ database, walletService });
  return { svc, rows, database, balance, credited };
}

// 手工插一笔团队收益（team/level_diff），kind 默认 miner_team
function seed(db, id, to, amountA, kind = 'miner_team', at = DAY1) {
  databaseInsert(db, { id, recipientWallet: to, sourceWallet: 'seed', kind, amountUnits: (BigInt(amountA) * UNIT).toString(), createdAt: at });
}
function databaseInsert(db, row) {
  db.insertATokenTeamRewardRow({ periodEndAt: row.createdAt, ...row });
}

let allOk = true;
function check(name, cond, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + detail}`);
  if (!cond) allOk = false;
}
const parityOf = (rows) => rows.filter((r) => r.kind === 'parity');
const balA = (m, w) => coin(m.get(`${k(w)}|A`) || 0n);

// 推荐链：[产单人, 直推, 间推, ...]
function chain(path) {
  const links = path.map((p, i) => ({ wallet: p.w, referrerWallet: i + 1 < path.length ? path[i + 1].w : '' }));
  const levels = {}; path.forEach((p) => { levels[p.w] = p.l; });
  return { links, levels };
}

/* ── P1 直推同级：A0产 → A9(C) → A9(U)。C 拿直推15+团队奖90，链上对 U 同级不发；日结 U 拿 C 团队收益90的10%=9 ── */
{
  const { links, levels } = chain([{ w: 'p', l: 0 }, { w: 'c', l: 9 }, { w: 'u', l: 9 }]);
  const { svc, rows, balance } = makeMock(levels, links);
  svc.distributeMinerReward('p', 100n * UNIT, 'm1', DAY1);
  const before = balA(balance, 'u');
  const r = svc.settleParityRewards(DAY1);
  const ps = parityOf(rows);
  check('P1 直推同级 A9←A9：1条×90×10%=9',
    r.settled && r.count === 1 && ps.length === 1 &&
    coin(ps[0].amount_units) === 9 && ps[0].recipient_wallet === 'u' && ps[0].source_wallet === 'c' &&
    balA(balance, 'u') - before === 9,
    JSON.stringify(r) + ' / ' + JSON.stringify(ps.map((x) => [x.recipient_wallet, coin(x.amount_units)])));
}

/* ── P2 基数只含团队奖+级差：C 的直推15 不计入（与 P1 同链，显式断言 C 收入25但平级只按90算）── */
{
  const { links, levels } = chain([{ w: 'p', l: 0 }, { w: 'c', l: 9 }, { w: 'u', l: 9 }]);
  const { svc, rows } = makeMock(levels, links);
  svc.distributeMinerReward('p', 100n * UNIT, 'm1', DAY1);
  svc.settleParityRewards(DAY1);
  // C 当日：direct15 + team90；若错误地按 105 算会是 10.5
  const got = coin(parityOf(rows)[0].amount_units);
  check('P2 直推15%/间推10% 不进平级基数（90→9，不是105→10.5）', got === 9, `实际 ${got}`);
}

/* ── P3 直推但不同级不给：A0产→A5(C)→A9(U)。C 团队奖50、U 级差40，级别不同 → 无平级 ── */
{
  const { links, levels } = chain([{ w: 'p', l: 0 }, { w: 'c', l: 5 }, { w: 'u', l: 9 }]);
  const { svc, rows } = makeMock(levels, links);
  svc.distributeMinerReward('p', 100n * UNIT, 'm1', DAY1);
  const r = svc.settleParityRewards(DAY1);
  check('P3 直推但不同级（A5→A9）不发平级', !r.settled && parityOf(rows).length === 0, JSON.stringify(r));
}

/* ── P4 隔级（间推）同级不给：A0产→A9(C)→A0(M)→A9(U)。U 与 C 同级但中间隔人，不能拿伞下 ── */
{
  const { links, levels } = chain([{ w: 'p', l: 0 }, { w: 'c', l: 9 }, { w: 'm', l: 0 }, { w: 'u', l: 9 }]);
  const { svc, rows } = makeMock(levels, links);
  svc.distributeMinerReward('p', 100n * UNIT, 'm1', DAY1);
  const r = svc.settleParityRewards(DAY1);
  check('P4 隔级同级（伞下）不发，只有直推同级才算', !r.settled && parityOf(rows).length === 0, JSON.stringify(r));
}

/* ── P5 下级无级别不参与（防御脏数据：A0 名下出现 team 行也不发）── */
{
  const { links, levels } = chain([{ w: 'c', l: 0 }, { w: 'u', l: 1 }]);
  const { svc, database, rows } = makeMock(levels, links);
  seed(database, 't1', 'c', 100, 'miner_team', DAY1);
  const r = svc.settleParityRewards(DAY1);
  check('P5 无级别下级（A0）不参与平级', !r.settled && parityOf(rows).length === 0, JSON.stringify(r));
}

/* ── P6 A10 不参与（防御：A10 名下出现 level_diff 也不发）── */
{
  const { links, levels } = chain([{ w: 'c', l: 10 }, { w: 'u', l: 10 }]);
  const { svc, database, rows } = makeMock(levels, links);
  seed(database, 't1', 'c', 100, 'miner_level_diff', DAY1);
  const r = svc.settleParityRewards(DAY1);
  check('P6 A10 不参与平级', !r.settled && parityOf(rows).length === 0, JSON.stringify(r));
}

/* ── P7 一个上级多个同级直推下级，分别结算：U(A5)←C1(A5,100)、C2(A5,200) → 10+20=30，两条 ── */
{
  const { links, levels } = chain([{ w: 'c1', l: 5 }, { w: 'u', l: 5 }]);
  links.push({ wallet: 'c2', referrerWallet: 'u' }); levels.c2 = 5;
  const { svc, database, rows, balance } = makeMock(levels, links);
  seed(database, 't1', 'c1', 100, 'miner_team', DAY1);
  seed(database, 't2', 'c2', 200, 'stake_team', DAY1);
  const before = balA(balance, 'u');
  const r = svc.settleParityRewards(DAY1);
  const ps = parityOf(rows);
  check('P7 多个同级直推下级分别结算（100→10 + 200→20 = 30，2条）',
    r.settled && r.count === 2 && ps.length === 2 && balA(balance, 'u') - before === 30,
    JSON.stringify(r) + ' / 到账 ' + (balA(balance, 'u') - before));
}

/* ── P8 同日幂等：再结一次不重发（条数/余额不变）── */
{
  const { links, levels } = chain([{ w: 'c', l: 5 }, { w: 'u', l: 5 }]);
  const { svc, database, rows, balance } = makeMock(levels, links);
  seed(database, 't1', 'c', 100, 'miner_team', DAY1);
  svc.settleParityRewards(DAY1);
  const rows1 = parityOf(rows).length, bal1 = balA(balance, 'u');
  const r2 = svc.settleParityRewards(DAY1);
  check('P8 同日重复结算不重发（仍1条、仍10）',
    !r2.settled && parityOf(rows).length === rows1 && balA(balance, 'u') === bal1 && bal1 === 10,
    JSON.stringify(r2));
}

/* ── P9 同日补差只补不扣：基数 100→200，平级 10→20，补差10，仍只1条 ── */
{
  const { links, levels } = chain([{ w: 'c', l: 5 }, { w: 'u', l: 5 }]);
  const { svc, database, rows, balance } = makeMock(levels, links);
  seed(database, 't1', 'c', 100, 'miner_team', DAY1);
  svc.settleParityRewards(DAY1);
  seed(database, 't2', 'c', 100, 'miner_team', DAY1);   // 同日团队收益增长
  const before = balA(balance, 'u');
  const r = svc.settleParityRewards(DAY1);
  const ps = parityOf(rows);
  check('P9 同日增长只补差（10→20，补10，1条）',
    r.settled && r.count === 1 && ps.length === 1 && coin(ps[0].amount_units) === 20 &&
    balA(balance, 'u') - before === 10,
    JSON.stringify(r) + ' / 补差 ' + (balA(balance, 'u') - before));
}

/* ── P10 矿机+质押团队收益合并基数：miner_team60 + stake_level_diff40 = 100 → 10 ── */
{
  const { links, levels } = chain([{ w: 'c', l: 5 }, { w: 'u', l: 5 }]);
  const { svc, database, rows } = makeMock(levels, links);
  seed(database, 't1', 'c', 60, 'miner_team', DAY1);
  seed(database, 't2', 'c', 40, 'stake_level_diff', DAY1);
  const r = svc.settleParityRewards(DAY1);
  const got = coin(parityOf(rows)[0]?.amount_units || 0n);
  check('P10 矿机团队奖+质押级差合并为基数（60+40→10）', r.settled && got === 10, `实际 ${got} / ${JSON.stringify(r)}`);
}

/* ── P11 不同北京日槽各自一条：DAY1 10、DAY2 10，共2条，日槽不同 ── */
{
  const { links, levels } = chain([{ w: 'c', l: 5 }, { w: 'u', l: 5 }]);
  const { svc, database, rows, balance } = makeMock(levels, links);
  seed(database, 'd1', 'c', 100, 'miner_team', DAY1);
  svc.settleParityRewards(DAY1);
  seed(database, 'd2', 'c', 100, 'miner_team', DAY2);
  svc.settleParityRewards(DAY2);
  const ps = parityOf(rows);
  const slots = new Set(ps.map((r) => r.id.split('_')[1]));
  check('P11 跨日各一条（2条、日槽不同、合计20）',
    ps.length === 2 && slots.size === 2 && balA(balance, 'u') === 20,
    JSON.stringify(ps.map((r) => r.id)));
}

/* ── P12 平级奖本身不进基数（防连环放大）：C 有 team100 + 收到 parity50，不补差仍按100算 ── */
{
  const { links, levels } = chain([{ w: 'c', l: 5 }, { w: 'u', l: 5 }]);
  const { svc, database, rows } = makeMock(levels, links);
  seed(database, 't1', 'c', 100, 'miner_team', DAY1);
  svc.settleParityRewards(DAY1);
  // 模拟 C 自己从别处收到一笔平级奖 50（不该再被 U 抽10%）
  databaseInsert(database, { id: 'parity_other', recipientWallet: 'c', sourceWallet: 'x', kind: 'parity', amountUnits: (50n * UNIT).toString(), createdAt: DAY1 });
  const r2 = svc.settleParityRewards(DAY1);
  const got = coin(parityOf(rows).find((r) => r.source_wallet === 'c').amount_units);
  check('P12 平级奖不进平级基数，不连环放大（仍10，不补）', !r2.settled && got === 10, `实际 ${got} / ${JSON.stringify(r2)}`);
}

console.log(allOk ? '\n平级奖 12 个组合用例全部通过 ✓' : '\n存在失败用例 ✗');
process.exit(allOk ? 0 : 1);
