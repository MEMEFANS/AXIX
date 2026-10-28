// 哈希星盘 AIX 押注 API /api/hash-aix/*（需钱包 session）。
// 规则（2026-10-28 改版）：
//   · 自选押注：单/双/大/小，单局 0.1 – 10000 AIX；命中返还 1.98×（含本金）；
//   · 结果 = SHA256(...) 末位十六进制字符（0–15）；0、1、E、F 为通杀区（庄家通吃），
//     有效区 2–D：单 = 3、5、7、9、B、D，双 = 2、4、6、8、A、C，
//     小 = 2–7，大 = 8–D——每项恰中 6/16 = 37.5%，期望返还 0.375 × 1.98 = 74.25%；
//   · 1% 流水 → AIX 可卖额度：押注即按 1% 累计（向下取整），写入
//     平台既有 a_token_sell_quotas；
//   · 必须登录：所有接口都要钱包 session。
// 公平性（commit-reveal）：服务端为每钱包预生成 server_seed，仅公布其 SHA-256
// 摘要（承诺）；开奖值 = SHA256(server_seed:client_seed:nonce) 末位十六进制字符。
// 结算后立即揭示本局 server_seed 明文并轮换新 seed——玩家可验算本局，
// 但无法用已揭示的 seed 预测后续局；服务端在下注前即锁定结果，无法看注改局。
import crypto from 'node:crypto';
import { parseUnits, formatUnits } from 'ethers';

const A_TOKEN_DECIMALS = 18;
const UNITS = 10n ** BigInt(A_TOKEN_DECIMALS);
const MIN_STAKE_UNITS = UNITS / 10n;          // 0.1 AIX
const MAX_STAKE_UNITS = 10000n * UNITS;       // 10000 AIX（2026-10-28 由 100 上调）
const QUOTA_BPS = 100n;                       // 1% 流水 → 可卖额度
const PAYOUT_NUMERATOR = 198n;                // 1.98×（含本金）
const PAYOUT_DENOMINATOR = 100n;
const SEED_BYTES = 32;
const CHOICE_IDS = new Set(['odd', 'even', 'small', 'big']);
const CLIENT_SEED_RE = /^[A-Za-z0-9_.\-]{1,64}$/;
const STAKE_RE = /^\d+(\.\d{1,2})?$/;         // 两位小数：0.01 AIX 粒度下 1.98× 恰好整除
const HISTORY_LIMIT = 50;
const RECENT_LIMIT = 16;
// 2026-10-28 通杀区规则（0、1、E、F）生效时刻：早于此结算的旧回合按旧规则（各 50%）核验
const RULES_V2_SINCE = 1793197300000;

const fmtA = units => { try { return formatUnits(BigInt(units || '0'), A_TOKEN_DECIMALS); } catch { return '0'; } };
const sha256 = text => crypto.createHash('sha256').update(String(text)).digest('hex');

