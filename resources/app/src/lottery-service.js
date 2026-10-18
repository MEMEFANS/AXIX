import crypto from 'node:crypto';
import { parseUnits } from 'ethers';

// 积分抽奖服务
// 独立积分体系，不与 AIX 代币挂钩
// 积分获取：激活矿机（自己+直推）、社交推广审核
// 抽奖：10 积分/次，支持 1/10 连抽，服务端控制概率

const DRAW_COST = 10; // 每次抽奖消耗积分

// 奖品配置：type=crypto(币) / physical(实物) / none(谢谢参与)
// amount 为币奖浮动区间 [min, max]，按币价(CRYPTO_PRICE)折算约 0.1~0.3 USDT，实物为 null
const PRIZES = [
  { id: 'btc',     name: '比特币',     type: 'crypto',   amount: [0.0000012, 0.00000357],   probability: 0.008,  symbol: 'BTC'  },   // ≈0.1~0.3U @83886
  { id: 'eth',     name: '以太坊',     type: 'crypto',   amount: [0.00004, 0.0001185],      probability: 0.008,  symbol: 'ETH'  },   // ≈0.1~0.3U @2530
  { id: 'bnb',     name: 'BNB',        type: 'crypto',   amount: [0.0001342, 0.0004024],    probability: 0.012,  symbol: 'BNB'  },   // ≈0.1~0.3U @745
  { id: 'usdt',    name: 'USDT',       type: 'crypto',   amount: [0.1, 0.3],                probability: 0.020,  symbol: 'USDT' },   // 0.1~0.3U
  { id: 'iphone_fold', name: '苹果折叠手机', type: 'physical', probability: 0 },
  { id: 'iphone18', name: '苹果18 Pro Max', type: 'physical', probability: 0 },
  { id: 'huawei_fold', name: '华为折叠', type: 'physical', probability: 0 },
  { id: 'huawei_pc',   name: '华为电脑', type: 'physical', probability: 0 },
  { id: 'huawei_phone', name: '华为手机', type: 'physical', probability: 0 },
  { id: 'aix',     name: '空投',       type: 'crypto',   amount: [0.97, 2.88],              probability: 0.040,  symbol: 'AIX'  },   // ≈0.1~0.3U @0.1039
  { id: 'mystery', name: '神秘礼包',   type: 'points',   amount: 10, probability: 0.020, symbol: '积分' },
  { id: 'none',    name: '谢谢参与',   type: 'none',     probability: 0.892 },
];

// 实物奖价值折算（USDT）
const PHYSICAL_VALUE = {
  iphone_fold: 2000, iphone18: 1500, huawei_fold: 2000, huawei_pc: 1500,
  huawei_phone: 500,
};

// 币种精度
const ASSET_DECIMALS = { BTC: 8, ETH: 18, BNB: 18, USDT: 6, AIX: 18, A: 18 };

// 币价折算（USDT），用于排行榜价值估算；按领取日市价快照更新（2026-10-13）
const CRYPTO_PRICE = {
  BTC: 83886.01, ETH: 2529.76, BNB: 745.51, USDT: 1, AIX: 0.103921, A: 0.103921,
};

// 积分规则
const POINT_RULES = {
  self_activate_plan1: 10,   // 自己激活 0.002 矿机
  self_activate_plan2: 300,  // 自己激活 0.05 矿机
  direct_activate_plan1: 5,   // 直推激活 0.002 矿机
  direct_activate_plan2: 150, // 直推激活 0.05 矿机
  social_twitter: 10,        // 推特推广
  social_moments: 10,        // 朋友圈推广
};

function key(addr) { return String(addr || '').toLowerCase(); }
function shortAddr(a) {
  const s = String(a || '');
  return s.length > 10 ? `${s.slice(0, 6)}…${s.slice(-4)}` : s;
}

