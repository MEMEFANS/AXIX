// 奔跑吧 AIX 押注经济 API /api/run-aix/*（需钱包 session）。
// 规则（2026-10-27 定稿）：
//   · 自选押注：每局开跑扣 0.1–500 AIX，按跑到的距离返还（死亡不吞本金）；
//   · 按距离阶梯结算（games/run-aix/wager.js，与 HUD 同源）——
//     开跑即返 0.3 倍，300m 保本 1.0 倍，之后每 30m +0.1 倍，1500m 通关 5.0 倍；
//   · 流水 1% → AIX 可卖额度：开跑即按押注的 1% 累计（向下取整），
//     写入平台既有 a_token_sell_quotas（只有这部分 AIX 能挂卖）；
//   · 必须登录：所有接口都要钱包 session。
// 防作弊（2026-10-27 修订：种子不再下发）：
//   · 每局服务端生成秘密 secret，只公布 SHA-256 承诺；引擎的随机数取自
//     "随机带" tape[i] = SHA256(secret:i) 前 32 位，按需分段下发；
//   · 客户端只能拿到「已实际消耗位置 + TAPE_WINDOW」以内的随机数：要拿下一段，
//     必须先提交到当前为止的逐帧输入日志（advance），服务端回放确认真的跑到了这里；
//     已提交的日志不可改写，所以无法离线预算整条航路、也无法回退重选；
//   · 日志累计时长不得超过服务端实际经过的时间（防加速/快进刷随机带）；
//   · 结算时服务端用同一引擎 + 同一随机带回放全程，以回放距离（而非客户端口供）结算，
//     并揭示 secret 供玩家核对承诺。
import crypto from 'node:crypto';
import { parseUnits, formatUnits } from 'ethers';
import { CampaignEngine } from '../public/games/run-aix/campaign-engine.js';
import { getLevel } from '../public/games/run-aix/campaign.js';
import { WAGER, wagerPercent } from '../public/games/run-aix/wager.js';

const A_TOKEN_DECIMALS = 18;
const UNITS = 10n ** BigInt(A_TOKEN_DECIMALS);
const MIN_STAKE_UNITS = UNITS / 10n;          // 0.1 AIX
const MAX_STAKE_UNITS = 500n * UNITS;         // 500 AIX
const QUOTA_BPS = 100n;                       // 1% 流水 → 可卖额度（万分比 100）
const MAX_DISTANCE = WAGER.maxDistance;
const RUN_TTL_MS = 30 * 60_000;               // pending 局 30 分钟未结算自动作废
const RECENT_LIMIT = 20;
const LEVEL_IDS = ['level-1', 'daily'];
// 回放输入日志上限：150s × 240Hz ≈ 36000 帧，留余量；
// 单帧输入 ≤4 条，超出即视为伪造。
const TRACE_MAX_FRAMES = 40000;
const TRACE_MAX_INPUTS_PER_FRAME = 4;
const DISTANCE_TOLERANCE = 1; // 米；回放与口供的容差（浮点/帧边界）
// 随机带：每排障碍约消耗 4–6 个随机数（150 m/s、22 m 行距 ≈ 每秒 6.8 排）。
// 窗口 64 ≈ 领先 10 排 / 1.5 秒，足够覆盖网络往返；全程约 400 个，上限留 10 倍余量。
const TAPE_WINDOW = 64;
const TAPE_MAX = 4096;
const SECRET_BYTES = 32;
const CLOCK_SLACK_S = 1.5; // 日志时长相对服务端真实经过时间的容差（秒）

const fmtA = units => { try { return formatUnits(BigInt(units || '0'), A_TOKEN_DECIMALS); } catch { return '0'; } };
const parseA = value => {
  const text = String(value ?? '').trim();
  if (!/^\d+(\.\d{1,18})?$/.test(text)) throw new Error('押注金额格式不正确');
  const units = parseUnits(text, A_TOKEN_DECIMALS);
  if (units <= 0n) throw new Error('押注金额必须大于 0');
  return units;
};
const nowIso = () => new Date().toISOString();
const sha256 = text => crypto.createHash('sha256').update(String(text)).digest('hex');
const chinaDay = (date = Date.now()) => new Date(date + 8 * 3600000).toISOString().slice(0, 10);