export function createHashAixGameApi({ aTokenService, database, send, readBody, getSession, withAccountLock = (addr, op) => op() }) {
  const db = database;

  function apiError(message, code = 'HASH_AIX_ERROR', statusCode = 400) {
    return Object.assign(new Error(message), { code, statusCode });
  }
  function requireSession(request) {
    const session = getSession(request);
    if (!session) throw apiError('请先登录钱包', 'SESSION_REQUIRED', 401);
    return session;
  }
  function sendError(res, error) {
    send(res, Number(error?.statusCode) || 400, { error: error?.message || String(error), code: error?.code || 'HASH_AIX_ERROR' });
  }

  // 该钱包的当前承诺（无则生成）；只把摘要给前端，明文留在服务端
  function ensureSeed(wallet) {
    const cur = db.getHashAixSeed(wallet);
    if (cur) return cur;
    const serverSeed = crypto.randomBytes(SEED_BYTES).toString('hex');
    return db.upsertHashAixSeed(wallet, serverSeed, sha256(serverSeed), 1);
  }

  function presentBet(bet) {
    if (!bet) return null;
    const stakeUnits = BigInt(bet.stakeUnits || '0'), payoutUnits = BigInt(bet.payoutUnits || '0');
    return {
      id: bet.id, nonce: bet.nonce, choice: bet.choice, digit: bet.digit,
      hexDigit: bet.digit.toString(16), hash: bet.hash,
      serverSeed: bet.serverSeed, serverSeedHash: bet.serverSeedHash, clientSeed: bet.clientSeed,
      stakeA: fmtA(stakeUnits), payoutA: fmtA(payoutUnits),
      netA: fmtA(payoutUnits - stakeUnits),
      won: bet.outcome === 'win', rule: Number(bet.createdAt) >= RULES_V2_SINCE ? 2 : 1, stakeUnits: bet.stakeUnits, payoutUnits: bet.payoutUnits,
      createdAt: bet.createdAt,
    };
  }

  function statsOf(wallet) {
    const stats = db.getHashAixStats(wallet);
    const bets = db.listHashAixBets(wallet, 200);
    const played = bets; // 近 200 局内的汇总口径
    const wins = played.filter(bet => bet.outcome === 'win').length;
    const stakedUnits = played.reduce((sum, bet) => sum + BigInt(bet.stakeUnits || '0'), 0n);
    const payoutSumUnits = played.reduce((sum, bet) => sum + BigInt(bet.payoutUnits || '0'), 0n);
    return {
      turnoverA: fmtA(stats.turnoverUnits), bets: stats.bets,
      recentBets: played.length, wins,
      stakedA: fmtA(stakedUnits), payoutA: fmtA(payoutSumUnits),
      netA: fmtA(payoutSumUnits - stakedUnits),
    };
  }

  function stateOf(wallet) {
    const seed = ensureSeed(wallet);
    const quota = db.getATokenSellQuota(wallet);
    return {
      wallet,
      balanceA: fmtA(aTokenService.balanceA(wallet)),
      minStakeA: fmtA(MIN_STAKE_UNITS), maxStakeA: fmtA(MAX_STAKE_UNITS),
      payoutMultiplier: 1.98,
      fairness: { serverSeedHash: seed.serverSeedHash, nonce: seed.nonce, algorithm: 'SHA256(serverSeed:clientSeed:nonce) 末位十六进制，0、1、E、F 通杀' },
      // 可卖额度显示恒为非负：占用超出释放时按 0 展示（资产页口径一致）
      sellQuota: { releasedA: fmtA(quota.releasedUnits), usedA: fmtA(quota.usedUnits), availableA: fmtA(BigInt(quota.releasedUnits) > BigInt(quota.usedUnits) ? BigInt(quota.releasedUnits) - BigInt(quota.usedUnits) : 0n) },
      stats: statsOf(wallet),
      recent: db.listHashAixBets(wallet, RECENT_LIMIT).map(presentBet),
    };
  }

  async function placeBet(wallet, body) {
    const choice = String(body?.choice || '');
    if (!CHOICE_IDS.has(choice)) throw new Error('请选择单双或大小中的一项');
    const stakeText = String(body?.stakeA ?? '').trim();
    if (!STAKE_RE.test(stakeText)) throw new Error('押注金额需为 0.1 – 10000 之间、最多两位小数的 AIX');
    const stakeUnits = parseUnits(stakeText, A_TOKEN_DECIMALS);
    if (stakeUnits < MIN_STAKE_UNITS || stakeUnits > MAX_STAKE_UNITS) throw new Error('单局押注须在 0.1 – 10000 AIX 之间');
    const clientSeed = String(body?.clientSeed ?? '').trim() || 'AIX-starlight';
    if (!CLIENT_SEED_RE.test(clientSeed)) throw new Error('玩家种子需为 1–64 位字母、数字、短横线、下划线或小数点');
    return withAccountLock(wallet, () => {
      const seed = ensureSeed(wallet);
      // 先扣押注；结算链路任何失败都原路退还
      aTokenService.debitA(wallet, stakeUnits);
      try {
        const hash = sha256(`${seed.serverSeed}:${clientSeed}:${seed.nonce}`);
        const hexDigit = hash.at(-1);
        const digit = Number.parseInt(hexDigit, 16);
        // 0、1、E、F 通杀：单/双/大/小每项恰中 6/16 = 37.5%
        const live = digit >= 2 && digit <= 13;
        const won = live && (choice === (digit % 2 ? 'odd' : 'even') || choice === (digit >= 8 ? 'big' : 'small'));
        const payoutUnits = won ? stakeUnits * PAYOUT_NUMERATOR / PAYOUT_DENOMINATOR : 0n;
        const quotaUnits = stakeUnits / QUOTA_BPS;
        if (quotaUnits > 0n) {
          try { db.addATokenSellQuota(wallet, quotaUnits); }
          catch (e) { console.warn(`[哈希星盘] ${wallet} 可卖额度累加失败:`, e?.message || e); }
        }
        if (payoutUnits > 0n) aTokenService.creditA(wallet, payoutUnits);
        const bet = db.insertHashAixBet({
          id: `hab_${seed.nonce}_${hash.slice(0, 12)}`,
          wallet, choice, stakeUnits: stakeUnits.toString(), payoutUnits: payoutUnits.toString(),
          digit, outcome: won ? 'win' : 'lose', hash,
          serverSeed: seed.serverSeed, serverSeedHash: seed.serverSeedHash,
          clientSeed, nonce: seed.nonce, quotaUnits: quotaUnits.toString(),
          createdAt: Date.now(),
        });
        // 揭示本局 seed 明文后立即轮换：旧 seed 可验算、不可预测后续局
        const nextSeed = crypto.randomBytes(SEED_BYTES).toString('hex');
        const next = db.upsertHashAixSeed(wallet, nextSeed, sha256(nextSeed), seed.nonce + 1);
        return {
          record: presentBet(bet),
          next: { serverSeedHash: next.serverSeedHash, nonce: next.nonce },
          payoutA: fmtA(payoutUnits),
          balanceA: fmtA(aTokenService.balanceA(wallet)),
        };
      } catch (error) {
        try { aTokenService.creditA(wallet, stakeUnits); } catch (e) { console.error(`[哈希星盘] ${wallet} 下注失败且退款失败，需人工处理:`, e?.message || e); }
        throw error;
      }
    });
  }

  async function handle(request, res, pathname) {
    if (!pathname.startsWith('/api/hash-aix/')) return false;
    const isGet = request.method === 'GET';
    try {
      if (isGet && pathname === '/api/hash-aix/state') {
        const session = requireSession(request);
        return send(res, 200, stateOf(session.address));
      }
      if (isGet && pathname === '/api/hash-aix/history') {
        const session = requireSession(request);
        return send(res, 200, {
          ...statsOf(session.address),
          records: db.listHashAixBets(session.address, HISTORY_LIMIT).map(presentBet),
        });
      }
      if (pathname === '/api/hash-aix/bet' && request.method === 'POST') {
        const session = requireSession(request);
        const body = await readBody(request);
        return send(res, 200, await placeBet(session.address, body));
      }
      return send(res, 404, { error: '接口不存在', code: 'NOT_FOUND' });
    } catch (error) {
      console.warn(`[哈希星盘] ${pathname} 失败:`, error?.message || error);
      return sendError(res, error);
    }
  }

  return { handle };
}