// Screenshots are uploaded raster images, never HTML or scriptable documents.
export function normalizeSocialScreenshot(value) {
  if (typeof value !== 'string' || value.length > 950_000) {
    throw Object.assign(new Error('截图过大，请压缩图片后重新上传'), { statusCode:413 });
  }
  const match = /^data:image\/(png|jpeg|jpg|webp|gif);base64,([A-Za-z0-9+/]+={0,2})$/i.exec(value);
  if (!match) throw new Error('请上传 PNG、JPG、WEBP 或 GIF 图片截图');
  const bytes = Buffer.from(match[2], 'base64');
  if (!bytes.length || bytes.toString('base64') !== match[2]) throw new Error('截图图片数据无效');
  const type = match[1].toLowerCase();
  const valid = type === 'png' ? bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
    : type === 'jpeg' || type === 'jpg' ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
    : type === 'gif' ? ['GIF87a','GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'))
    : bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP';
  if (!valid) throw new Error('截图图片格式与内容不一致');
  return value;
}

export function createLotteryService({ database, walletService, platformService, referralService, clock = () => Date.now() }) {
  const db = database;

  // ── 概率覆盖（后台可调） ─────────────────────────────────────
  const PROBABILITY_KEY = 'lottery_probabilities';
  let probabilityOverrides = {};
  try {
    const saved = JSON.parse(db.getSetting(PROBABILITY_KEY) || '{}') || {};
    const current = Object.fromEntries(Object.entries(saved).filter(([id]) => PRIZES.some(p => p.id === id)));
    const savedTotal = PRIZES.reduce((sum, p) => sum + (current[p.id] == null ? p.probability * 100 : current[p.id]), 0);
    probabilityOverrides = Math.abs(savedTotal - 100) <= 0.01 ? current : {};
  } catch { probabilityOverrides = {}; }
  // 生效概率：后台配置优先（单位 %），否则用默认
  function prizeProbability(p) {
    const v = Number(probabilityOverrides[p.id]);
    return Number.isFinite(v) && v >= 0 && v <= 100 ? v / 100 : p.probability;
  }

  // ── 币奖价值区间覆盖（后台可调） ─────────────────────────────
  const AMOUNT_KEY = 'lottery_amount_ranges';
  let amountOverrides = {}; // { prizeId: [min, max] }
  try {
    const saved = JSON.parse(db.getSetting(AMOUNT_KEY) || '{}') || {};
    amountOverrides = Object.fromEntries(Object.entries(saved).filter(([id, v]) =>
      PRIZES.some(p => p.id === id && p.type === 'crypto')
      && Array.isArray(v) && v.length === 2
      && Number.isFinite(Number(v[0])) && Number.isFinite(Number(v[1]))
      && Number(v[0]) > 0 && Number(v[1]) >= Number(v[0])));
  } catch { amountOverrides = {}; }

  // 生效数量配置：后台区间优先，否则用默认
  function prizeAmountCfg(p) {
    return amountOverrides[p.id] || p.amount || null;
  }

  // 默认配置的整体 min/max（segments 分段格式取所有段的全局最小/最大），用于后台展示
  function defaultAmountRange(p) {
    const a = p.amount;
    if (Array.isArray(a)) return { min: a[0], max: a[1] };
    if (a && typeof a === 'object' && Array.isArray(a.segments)) {
      let min = Infinity, max = 0;
      for (const [, [lo, hi]] of a.segments) { if (lo < min) min = lo; if (hi > max) max = hi; }
      return { min, max };
    }
    if (typeof a === 'number') return { min: a, max: a };
    return null;
  }

  // ── 积分账户 ──────────────────────────────────────────────────
  function ensureAccount(wallet) {
    const w = key(wallet);
    let acc = db.getLotteryAccount(w);
    if (!acc) {
      acc = { wallet: w, points: 0, updatedAt: clock() };
      db.upsertLotteryAccount(acc);
    }
    return acc;
  }

  function getPoints(wallet) {
    return ensureAccount(wallet).points;
  }

  // 发放积分（type: reason 标识来源）
  function addPoints(wallet, points, type, refId = '', note = '') {
    if (!points || points <= 0) return null;
    const w = key(wallet);
    const acc = ensureAccount(w);
    const before = acc.points;
    acc.points = before + points;
    acc.updatedAt = clock();
    db.upsertLotteryAccount(acc);
    const flow = {
      id: `lf_${crypto.randomBytes(10).toString('hex')}`,
      wallet: w, change: points, balance: acc.points,
      type, refId, note, createdAt: clock(),
    };
    db.insertLotteryFlow(flow);
    return flow;
  }

  function listFlows(wallet, limit = 50) {
    return db.listLotteryFlows(key(wallet), limit);
  }

  // ── 矿机激活积分发放 ──────────────────────────────────────────
  function onMinerActivated(wallet, plan) {
    const w = key(wallet);
    const planKey = String(plan);
    // 自己激活
    const selfPts = planKey === '1' ? POINT_RULES.self_activate_plan1
                  : planKey === '2' ? POINT_RULES.self_activate_plan2 : 0;
    if (selfPts > 0) addPoints(w, selfPts, 'self_activate', `miner:${planKey}`, `自己激活${planKey === '1' ? 'Mini' : 'Pro'}矿机`);
    // 直推激活奖励
    try {
      const referrer = referralService?.links?.().find?.(r => key(r.wallet) === w)?.referrerWallet;
      if (referrer) {
        const refPts = planKey === '1' ? POINT_RULES.direct_activate_plan1
                      : planKey === '2' ? POINT_RULES.direct_activate_plan2 : 0;
        if (refPts > 0) addPoints(referrer, refPts, 'direct_activate', `miner:${planKey}:${w}`, `直推${shortAddr(w)}激活${planKey === '1' ? 'Mini' : 'Pro'}矿机`);
      }
    } catch (e) { /* 推荐关系查询失败不阻塞 */ }
  }

  // ── 抽奖 ──────────────────────────────────────────────────────
  // 币奖浮动金额：对数分布，99% 集中在小额
  // amount 支持两种格式：
  //   [min, max] 数组 → 对数分布（90% 小额 / 10% 大额）
  //   { segments: [[权重, [min, max]], ...] } → 按权重分段，段内均匀随机
  function randomAmount(amount) {
    // 分段格式：{ segments: [[0.8, [1,2]], [0.2, [1,5]]] }
    if (amount && typeof amount === 'object' && Array.isArray(amount.segments)) {
      const total = amount.segments.reduce((s, [w]) => s + w, 0);
      let r = Math.random() * total;
      for (const [w, [min, max]] of amount.segments) {
        r -= w;
        if (r <= 0) {
          if (min >= max) return min;
          // 段内均匀随机
          const amt = min + Math.random() * (max - min);
          const decimals = amt < 0.001 ? 8 : amt < 1 ? 6 : amt < 100 ? 4 : 2;
          return Number(amt.toFixed(decimals));
        }
      }
      const [min, max] = amount.segments[amount.segments.length - 1][1];
      return min >= max ? min : Number((min + Math.random() * (max - min)).toFixed(2));
    }
    // 数组格式 [min, max]
    const [min, max] = amount;
    if (min >= max) return min;
    // 对数分布：大部分小额，偶尔大额
    const logMin = Math.log10(min);
    const logMax = Math.log10(max);
    // 90% 概率取前 50% 区间（小额），10% 取后 50%
    const r = Math.random();
    let logR;
    if (r < 0.9) {
      logR = logMin + Math.random() * (logMax - logMin) * 0.5;
    } else {
      logR = logMin + (logMax - logMin) * (0.5 + Math.random() * 0.5);
    }
    const amt = Math.pow(10, logR);
    // 格式化精度
    const decimals = amt < 0.001 ? 8 : amt < 1 ? 6 : amt < 100 ? 4 : 2;
    return Number(amt.toFixed(decimals));
  }

  // 统一解析奖品数量：
  //  · points 类型（神秘礼包）：amount 是固定积分数字（如 10），不是随机区间，绝不能传给 randomAmount（否则 amount is not iterable）
  //  · crypto 类型：amount 为 [min,max] 或 {segments}，走随机金额；后台设置的价值区间优先
  //  · 指定中奖（后台安排）：优先用指定数量
  function resolvePrizeAmount(prize, assigned = null) {
    if (assigned?.amount) return assigned.amount;
    if (prize.type === 'points') return Number(prize.amount) || 0;
    const cfg = prizeAmountCfg(prize);
    if (cfg) return randomAmount(cfg);
    return null;
  }

  // 按概率抽奖（排除今日已出完的实物）
  function weightedPick(excludeIds = []) {
    const avail = PRIZES.filter(p => !excludeIds.includes(p.id));
    const total = avail.reduce((s, p) => s + prizeProbability(p), 0);
    let r = Math.random() * total;
    for (const p of avail) {
      r -= prizeProbability(p);
      if (r <= 0) return p;
    }
    return avail[avail.length - 1];
  }

  // 获取今日已出完的实物奖 id 列表
  function getSoldOutPhysicalIds() {
    const now = clock();
    const bj = new Date(now + 8 * 60 * 60_000);
    const start = Date.UTC(bj.getUTCFullYear(), bj.getUTCMonth(), bj.getUTCDate()) - 8 * 60 * 60_000;
    const todayPhysicals = db.listLotteryWinsSince(null, start)
      .filter(w => w.prizeType === 'physical' && w.prizeId);
    const counts = {};
    for (const w of todayPhysicals) counts[w.prizeId] = (counts[w.prizeId] || 0) + 1;
    return Object.keys(counts).filter(id => counts[id] >= 1);
  }

  // 开奖异常时退回已扣积分：账户加回 + 一条 draw_refund 流水，保证“绝不白扣分”
  function refundConsume(w, points) {
    const acc = ensureAccount(w);
    acc.points += points;
    acc.updatedAt = clock();
    db.upsertLotteryAccount(acc);
    db.insertLotteryFlow({
      id: `lf_${crypto.randomBytes(10).toString('hex')}`,
      wallet: w, change: points, balance: acc.points,
      type: 'draw_refund', refId: '', note: '抽奖异常，积分退回', createdAt: clock(),
    });
  }

  // 单次抽奖
  function draw(wallet) {
    const w = key(wallet);
    const acc = ensureAccount(w);
    if (acc.points < DRAW_COST) throw new Error('积分不足');

    // 扣除积分
    acc.points -= DRAW_COST;
    acc.updatedAt = clock();
    db.upsertLotteryAccount(acc);
    db.insertLotteryFlow({
      id: `lf_${crypto.randomBytes(10).toString('hex')}`,
      wallet: w, change: -DRAW_COST, balance: acc.points,
      type: 'draw_consume', refId: '', note: '抽奖消耗', createdAt: clock(),
    });

    // 扣积分后若开奖任一步骤异常，必须退回积分，再把错误交给接口返回
    try {
      // 检查指定中奖
      const assigned = db.getPendingAssignedWin(w);
      if (assigned) {
        const prize = PRIZES.find(p => p.id === assigned.prizeId) || { id: assigned.prizeId, name: assigned.prizeName, type: assigned.prizeType };
        const amount = resolvePrizeAmount(prize, assigned);
        const win = finalizeWin(w, prize, amount, assigned.id);
        db.markAssignedWinUsed(assigned.id, clock());
        return win;
      }

      // 正常概率抽奖
      const soldOut = getSoldOutPhysicalIds();
      const prize = weightedPick(soldOut);
      const amount = resolvePrizeAmount(prize);
      return finalizeWin(w, prize, amount, null);
    } catch (error) {
      try { refundConsume(w, DRAW_COST); } catch (e) { console.error('[抽奖] 积分退回失败', w, e?.message || e); }
      throw error;
    }
  }

  function finalizeWin(wallet, prize, amount, assignedId) {
    const valueUsdt = prize.type === 'crypto'
      ? Number((amount * (CRYPTO_PRICE[prize.symbol] || 0)).toFixed(2))
      : prize.type === 'physical' ? PHYSICAL_VALUE[prize.id] || 0 : 0;

    const win = {
      id: `lw_${crypto.randomBytes(12).toString('hex')}`,
      wallet,
      prizeId: prize.id,
      prizeName: prize.name,
      prizeType: prize.type,
      symbol: prize.symbol || '',
      amount: amount || 0,
      valueUsdt,
      status: prize.type === 'physical' ? 'pending_address' : 'claimed',
      addressPayload: null,
      trackingNo: '',
      assignedId: assignedId || '',
      createdAt: clock(),
      claimedAt: prize.type === 'physical' ? null : clock(),
      shippedAt: null,
    };
    db.insertLotteryWin(win);

    // 币奖入账：BTC/ETH/BNB 入平台现货台账（资产页可见、可卖出换 USDT）；
    // USDT/AIX 入钱包资金账本（资产页 USDT 行与 AIX 行读取钱包余额）
    if (prize.type === 'crypto' && amount > 0) {
      try {
        if (prize.symbol === 'USDT') {
          walletService?.creditBalance?.(wallet, 'USDT', parseUnits(String(amount), 6).toString());
        } else if (prize.symbol === 'AIX') {
          walletService?.creditBalance?.(wallet, 'A', parseUnits(String(amount), 18).toString());
        } else if (platformService?.creditSpot) {
          platformService.creditSpot(wallet, prize.symbol, parseUnits(String(amount), 8).toString());
        } else {
          const sym = prize.symbol;
          walletService?.creditBalance?.(wallet, sym, parseUnits(String(amount), ASSET_DECIMALS[sym] || 18).toString());
        }
      } catch (e) {
        console.error('[抽奖] 币奖入账失败', wallet, prize.symbol, amount, e?.message || e);
      }
    }
    if (prize.type === 'points' && amount > 0) {
      addPoints(wallet, Number(amount), 'lottery_mystery', win.id, '神秘礼包：抽奖奖励 10 积分');
    }
    return win;
  }

  // 10 连抽
  function drawTen(wallet) {
    const w = key(wallet);
    const acc = ensureAccount(w);
    const cost = DRAW_COST * 10;
    if (acc.points < cost) throw new Error('积分不足');

    // 一次性扣 100 积分
    acc.points -= cost;
    acc.updatedAt = clock();
    db.upsertLotteryAccount(acc);
    db.insertLotteryFlow({
      id: `lf_${crypto.randomBytes(10).toString('hex')}`,
      wallet: w, change: -cost, balance: acc.points,
      type: 'draw_consume', refId: '', note: '10连抽消耗', createdAt: clock(),
    });

    const wins = [];
    const soldOut = getSoldOutPhysicalIds();
    for (let i = 0; i < 10; i++) {
      // 中途某发异常：已抽 i 发的奖品保留，退回其余 (10-i) 发的积分，不继续
      try {
        const assigned = i === 0 ? db.getPendingAssignedWin(w) : null; // 只第一发检查指定
        if (assigned) {
          const prize = PRIZES.find(p => p.id === assigned.prizeId) || { id: assigned.prizeId, name: assigned.prizeName, type: assigned.prizeType };
          const amount = resolvePrizeAmount(prize, assigned);
          wins.push(finalizeWin(w, prize, amount, assigned.id));
          db.markAssignedWinUsed(assigned.id, clock());
        } else {
          const prize = weightedPick(soldOut);
          const amount = resolvePrizeAmount(prize);
          wins.push(finalizeWin(w, prize, amount, null));
          // 如果中了实物，加入今日售罄列表
          if (prize.type === 'physical') soldOut.push(prize.id);
        }
      } catch (error) {
        const remaining = (10 - i) * DRAW_COST;
        try { refundConsume(w, remaining); } catch (e) { console.error('[抽奖] 积分退回失败', w, e?.message || e); }
        console.error('[抽奖] 10连抽第', i + 1, '发异常，已退', remaining, '积分', error?.message || error);
        wins.partial = true;
        return wins;
      }
    }
    return wins;
  }

  function listWins(wallet, limit = 50) {
    return db.listLotteryWins(key(wallet), limit);
  }

  function submitAddress(winId, wallet, payload) {
    const win = db.getLotteryWin(winId);
    if (!win) throw new Error('中奖记录不存在');
    if (key(win.wallet) !== key(wallet)) throw new Error('无权操作');
    if (win.prizeType !== 'physical') throw new Error('非实物奖无需填地址');
    win.addressPayload = JSON.stringify(payload);
    win.status = 'pending_ship';
    db.updateLotteryWin(win);
    return win;
  }

  // ── 滚动公告 ──────────────────────────────────────────────────
  function recentWins(limit = 50) {
    return db.listRecentLotteryWins(limit)
      .filter(w => w.prizeType !== 'none')
      .map(w => ({
        id: w.id,
        wallet: shortAddr(w.wallet),
        prizeName: w.prizeName,
        amount: w.amount,
        symbol: w.symbol,
        prizeType: w.prizeType,
        createdAt: w.createdAt,
      }));
  }

  // ── 价值排行榜 ────────────────────────────────────────────────
  function leaderboard(days = 7, limit = 20) {
    const since = days > 0 ? Date.now() - days * 86400000 : 0;
    return db.listLotteryWinsSince(null, since)
      .filter(w => w.prizeType !== 'none' && w.valueUsdt > 0)
      .sort((a, b) => b.valueUsdt - a.valueUsdt)
      .slice(0, limit)
      .map(w => ({
        wallet: shortAddr(w.wallet),
        prizeName: w.prizeName,
        amount: w.amount,
        symbol: w.symbol,
        valueUsdt: w.valueUsdt,
        createdAt: w.createdAt,
      }));
  }

  // ── 社交推广 ──────────────────────────────────────────────────
  function submitSocial(wallet, platform, screenshotUrl) {
    const w = key(wallet);
    const plat = String(platform || '').toLowerCase();
    if (!['twitter', 'moments'].includes(plat)) throw new Error('平台无效');
    const screenshot = normalizeSocialScreenshot(screenshotUrl);
    // 每日限 1 次
    const start = new Date(); start.setHours(0, 0, 0, 0);
    const today = db.listSocialSubmissionsSince(w, start.getTime())
      .filter(s => s.platform === plat);
    if (today.length > 0) throw new Error('今日已提交过，请明天再来');
    const sub = {
      id: `ss_${crypto.randomBytes(10).toString('hex')}`,
      wallet: w,
      platform: plat,
      screenshotUrl: screenshot,
      status: 'pending',
      reviewer: '',
      reviewedAt: null,
      pointsAwarded: 0,
      createdAt: clock(),
    };
    db.insertSocialSubmission(sub);
    return sub;
  }

  function canSubmitSocial(wallet, platform) {
    const w = key(wallet);
    const start = new Date(); start.setHours(0, 0, 0, 0);
    const today = db.listSocialSubmissionsSince(w, start.getTime())
      .filter(s => s.platform === platform && s.status !== 'rejected');
    return today.length === 0;
  }

  // ── 后台 ──────────────────────────────────────────────────────
  function adminListSocial(status, limit = 100) {
    return db.listSocialSubmissions(status, limit).map(sub => {
      try { normalizeSocialScreenshot(sub.screenshotUrl); return { ...sub, screenshotSafe:true }; }
      catch { return { ...sub, screenshotUrl:'', screenshotSafe:false, screenshotError:'截图无效或格式不安全，请拒绝后让用户重新提交' }; }
    });
  }

  function adminReviewSocial(id, approve, reviewer = '') {
    const sub = db.getSocialSubmission(id);
    if (!sub) throw new Error('记录不存在');
    if (sub.status !== 'pending') throw new Error('已审核过');
    if (approve) normalizeSocialScreenshot(sub.screenshotUrl);
    sub.status = approve ? 'approved' : 'rejected';
    sub.reviewer = reviewer;
    sub.reviewedAt = clock();
    if (approve) {
      const pts = sub.platform === 'twitter' ? POINT_RULES.social_twitter : POINT_RULES.social_moments;
      sub.pointsAwarded = pts;
      addPoints(sub.wallet, pts, `social_${sub.platform}`, sub.id, `${sub.platform === 'twitter' ? '推特' : '朋友圈'}推广审核通过`);
    }
    db.updateSocialSubmission(sub);
    return sub;
  }

  function adminListPhysicalWins(status, limit = 100) {
    return db.listLotteryWinsByType('physical', status, limit);
  }

  function adminShipWin(id, trackingNo, operator = '') {
    const win = db.getLotteryWin(id);
    if (!win) throw new Error('中奖记录不存在');
    if (win.prizeType !== 'physical') throw new Error('非实物奖');
    win.trackingNo = String(trackingNo || '');
    win.status = 'shipped';
    win.shippedAt = clock();
    db.updateLotteryWin(win);
    return win;
  }

  function adminAssignWin(wallet, prizeId, amount = 0, note = '', operator = '') {
    const prize = PRIZES.find(p => p.id === prizeId);
    if (!prize) throw new Error('奖品无效');
    const w = key(wallet);
    // 每个钱包同时只能有一条未生效指定
    const existing = db.getPendingAssignedWin(w);
    if (existing) throw new Error('该钱包已有未生效的指定中奖');
    const assigned = {
      id: `aw_${crypto.randomBytes(10).toString('hex')}`,
      wallet: w,
      prizeId,
      prizeName: prize.name,
      prizeType: prize.type,
      amount: amount || 0,
      note,
      status: 'pending',
      usedAt: null,
      createdAt: clock(),
      createdBy: operator,
    };
    db.insertAssignedWin(assigned);
    return assigned;
  }

  function adminListAssigned(status = 'pending', limit = 100) {
    return db.listAssignedWins(status, limit);
  }

  function adminDeleteAssigned(id) {
    const r = db.deleteAssignedWin(id);
    return r;
  }

  function getConfig() {
    return {
      drawCost: DRAW_COST,
      dailyLimit: 0, // 0 = 不限次数
      prizes: PRIZES.map(p => ({
        id: p.id, name: p.name, type: p.type, symbol: p.symbol || '',
        probability: prizeProbability(p),
        defaultProbability: p.probability,
        amountRange: prizeAmountCfg(p),
      })),
      pointRules: POINT_RULES,
    };
  }

  // ── 后台：奖品概率配置 ────────────────────────────────────────
  function adminGetPrizeConfig() {
    return {
      prizes: PRIZES.map(p => {
        const def = defaultAmountRange(p);
        const ovr = amountOverrides[p.id];
        return {
          id: p.id, name: p.name, type: p.type, symbol: p.symbol || '',
          probability: prizeProbability(p),
          defaultProbability: p.probability,
          defaultAmountMin: def?.min ?? null,
          defaultAmountMax: def?.max ?? null,
          amountMin: ovr ? ovr[0] : def?.min ?? null,
          amountMax: ovr ? ovr[1] : def?.max ?? null,
          amountOverridden: Boolean(ovr),
        };
      }),
    };
  }

  function adminSetPrizeProbabilities(map, operator = '') {
    if (!map || typeof map !== 'object') throw new Error('参数无效');
    const next = { ...probabilityOverrides };
    for (const p of PRIZES) {
      if (!(p.id in map)) continue;
      const v = Number(map[p.id]);
      if (!Number.isFinite(v) || v < 0 || v > 100) throw new Error(`${p.name} 概率必须在 0~100 之间`);
      next[p.id] = Math.round(v * 10000) / 10000;
    }
    const total = PRIZES.reduce((s, p) => s + (next[p.id] == null ? p.probability * 100 : next[p.id]), 0);
    if (Math.abs(total - 100) > 0.01) throw new Error(`概率总和必须为 100%，当前为 ${total.toFixed(2)}%`);
    probabilityOverrides = next;
    db.saveSetting(PROBABILITY_KEY, JSON.stringify(probabilityOverrides));
    return adminGetPrizeConfig();
  }

  // ── 后台：币奖价值区间配置 ────────────────────────────────────
  // map: { prizeId: { min, max } } 设置覆盖；prizeId: null 表示恢复默认
  // 注意：覆盖后统一按 [min,max] 对数分布发奖（USDT 原有的分段权重分布同样被替换）
  function adminSetPrizeAmounts(map, operator = '') {
    if (!map || typeof map !== 'object') throw new Error('参数无效');
    const next = { ...amountOverrides };
    for (const p of PRIZES) {
      if (!(p.id in map)) continue;
      if (p.type !== 'crypto') throw new Error(`${p.name} 不支持设置价值区间`);
      const v = map[p.id];
      if (v === null || v === undefined || v === '') { delete next[p.id]; continue; }
      const min = Number(v.min), max = Number(v.max);
      if (!Number.isFinite(min) || !Number.isFinite(max) || min <= 0) throw new Error(`${p.name} 区间必须为正数`);
      if (max < min) throw new Error(`${p.name} 区间上限不能小于下限`);
      if (max > 1000000) throw new Error(`${p.name} 区间上限过大`);
      next[p.id] = [min, max];
    }
    amountOverrides = next;
    db.saveSetting(AMOUNT_KEY, JSON.stringify(amountOverrides));
    return adminGetPrizeConfig();
  }

  return {
    getPoints, addPoints, listFlows, ensureAccount,
    onMinerActivated,
    draw, drawTen, listWins, submitAddress,
    recentWins, leaderboard,
    submitSocial, canSubmitSocial,
    adminListSocial, adminReviewSocial,
    adminListPhysicalWins, adminShipWin,
    adminAssignWin, adminListAssigned, adminDeleteAssigned,
    adminGetPrizeConfig, adminSetPrizeProbabilities, adminSetPrizeAmounts,
    getConfig,
  };
}

export { PRIZES, POINT_RULES, DRAW_COST, PHYSICAL_VALUE, CRYPTO_PRICE };
