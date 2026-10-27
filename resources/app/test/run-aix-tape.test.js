// 奔跑吧 AIX 押注局防离线预算：种子不下发、随机带分段放出、已提交日志不可改写、时钟不可超前。
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeDatabase } from '../src/database.js';
import { createWalletService } from '../src/wallet-service.js';
import { createRunAixGameApi } from '../src/run-aix-game-api.js';
import { CampaignEngine } from '../public/games/run-aix/campaign-engine.js';
import { getLevel } from '../public/games/run-aix/campaign.js';
import { wagerPercent } from '../public/games/run-aix/wager.js';

const UNITS = 10n ** 18n;
const realNow = Date.now;
let fakeNow = realNow();
Date.now = () => fakeNow;

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-run-aix-test-'));
try {
  const walletService = createWalletService({ dataRoot: root, depositAddress: `0x${'d'.repeat(40)}`, networks: [] });
  const database = walletService.database;
  const balances = new Map();
  const aTokenService = {
    balanceA: wallet => balances.get(wallet) || 0n,
    creditA: (wallet, units) => balances.set(wallet, (balances.get(wallet) || 0n) + BigInt(units)),
    debitA: (wallet, units) => {
      const cur = balances.get(wallet) || 0n;
      if (cur < BigInt(units)) throw new Error('余额不足');
      balances.set(wallet, cur - BigInt(units));
    },
  };
  const wallet = `0x${'2'.repeat(40)}`;
  walletService.ensureUser(wallet);
  balances.set(wallet, 1000n * UNITS);

  const api = createRunAixGameApi({
    aTokenService, database,
    send: (res, status, body) => { res.status = status; res.body = body; return true; },
    readBody: async request => request.body,
    getSession: () => ({ address: wallet }),
  });
  const call = async (pathname, body) => {
    const res = {};
    await api.handle({ method: body ? 'POST' : 'GET', body }, res, pathname);
    return res;
  };

  // 1) 开局不再下发种子，只给承诺 + 第一段随机带
  const start = await call('/api/run-aix/start', { stakeA: '10', levelId: 'level-1' });
  assert.equal(start.status, 200, JSON.stringify(start.body));
  assert.equal(start.body.seed, undefined);
  assert.match(start.body.commitment, /^[0-9a-f]{64}$/);
  assert.equal(start.body.tape.length, api.TAPE_WINDOW);
  const runId = start.body.runId;

  // 2) 不跑就要不到更多：空提交 advance 不会放出窗口外的随机数
  const idle = await call('/api/run-aix/advance', { runId, from: 0, frames: [], have: start.body.tape.length });
  assert.equal(idle.status, 200);
  assert.equal(idle.body.tape.length, 0);

  // 3) 像屏幕阅读机器人一样实时游玩（只看已生成的障碍），按需 advance
  const tape = start.body.tape.slice();
  let used = 0;
  const engine = new CampaignEngine({
    level: getLevel('level-1'),
    random: () => { assert.ok(used < tape.length, '客户端用到了尚未放出的随机数'); return tape[used++] / 2 ** 32; },
  });
  engine.start();
  const frames = [];
  let committed = 0, advances = 0;
  const dt = 1 / 60;
  while (engine.state !== 'ended' && frames.length < 20000) {
    if (tape.length - used < 40) {
      fakeNow += 30; // 网络往返
      const res = await call('/api/run-aix/advance', { runId, from: committed, frames: frames.slice(committed), have: tape.length });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      committed = res.body.committed;
      res.body.tape.forEach((v, i) => { tape[res.body.tapeFrom + i] = v; });
      assert.ok(res.body.revealed <= used + api.TAPE_WINDOW + 8, '放出的随机带超过了已消耗位置 + 窗口');
      advances += 1;
    }
    const inputs = [];
    if (engine.state === 'running') {
      const nearest = lane => Math.min(Infinity, ...engine.obstacles.filter(o => !o.passed && o.lane === lane && o.ahead > -1.5).map(o => o.ahead));
      const here = nearest(engine.lane);
      const options = [engine.lane - 1, engine.lane + 1].filter(l => l >= 0 && l <= 2);
      const best = options.reduce((a, b) => (nearest(b) > nearest(a) ? b : a), options[0]);
      if (here < 60 && nearest(best) > here) { inputs.push(best > engine.lane ? 'm1' : 'm-1'); engine.move(best > engine.lane ? 1 : -1); }
    }
    frames.push([dt, inputs]);
    engine.update(dt);
    fakeNow += 17; // ≥ 1/60 秒，整数毫秒
  }
  assert.equal(engine.state, 'ended');
  assert.ok(advances > 0);

  // 4) 改写已提交的帧 → 拒绝
  if (committed > 0) {
    const forged = frames.map(f => [f[0], [...f[1]]]);
    forged[0] = [forged[0][0], ['m1']];
    const rewrite = await call('/api/run-aix/settle', { runId, from: 0, frames: forged, distance: engine.distance });
    assert.equal(rewrite.body.code, 'TRACE_REWRITE');
  }

  // 5) 正常结算：距离由服务端回放决定，揭示的 secret 与承诺一致
  const before = balances.get(wallet);
  const settle = await call('/api/run-aix/settle', { runId, from: 0, frames, distance: Math.floor(engine.distance) });
  assert.equal(settle.status, 200, JSON.stringify(settle.body));
  assert.equal(settle.body.distance, Math.floor(engine.distance));
  assert.equal(crypto.createHash('sha256').update(settle.body.serverSeed).digest('hex'), start.body.commitment);
  const expected = 10n * UNITS * BigInt(wagerPercent(settle.body.distance)) / 100n;
  assert.equal(settle.body.multiplier, wagerPercent(settle.body.distance) / 100, '返还倍率须与返还曲线一致');
  assert.ok(expected <= 10n * UNITS * 5n, '返还不得超过 5 倍上限');
  assert.equal(balances.get(wallet) - before, expected);
  const again = await call('/api/run-aix/settle', { runId, from: 0, frames, distance: Math.floor(engine.distance) });
  assert.equal(again.body.alreadySettled, true);
  assert.equal(balances.get(wallet) - before, expected, '重复结算不得重复入账');

  // 6) 时钟超前：日志声称跑了 20 秒，服务端只过了 1 秒 → 拒绝
  const run2 = await call('/api/run-aix/start', { stakeA: '1', levelId: 'daily' });
  assert.equal(run2.status, 200);
  fakeNow += 1000;
  const fast = Array.from({ length: 400 }, () => [0.05, []]);
  const ahead = await call('/api/run-aix/advance', { runId: run2.body.runId, from: 0, frames: fast, have: run2.body.tape.length });
  assert.equal(ahead.body.code, 'CLOCK_AHEAD');

  // 7) 两局 daily 不共享随机带（不再是全服同一条可外泄的航路）
  fakeNow += 31 * 60_000; // 让 run2 过期作废：按 0 米返还 0.3 倍
  const beforeExpire = balances.get(wallet);
  await call('/api/run-aix/state');
  assert.equal(balances.get(wallet) - beforeExpire, 3n * UNITS / 10n);
  const run3 = await call('/api/run-aix/start', { stakeA: '1', levelId: 'daily' });
  assert.equal(run3.status, 200, JSON.stringify(run3.body));
  assert.notDeepEqual(run3.body.tape, run2.body.tape);

  console.log(`run-aix tape tests passed: bot reached ${Math.floor(engine.distance)} m with ${advances} advances, payout ×${settle.body.multiplier}`);
} finally {
  Date.now = realNow;
  closeDatabase(root);
  fs.rmSync(root, { recursive: true, force: true });
}

// 返还曲线：开跑 0.3×、300 米保本 1.0×、之后每 30 米 +0.1×、1500 米封顶 5×
assert.equal(wagerPercent(0), 30);
assert.equal(wagerPercent(49), 30);
assert.equal(wagerPercent(50), 45);
assert.equal(wagerPercent(100), 60);
assert.equal(wagerPercent(300), 100);
assert.equal(wagerPercent(500), 160);
assert.equal(wagerPercent(1499), 490);
assert.equal(wagerPercent(1500), 500);
assert.equal(wagerPercent(99999), 500);