// 随机带第 i 个值（uint32）；客户端按 value / 2^32 还原为 [0,1) 浮点，与回放完全一致
const tapeValue = (secret, index) => Number.parseInt(sha256(`${secret}:${index}`).slice(0, 8), 16);
const tapeSlice = (secret, from, to) => Array.from({ length: Math.max(0, to - from) }, (_, i) => tapeValue(secret, from + i));

const multiplierFor = distance => wagerPercent(distance) / 100;
// 百分比为整数：乘后整除，无精度损失（尾差向下取整）
const payoutUnitsFor = (stakeUnits, distance) => stakeUnits * BigInt(wagerPercent(distance)) / 100n;

// —— 输入日志解析：帧 = [dt 秒(原始浮点), ['m1'|'m-1'|'p'|'r', ...]]；增量提交允许空数组 ——
function parseTrace(raw) {
  if (!Array.isArray(raw) || raw.length > TRACE_MAX_FRAMES) throw new Error('输入日志格式不正确');
  return raw.map(frame => {
    if (!Array.isArray(frame) || frame.length !== 2) throw new Error('输入日志格式不正确');
    const [d, inputs] = frame;
    if (typeof d !== 'number' || !Number.isFinite(d) || d <= 0 || d > 5) throw new Error('输入日志帧时长异常');
    if (!Array.isArray(inputs) || inputs.length > TRACE_MAX_INPUTS_PER_FRAME) throw new Error('输入日志输入数异常');
    for (const item of inputs) {
      if (!['p', 'r', 'm1', 'm-1'].includes(item)) throw new Error('输入日志含未知指令');
    }
    return [d, [...inputs]];
  });
}

const sameFrame = (a, b) => a[0] === b[0] && a[1].length === b[1].length && a[1].every((item, i) => item === b[1][i]);

function levelFor(levelId) {
  const base = getLevel('level-1');
  if (!base) throw new Error('关卡配置缺失');
  return levelId === 'daily' ? { ...base, id: 'daily', title: '每日远征', subtitle: chinaDay(), world: 0 } : base;
}

// 离线回放：同一引擎 + 同一随机带 + 同一帧序列。返回结束时的引擎与已消耗的随机数个数。
function replayRun(levelId, secret, trace) {
  let used = 0;
  const random = () => {
    if (used >= TAPE_MAX) throw new Error('随机带越界');
    return tapeValue(secret, used++) / 2 ** 32;
  };
  const engine = new CampaignEngine({ level: levelFor(levelId), random });
  if (!engine.start()) throw new Error('回放启动失败');
  for (const [d, inputs] of trace) {
    for (const item of inputs) {
      if (item === 'p') engine.pause();
      else if (item === 'r') engine.resume();
      else if (item === 'm1') engine.move(1);
      else if (item === 'm-1') engine.move(-1);
    }
    engine.update(d);
    if (engine.state === 'ended') break;
  }
  return { engine, used };
}

export function createRunAixGameApi({ aTokenService, database, send, readBody, getSession, withAccountLock = (addr, op) => op() }) {
  const db = database;

  function apiError(message, code = 'RUN_AIX_ERROR', statusCode = 400) {
    return Object.assign(new Error(message), { code, statusCode });
  }
  function requireSession(request) {
    const session = getSession(request);
    if (!session) throw apiError('请先登录钱包', 'SESSION_REQUIRED', 401);
    return session;
  }
  function sendError(res, error) {
    send(res, Number(error?.statusCode) || 400, { error: error?.message || String(error), code: error?.code || 'RUN_AIX_ERROR' });
  }
  const presentRun = run => run && ({
    runId: run.id, stakeA: fmtA(run.stakeUnits), status: run.status, distance: run.distance,
    payoutA: fmtA(run.payoutUnits), quotaA: fmtA(run.quotaUnits),
    startedAt: run.startedAt, settledAt: run.settledAt,
  });

  // 超时作废按 0 米结算：返还保底（与开跑即撞等同），页面崩溃不会比正常失败亏得更多
  function expireRun(run) {
    const payout = payoutUnitsFor(BigInt(run.stakeUnits), 0);
    const changed = db.settleRunAixRun(run.id, { status: 'expired', distance: 0, payoutUnits: payout.toString(), settledAt: Date.now() });
    if (changed && payout > 0n) aTokenService.creditA(run.wallet, payout);
  }

  // 过期 pending 局就地作废（返还保底）。返回作废后的最新 pending（应为 null）。
  function expireStalePending(wallet) {
    const pending = db.getPendingRunAixRun(wallet);
    if (!pending) return null;
    if (Date.now() - pending.startedAt <= RUN_TTL_MS) return pending;
    expireRun(pending);
    return null;
  }

  async function startRun(wallet, body) {
    const stakeUnits = parseA(body?.stakeA);
    if (stakeUnits < MIN_STAKE_UNITS || stakeUnits > MAX_STAKE_UNITS) throw new Error('单局押注须在 0.1 – 500 AIX 之间');
    const levelId = LEVEL_IDS.includes(body?.levelId) ? body.levelId : 'level-1';
    return withAccountLock(wallet, () => {
      if (expireStalePending(wallet)) throw apiError('上一局尚未结算，请先完成或等待作废', 'PENDING_RUN', 409);
      // 先扣押注（余额不足时 debitA 抛错，局不创建）；若随后建局/记账失败则原路退还。
      aTokenService.debitA(wallet, stakeUnits);
      try {
        const quotaUnits = stakeUnits / QUOTA_BPS; // 向下取整
        let quotaGrantedUnits = 0n;
        if (quotaUnits > 0n) {
          try { db.addATokenSellQuota(wallet, quotaUnits); quotaGrantedUnits = quotaUnits; }
          catch (e) { console.warn(`[奔跑吧AIX] ${wallet} 可卖额度累加失败:`, e?.message || e); }
        }
        // 每局独立秘密（daily 押注局同样每局独立：全服共用航路一旦被跑通就会外泄）
        const secret = crypto.randomBytes(SECRET_BYTES).toString('hex');
        const run = {
          id: `rar_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`,
          wallet, stakeUnits: stakeUnits.toString(), status: 'pending',
          distance: 0, payoutUnits: '0', quotaUnits: quotaGrantedUnits.toString(),
          elapsedMs: 0, startedAt: Date.now(), settledAt: 0,
          levelId, secret, commitment: sha256(secret), trace: [], revealed: TAPE_WINDOW, createdAt: nowIso(),
        };
        db.insertRunAixRun(run);
        return {
          runId: run.id,
          commitment: run.commitment,
          tape: tapeSlice(secret, 0, TAPE_WINDOW),
          tapeWindow: TAPE_WINDOW,
          stakeA: fmtA(stakeUnits),
          quotaGrantedA: fmtA(quotaGrantedUnits),
          balanceA: fmtA(aTokenService.balanceA(wallet)),
        };
      } catch (error) {
        try { aTokenService.creditA(wallet, stakeUnits); } catch (e) { console.error(`[奔跑吧AIX] ${wallet} 开局失败且退款失败，需人工处理:`, e?.message || e); }
        throw error;
      }
    });
  }

  function loadOwnRun(wallet, runId) {
    if (!runId || runId.length > 80) throw new Error('局号不正确');
    const run = db.getRunAixRun(runId);
    if (!run || String(run.wallet).toLowerCase() !== String(wallet).toLowerCase()) throw apiError('局不存在', 'NOT_FOUND', 404);
    return run;
  }

  // 把本次提交的帧接到已提交日志之后：已提交部分只读，重叠部分必须逐帧一致
  function mergeTrace(stored, from, frames) {
    if (!Number.isInteger(from) || from < 0 || from > stored.length) {
      throw Object.assign(apiError('输入日志不连续', 'TRACE_GAP', 409), { committed: stored.length });
    }
    const overlap = Math.min(stored.length - from, frames.length);
    for (let i = 0; i < overlap; i += 1) {
      if (!sameFrame(stored[from + i], frames[i])) throw apiError('输入日志与已提交部分不一致，结算被拒绝', 'TRACE_REWRITE');
    }
    const merged = stored.concat(frames.slice(overlap));
    if (merged.length > TRACE_MAX_FRAMES) throw apiError('输入日志过长', 'TRACE_TOO_LONG');
    return merged;
  }

  // 日志声明的游戏时长不能跑在服务端真实时钟前面
  function assertClock(run, trace) {
    const traceSeconds = trace.reduce((sum, frame) => sum + frame[0], 0);
    const elapsedSeconds = (Date.now() - run.startedAt) / 1000;
    if (traceSeconds > elapsedSeconds + CLOCK_SLACK_S) throw apiError('输入日志时长异常，结算被拒绝', 'CLOCK_AHEAD');
  }

  // 兼容旧客户端整包提交 { trace }：等价于 from=0
  const framesOf = body => parseTrace(Array.isArray(body?.frames) ? body.frames : body?.trace ?? []);
  const fromOf = body => (Array.isArray(body?.frames) ? Number(body?.from) : 0);

  async function advanceRun(wallet, body) {
    const runId = String(body?.runId || '');
    const frames = framesOf(body);
    return withAccountLock(wallet, () => {
      const run = loadOwnRun(wallet, runId);
      if (run.status !== 'pending') throw apiError('本局已结束', 'RUN_CLOSED', 409);
      if (Date.now() - run.startedAt > RUN_TTL_MS) {
        expireRun(run);
        throw apiError('本局已超时作废', 'RUN_EXPIRED', 410);
      }
      const payload = run.payload || {};
      const trace = mergeTrace(payload.trace || [], fromOf(body), frames);
      assertClock(run, trace);
      const { engine, used } = replayRun(payload.levelId, payload.secret, trace);
      const revealed = Math.min(TAPE_MAX, Math.max(Number(payload.revealed) || 0, used + TAPE_WINDOW));
      db.updateRunAixPayload(runId, { ...payload, trace, revealed });
      const have = Math.max(0, Math.min(revealed, Math.floor(Number(body?.have) || 0)));
      return {
        committed: trace.length, ended: engine.state === 'ended', revealed,
        tapeFrom: have, tape: tapeSlice(payload.secret, have, revealed),
      };
    });
  }

  async function settleRun(wallet, body) {
    const runId = String(body?.runId || '');
    const frames = framesOf(body);
    return withAccountLock(wallet, () => {
      const run = loadOwnRun(wallet, runId);
      if (run.status !== 'pending') {
        // 幂等：重复结算返回既有结果
        return settlePayload(run, run.status === 'expired');
      }
      if (Date.now() - run.startedAt > RUN_TTL_MS) {
        expireRun(run);
        return settlePayload(db.getRunAixRun(runId), true);
      }
      const payload = run.payload || {};
      const trace = mergeTrace(payload.trace || [], fromOf(body), frames);
      assertClock(run, trace);
      // 回放校验：引擎必须正常终局，且回放距离与客户端口供一致（容差 1 米）
      const { engine } = replayRun(payload.levelId, payload.secret, trace);
      if (engine.state !== 'ended') {
        db.updateRunAixPayload(runId, { ...payload, trace });
        throw apiError('输入日志不完整，结算被拒绝', 'TRACE_INCOMPLETE');
      }
      const replayedDistance = Math.floor(engine.distance);
      const claimed = Number(body?.distance);
      if (Number.isFinite(claimed) && Math.abs(claimed - engine.distance) > DISTANCE_TOLERANCE) {
        throw apiError('距离校验失败，结算被拒绝', 'VERIFY_FAILED');
      }
      const multiplier = multiplierFor(replayedDistance);
      const payout = payoutUnitsFor(BigInt(run.stakeUnits), replayedDistance);
      // 先占坑（status → settled）再入账：并发/重复结算天然幂等
      const changed = db.settleRunAixRun(runId, {
        status: 'settled', distance: replayedDistance, payoutUnits: payout.toString(),
        elapsedMs: Math.round(engine.time * 1000), settledAt: Date.now(), trace,
      });
      if (!changed) return settlePayload(db.getRunAixRun(runId), false);
      let creditedUnits = 0n;
      if (payout > 0n) {
        aTokenService.creditA(wallet, payout);
        creditedUnits = payout;
      }
      return {
        distance: replayedDistance, completed: engine.result?.completed === true,
        reason: engine.result?.reason || '', multiplier: Math.round(multiplier * 100) / 100,
        stakeA: fmtA(run.stakeUnits), payoutA: fmtA(creditedUnits),
        balanceA: fmtA(aTokenService.balanceA(wallet)),
        serverSeed: payload.secret, commitment: payload.commitment,
      };
    });
  }

  function settlePayload(run, expired) {
    const multiplier = multiplierFor(expired ? 0 : run.distance);
    return {
      distance: run.distance, completed: run.distance >= MAX_DISTANCE,
      multiplier: Math.round(multiplier * 100) / 100,
      stakeA: fmtA(run.stakeUnits), payoutA: fmtA(run.payoutUnits || '0'),
      alreadySettled: true, expired: Boolean(expired),
      serverSeed: run.payload?.secret, commitment: run.payload?.commitment,
    };
  }

  function stateOf(wallet) {
    const pending = expireStalePending(wallet);
    const stats = db.getRunAixStats(wallet);
    const quota = db.getATokenSellQuota(wallet);
    return {
      wallet,
      balanceA: fmtA(aTokenService.balanceA(wallet)),
      minStakeA: fmtA(MIN_STAKE_UNITS),
      maxStakeA: fmtA(MAX_STAKE_UNITS),
      ladder: {
        milestones: WAGER.milestones.map(([meters, percent]) => ({ meters, multiplier: percent / 100 })),
        maxDistance: WAGER.maxDistance,
      },
      turnoverA: fmtA(stats.turnoverUnits),
      runs: stats.runs,
      sellQuota: { releasedA: fmtA(quota.releasedUnits), usedA: fmtA(quota.usedUnits), availableA: fmtA(BigInt(quota.releasedUnits) - BigInt(quota.usedUnits)) },
      pendingRun: presentRun(pending),
      recentRuns: db.listRunAixRuns(wallet, RECENT_LIMIT).map(presentRun),
    };
  }

  async function handle(request, res, pathname) {
    if (!pathname.startsWith('/api/run-aix/')) return false;
    const isGet = request.method === 'GET';
    try {
      if (isGet && pathname === '/api/run-aix/state') {
        const session = requireSession(request);
        return send(res, 200, stateOf(session.address));
      }
      if (pathname === '/api/run-aix/start' && request.method === 'POST') {
        const session = requireSession(request);
        const body = await readBody(request);
        return send(res, 200, await startRun(session.address, body));
      }
      if (pathname === '/api/run-aix/advance' && request.method === 'POST') {
        const session = requireSession(request);
        const body = await readBody(request, 4_000_000);
        return send(res, 200, await advanceRun(session.address, body));
      }
      if (pathname === '/api/run-aix/settle' && request.method === 'POST') {
        const session = requireSession(request);
        const body = await readBody(request, 4_000_000); // 逐帧日志可达 ~1MB
        return send(res, 200, await settleRun(session.address, body));
      }
      return send(res, 404, { error: '接口不存在', code: 'NOT_FOUND' });
    } catch (error) {
      console.warn(`[奔跑吧AIX] ${pathname} 失败:`, error?.message || error);
      if (error?.code === 'TRACE_GAP') {
        return send(res, 409, { error: error.message, code: error.code, committed: error.committed });
      }
      return sendError(res, error);
    }
  }

  return { handle, multiplierFor, replayRun, tapeValue, TAPE_WINDOW };
}
