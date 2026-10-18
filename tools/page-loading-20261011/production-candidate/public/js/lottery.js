// 积分抽奖前端模块
// 提供：积分卡片、积分任务弹窗、抽奖单页（转盘+奖品+排行榜+中奖记录）、社交推广
(() => {
  let socialLanguageListener = null;
  // 奖品图标：币种用官方 logo，实物用 emoji
  const COIN_IMG = {
    btc: '/assets/tokens/btc.png?v=1', eth: '/assets/tokens/eth.png?v=1',
    bnb: '/assets/tokens/bnb.png?v=1', usdt: '/assets/tokens/usdt.png?v=1',
    aix: '/assets/tokens/a.png?v=4'
  };
  const PHYSICAL_EMOJI = {
    iphone_fold: '', iphone18: '', huawei_fold: '📱', huawei_pc: '💻', mystery: '🎁',
    huawei_phone: '📱', rtx5080: '🎮', ipad: '📋', keyboard: '⌨️', none: '�'
  };
  // 设备类奖品：有图的用官方/自制产品图，其余轻量 emoji 兜底，避免依赖外部图片导致移动端空白。
  // 华为折叠/手机使用自制 SVG（青绿配色与站点统一），放在 /assets/prizes/。
  const PRIZE_IMG = {
    iphone_fold: '/assets/prizes/iphone-duo.png?v=1',
    iphone18: '/assets/prizes/iphone-18-pro-max.png?v=1',
    huawei_fold: '/assets/prizes/huawei-fold.svg?v=1',
    huawei_phone: '/assets/prizes/huawei-phone.svg?v=1',
    rtx5080: '/assets/prizes/rtx5080.png?v=1'
  };
  // 图片缓存（canvas 绘制用）
  const imgCache = {};
  function getPrizeImg(id) {
    const src = COIN_IMG[id] || PRIZE_IMG[id];
    if (!src) return null;
    if (!imgCache[src]) {
      const im = new Image();
      im.src = src;
      imgCache[src] = im;
    }
    return imgCache[src];
  }
  // HTML 图标（列表/弹窗用）
  function prizeIconHtml(prizeId, size = 22) {
    const src = COIN_IMG[prizeId] || PRIZE_IMG[prizeId];
    if (src) return `<img src="${src}" alt="" style="width:${size}px;height:${size}px;object-fit:contain;vertical-align:middle">`;
    return `<span style="font-size:${Math.round(size * 0.95)}px;vertical-align:middle">${PHYSICAL_EMOJI[prizeId] || '🎁'}</span>`;
  }

  // ── 经典方形水果机：7×7 外框，24 个展示位（四周每边 7 格，四角共用）+ 中央主画面 ──
  // 布局规则：比特币在上、下两排正中（idx 3 / 20 上下正对）；谢谢参与在左、右两列
  // 正中（idx 9 / 14 左右正对）；其余奖品按中心旋转对称（斜角相对）成对分布。
  const DISPLAY_PRIZES = [
    'eth','bnb','usdt','btc','aix','iphone18','iphone_fold',              // 上排 0-6（btc 正中）
    'huawei_fold','huawei_pc','none','rtx5080','huawei_phone',             // 左列 7-11（none 正中）
    'huawei_phone','rtx5080','none','huawei_pc','huawei_fold',             // 右列 12-16（none 正中）
    'eth','bnb','usdt','btc','aix','iphone18','iphone_fold'                // 下排 17-23（btc 正中）
  ];
  // 顺时针跑灯路径：上排→右列→下排(右→左)→左列(下→上)
  const SPIN_PATH = [0,1,2,3,4,5,6,12,13,14,15,16,17,18,19,20,21,22,23,11,10,9,8,7];
  // 当前 24 格实际展示的奖品 id（中奖到展示位之外的奖品时临时替换目标格）
  let cellPrizeIds = DISPLAY_PRIZES.slice();
  // 格子内容：仅图标不放文字，保证奖品图案清晰（尺寸交给 CSS 控制，随屏幕自适应）
  function cellInnerHtml(pid) {
    if (pid === 'none') return '<span class="fc-icon">🍀</span>';
    const src = COIN_IMG[pid] || PRIZE_IMG[pid];
    if (src) return `<span class="fc-icon"><img src="${src}" alt=""></span>`;
    return `<span class="fc-icon">${PHYSICAL_EMOJI[pid] || '🎁'}</span>`;
  }
  // DOM 顺序：7×7 网格外框 24 格，中间 5×5 合并为主画面。
  const GRID_ORDER = [0,1,2,3,4,5,6, 7,8,9,10,11, 'core', 12,13,14,15,16, 17,18,19,20,21,22,23];
  function fruitGridHtml() {
    return GRID_ORDER.map((k, pos) => (k === 'core' || k === 'core2')
      ? `<div class="fruit-core"><div class="promo-glow"></div><div class="promo-brand"><img class="promo-logo" src="/assets/brand/logo.png" alt=""><span>AxiX</span></div><strong>幸运抽奖</strong><small>积分换好礼 · 好运即刻出发</small><div class="promo-prizes"><span class="promo-coin"><img src="/assets/tokens/btc.png" alt="">BTC</span><span class="promo-coin"><img src="/assets/tokens/eth.png" alt="">ETH</span><span class="promo-coin"><img src="/assets/tokens/bnb.png" alt="">BNB</span><span class="promo-coin"><img src="/assets/tokens/usdt.png" alt="">USDT</span></div><b class="promo-device">手机大奖 · 等你带走</b></div>`
      : `<div class="fruit-cell" data-idx="${k}" style="${pos < 7 ? `grid-column:${pos+1};grid-row:1` : pos < 12 ? `grid-column:1;grid-row:${pos-5}` : pos < 18 ? `grid-column:7;grid-row:${pos-11}` : `grid-column:${25-pos};grid-row:7`}">${cellInnerHtml(cellPrizeIds[k])}</div>`
    ).join('');
  }

  // 实物奖品展示型号（目录小字）
  const CATALOG_MODEL = {
    iphone_fold: 'iPhone Fold',
    iphone18: 'iPhone 18 Pro Max',
    huawei_fold: 'HUAWEI Mate XTs',
    huawei_pc: 'HUAWEI MateBook Pro',
    huawei_phone: 'HUAWEI Mate 80 Pro',
  };

  function prizeCatalogHtml() {
    const prizes = configCache?.prizes || [];
    return `<section class="lottery-catalog"><div class="lottery-catalog-head"><div><strong>本期奖品</strong><span>共 ${prizes.length} 项</span></div><small>币奖即时到账 · 实物中奖后填写收货信息</small></div><div class="lottery-catalog-grid">${prizes.map(p => `<div class="lottery-catalog-item"><span class="catalog-icon">${prizeIconHtml(p.id, 30)}</span><span class="catalog-name">${esc(p.name)}</span>${p.id === 'mystery' ? '' : (p.symbol ? `<small>${esc(p.symbol)}</small>` : (p.id === 'none' ? '' : `<small>${esc(CATALOG_MODEL[p.id] || '实物奖品')}</small>`))}</div>`).join('')}</div></section>`;
  }
  // 按 cellPrizeIds 重绘格子内容（保留 active/hit 状态）
  function renderFruitCells() {
    document.querySelectorAll('#fruit-grid .fruit-cell').forEach(cell => {
      const i = Number(cell.dataset.idx);
      const pid = cellPrizeIds[i];
      cell.dataset.prize = pid;
      cell.classList.toggle('cell-none', pid === 'none');
      cell.innerHTML = cellInnerHtml(pid);
    });
  }

  // ── 积分流水类型 ──
  const FLOW_META = {
    self_activate:    { icon: '⛏️', label: '自己激活矿机', dir: 'in' },
    direct_activate:  { icon: '👥', label: '直推奖励',     dir: 'in' },
    social_twitter:   { icon: '🐦', label: '推特推广奖励', dir: 'in' },
    social_moments:   { icon: '📢', label: '朋友圈推广奖励', dir: 'in' },
    draw_consume:     { icon: '🎰', label: '抽奖消耗',     dir: 'out' },
    lottery_mystery:  { icon: '🎁', label: '神秘礼包奖励', dir: 'in' },
    admin_topup:      { icon: '🎁', label: '积分充值',     dir: 'in' },
  };

  // 注入样式
  const STYLE = `
  /* 滚动公告 - 垂直滚动 */
  .lottery-marquee {
    max-width:620px; margin:0 auto 18px;
    background:linear-gradient(90deg,rgba(80,210,194,.07),rgba(80,210,194,.02));
    border:1px solid rgba(80,210,194,.2); border-radius:12px;
    padding:10px 14px; overflow:hidden;
  }
  .marquee-label {
    font-size:12px; color:#5bd8c6; font-weight:bold; margin-bottom:6px;
    display:flex; align-items:center; gap:6px;
  }
  .marquee-label::before { content:'🏆'; }
  .marquee-track { height:48px; overflow:hidden; position:relative; }
  .marquee-inner { animation:marquee-up 14s linear infinite; }
  @keyframes marquee-up { 0%{transform:translateY(0)} 100%{transform:translateY(-50%)} }
  .marquee-item {
    font-size:13px; color:#cfd8d6; white-space:nowrap; line-height:24px;
    overflow:hidden; text-overflow:ellipsis;
  }
  .marquee-item b { color:#50d2c2; }
  .marquee-item .marquee-wallet { color:#74c0fc; }
  .marquee-placeholder { font-size:13px; color:#5a6b68; text-align:center; line-height:48px; }

  /* 积分卡（机器下方独立区） */
  .points-board {
    display:flex; align-items:center; justify-content:space-between; gap:12px;
    max-width:620px; margin:0 auto 10px; padding:14px 18px;
    background:linear-gradient(135deg,rgba(80,210,194,.14),rgba(80,210,194,.04));
    border:1px solid rgba(80,210,194,.35); border-radius:14px;
    box-shadow:0 8px 22px rgba(0,0,0,.18);
  }
  .pb-left { display:flex; flex-direction:column; gap:2px; min-width:0; }
  .pb-label { font-size:12px; color:#8fd8cf; }
  .pb-left b { font-size:26px; color:#50d2c2; line-height:1.15; }
  .pb-left small { font-size:11px; color:#7f9990; }
  .pb-earn {
    font-size:13px; font-weight:700; padding:10px 18px; border-radius:10px; cursor:pointer;
    background:rgba(80,210,194,.15); color:#5bd8c6; border:1px solid rgba(80,210,194,.45);
    transition:all .2s; white-space:nowrap; flex-shrink:0;
  }
  .pb-earn:hover { background:rgba(80,210,194,.3); color:#e7f1ef; }

  /* 经典方形老虎机（深红金框 + 四周跑灯 + 7×7 外框） */
  .fruit-machine {
    position:relative; width:100%; max-width:460px; margin:0 auto 18px;
    border-radius:14px; padding:12px;
    background:
      radial-gradient(120% 50% at 50% 0%, #7a1019 0%, #5a0a12 50%, #3d060c 100%);
    border:3px solid #e8b84a;
    box-shadow:
      0 18px 40px rgba(0,0,0,.55),
      inset 0 3px 0 rgba(255,220,150,.3),
      inset 0 -12px 28px rgba(0,0,0,.6),
      0 0 38px rgba(255,180,60,.22);
  }
  /* 顶部招牌 */
  .fruit-marquee {
    position:relative; text-align:center; margin-bottom:10px; padding:10px 6px;
    border-radius:8px;
    background:linear-gradient(180deg,#3d0710,#7a1019);
    border:2px solid #ffcf3f;
    box-shadow:inset 0 0 16px rgba(0,0,0,.6);
  }
  .fruit-marquee-title {
    font-size:18px; font-weight:900; letter-spacing:2px;
    color:#ffe88a;
    text-shadow:0 2px 0 #8a5a00, 0 0 14px rgba(255,210,80,.75);
  }
  .fruit-marquee-title small { display:block; font-size:10px; letter-spacing:1.5px; color:#ffc2c2; font-weight:600; margin-top:3px; }
  .fruit-marquee-title > span { display:inline-block; width:46%; font-size:14px; letter-spacing:1px; }
  /* 7×7 格子盘 */
  .fruit-grid {
    display:grid; grid-template-columns:repeat(7,minmax(0,1fr)); gap:5px;
    grid-template-rows:repeat(7,minmax(0,1fr));
    padding:9px; border-radius:8px;
    background:linear-gradient(180deg,#2a0609,#16030a);
    border:2px solid #caa23a;
    box-shadow:inset 0 4px 16px rgba(0,0,0,.8);
  }
  /* 经典奖品格子：象牙底 + 金属金边 + 微凹内阴影 */
  .fruit-cell {
    position:relative; aspect-ratio:1/1; border-radius:5px;
    background:linear-gradient(160deg,#fffdf0,#f5ecc8 55%,#e8d8a8);
    border:2px solid #b08a32;
    display:flex; flex-direction:column; align-items:center; justify-content:center; gap:2px;
    box-shadow:
      inset 0 1px 0 rgba(255,255,255,.8),
      inset 0 -2px 5px rgba(120,90,20,.35),
      0 1px 2px rgba(0,0,0,.3);
    transition:transform .08s, box-shadow .1s, border-color .1s, background .1s;
    user-select:none; overflow:hidden; padding:2px 1px;
  }
  .fruit-cell .fc-icon { font-size:56px; line-height:1; display:flex; align-items:center; justify-content:center; }
  .fruit-cell .fc-icon img { width:72px; height:72px; object-fit:contain; filter:drop-shadow(0 1px 2px rgba(0,0,0,.3)); }
  .fruit-cell.cell-none { background:linear-gradient(160deg,#fff3f0,#f5d8d0); border-color:#c0887a; }
  .fruit-cell.cell-none .fc-icon { font-size:46px; }
  /* 跑马灯高亮格：金色发光 */
  .fruit-cell.active {
    border-color:#ffd43b; transform:scale(1.08); z-index:2;
    background:linear-gradient(160deg,#fff6c8,#ffe58a);
    box-shadow:
      0 0 18px rgba(255,210,63,.95),
      inset 0 0 12px rgba(255,210,63,.6),
      inset 0 1px 0 rgba(255,255,255,.9);
  }
  /* 中奖定格：红框闪烁 + 金光 */
  .fruit-cell.hit {
    border-color:#ff3b3b; z-index:3;
    animation:fruit-hit .4s ease-in-out infinite alternate;
  }
  @keyframes fruit-hit {
    from { transform:scale(1.05); box-shadow:0 0 12px rgba(255,77,79,.7); }
    to   { transform:scale(1.16); box-shadow:0 0 30px rgba(255,77,79,1), 0 0 46px rgba(255,210,63,.7); }
  }
  /* 中央主画面（5×5 合并）：深色显示面板 + 大开始按钮 */
  .fruit-core {
    grid-column:2 / 7; grid-row:2 / 7; min-height:120px; border-radius:7px;
    display:flex; flex-direction:column; align-items:center; justify-content:center; gap:6px;
    color:#ffe8a0; text-align:center; overflow:hidden; position:relative;
    background:
      repeating-linear-gradient(90deg, rgba(255,210,80,.04) 0 2px, transparent 2px 4px),
      radial-gradient(circle at 50% 40%, #2a1a08, #0e0703 75%);
    border:2px solid #d5a63c;
    box-shadow:inset 0 0 26px rgba(0,0,0,.85), 0 0 14px rgba(255,190,55,.15);
  }
  .fruit-core::before {
    content:''; position:absolute; inset:6px; border:1px solid rgba(255,210,80,.2);
    border-radius:5px; pointer-events:none;
  }
  .promo-brand { display:flex; align-items:center; gap:8px; color:#ffd870; font-weight:800; letter-spacing:1px; font-size:20px; position:relative; }
  .promo-logo { width:32px; height:32px; object-fit:contain; filter:drop-shadow(0 0 6px rgba(255,200,80,.6)); }
  .fruit-core strong { font-size:26px; letter-spacing:3px; color:#ffe88a; position:relative; text-shadow:0 0 10px rgba(255,210,80,.6); }
  .fruit-core small { color:#b89968; font-size:12px; position:relative; }
  .promo-prizes { display:flex; align-items:center; justify-content:center; gap:14px; margin-top:6px; position:relative; flex-wrap:wrap; }
  .promo-coin { display:flex; flex-direction:column; align-items:center; gap:3px; min-width:40px; color:#e6c986; font-size:11px; font-weight:700; letter-spacing:.5px; }
  .promo-coin img { width:34px; height:34px; object-fit:contain; }
  .promo-device { margin-top:8px; padding:5px 16px; border:1px solid rgba(245,215,120,.4); border-radius:16px; color:#f5d778; font-size:12px; font-weight:600; position:relative; }
  /* 机器下方操作区 */
  .fruit-actions { display:flex; align-items:center; justify-content:center; gap:12px; margin-top:14px; }
  .fruit-start {
    min-width:130px; height:52px; border-radius:8px; cursor:pointer; border:none;
    background:linear-gradient(180deg,#ff6b5e,#e31b23 50%,#a00c14);
    color:#ffe9b0; font-weight:900; font-size:19px; letter-spacing:1px;
    text-shadow:0 2px 3px rgba(80,0,0,.6);
    border:3px solid #ffcf3f;
    box-shadow:0 6px 0 #6e0a13, 0 10px 18px rgba(0,0,0,.5), inset 0 3px 8px rgba(255,255,255,.35);
    transition:transform .08s,box-shadow .08s,filter .15s;
    line-height:1.15;
  }
  .fruit-start small { display:block; font-size:10px; font-weight:700; color:#ffd9d2; letter-spacing:0; margin-top:1px; }
  .fruit-start:active { transform:translateY(4px); box-shadow:0 2px 0 #6e0a13, 0 4px 8px rgba(0,0,0,.5), inset 0 3px 8px rgba(255,255,255,.35); }
  .fruit-start:disabled { filter:grayscale(.45) brightness(.8); cursor:not-allowed; }
  .fruit-ten-btn {
    border:none; border-radius:8px; cursor:pointer;
    padding:11px 22px; font-weight:800; font-size:14px; color:#fff1d0;
    background:linear-gradient(180deg,#b548ff,#7116c9);
    border:3px solid #dca6ff;
    box-shadow:0 6px 0 #4a0c84, 0 10px 18px rgba(0,0,0,.4);
    transition:transform .08s,box-shadow .08s,filter .15s;
    line-height:1.2;
  }
  .fruit-ten-btn small { display:block; font-size:10px; font-weight:600; opacity:.85; margin-top:1px; }
  .fruit-ten-btn:active { transform:translateY(4px); box-shadow:0 2px 0 #4a0c84; }
  .fruit-ten-btn:disabled { filter:grayscale(.5) brightness(.75); cursor:not-allowed; }
  .fruit-machine.spinning .fruit-start,
  .fruit-machine.spinning .fruit-ten-btn { pointer-events:none; }

  .lottery-catalog { margin:0 auto 18px; padding:15px; border:1px solid rgba(80,210,194,.18); border-radius:16px; background:rgba(11,25,24,.72); }
  .lottery-catalog-head { display:flex; align-items:flex-end; justify-content:space-between; gap:10px; margin-bottom:12px; }
  .lottery-catalog-head strong { color:#e7f1ef; font-size:15px; }
  .lottery-catalog-head span { color:#6f8982; font-size:12px; margin-left:8px; }
  .lottery-catalog-head small { color:#748c86; font-size:11px; text-align:right; }
  .lottery-catalog-grid { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:8px; }
  .lottery-catalog-item { min-width:0; min-height:78px; padding:9px 5px 7px; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:3px; border:1px solid #1d3532; border-radius:11px; background:#0e1919; }
  .catalog-icon { height:32px; display:flex; align-items:center; justify-content:center; }
  .catalog-name { width:100%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; text-align:center; color:#d8e5e1; font-size:11px; }
  .lottery-catalog-item small { color:#6b817b; font-size:10px; }

  /* Tabs */
  .lottery-tabs { display:flex; gap:4px; margin-bottom:16px; background:#0e1719; border-radius:10px; padding:4px; border:1px solid #1d2c2e; }
  .lottery-tab {
    flex:1; padding:10px; background:none; border:none; color:#81918e;
    cursor:pointer; font-size:13px; border-radius:8px; transition:all .2s;
  }
  .lottery-tab.active {
    color:#071312; background:#50d2c2; font-weight:600;
  }
  .lottery-tab-content { min-height:120px; }
  .lottery-loading,.lottery-empty { text-align:center; color:#5a6b68; padding:28px; font-size:13px; }

  /* 排行榜 */
  .lottery-lb-table { width:100%; border-collapse:collapse; font-size:13px; }
  .lottery-lb-table th,.lottery-lb-table td { padding:10px 6px; text-align:left; border-bottom:1px solid #1d2c2e; }
  .lottery-lb-table th { color:#81918e; font-weight:normal; font-size:12px; }
  .lb-rank { width:36px; text-align:center; font-weight:bold; }
  .lb-value { color:#50d2c2; text-align:right; font-weight:600; }
  .lb-wallet { font-family:monospace; font-size:12px; color:#74c0fc; }

  /* 中奖记录 */
  .lottery-records { display:flex; flex-direction:column; gap:8px; }
  .rec-item {
    display:flex; justify-content:space-between; align-items:center;
    padding:12px 14px; background:#0e1719; border-radius:10px;
    border:1px solid #1d2c2e;
  }
  .rec-left { flex:1; min-width:0; }
  .rec-prize { font-size:14px; color:#e7f1ef; display:flex; align-items:center; gap:6px; }
  .rec-time { font-size:11px; color:#5a6b68; margin-top:4px; }
  .rec-status { font-size:12px; color:#50d2c2; white-space:nowrap; margin-left:10px; }
  .rec-warn { color:#ffa94d; cursor:pointer; text-decoration:underline; }

  /* ── 二级弹窗（积分任务/社交/地址/中奖结果）叠加在单页之上 ── */
  .lottery-modal-mask {
    position:fixed; inset:0; background:rgba(3,7,8,.75); z-index:9999;
    display:flex; align-items:center; justify-content:center; padding:12px;
    backdrop-filter:blur(4px);
  }
  .lottery-modal {
    background:#10191b; border:1px solid #29413e; border-radius:16px; width:100%; max-width:440px;
    max-height:88vh; overflow-y:auto; box-shadow:0 24px 70px rgba(0,0,0,.6);
    animation:lottery-pop .3s cubic-bezier(.34,1.56,.64,1);
  }
  @keyframes lottery-pop { from{transform:scale(.9);opacity:0} to{transform:scale(1);opacity:1} }
  .lottery-modal-head {
    display:flex; align-items:center; justify-content:space-between;
    padding:16px 20px; border-bottom:1px solid #1d2c2e;
    position:sticky; top:0; background:#10191b; z-index:10; border-radius:16px 16px 0 0;
  }
  .lottery-modal-head h3 { margin:0; font-size:17px; color:#e7f1ef; }
  .lottery-close {
    background:#0e1719; border:1px solid #29413e;
    color:#81918e; font-size:18px; cursor:pointer; width:30px; height:30px;
    border-radius:50%; display:flex; align-items:center; justify-content:center;
    transition:all .2s;
  }
  .lottery-close:hover { border-color:#f26c78; color:#f26c78; }
  .lottery-modal-body { padding:20px; }

  /* 中奖结果 */
  .win-modal { text-align:center; }
  .win-body { padding:28px 20px; }
  .win-emoji { font-size:60px; margin-bottom:10px; animation:win-bounce .6s ease infinite alternate; }
  .win-emoji img { width:64px; height:64px; object-fit:contain; }
  @keyframes win-bounce { from{transform:translateY(0) scale(1)} to{transform:translateY(-10px) scale(1.1)} }
  .win-prize-name { font-size:24px; font-weight:bold; color:#50d2c2; margin-bottom:10px; }
  .win-amount { font-size:20px; color:#ffd43b; margin-bottom:16px; font-weight:700; }
  .win-tip { font-size:13px; color:#81918e; margin-bottom:20px; }

  /* 积分任务列表 */
  .earn-list { display:flex; flex-direction:column; gap:10px; }
  .earn-item {
    display:flex; align-items:center; gap:12px; padding:13px;
    background:#0e1719; border-radius:12px;
    border:1px solid #1d2c2e; transition:all .2s;
  }
  .earn-item:hover { border-color:rgba(80,210,194,.35); }
  .earn-icon { font-size:26px; width:40px; text-align:center; }
  .earn-info { flex:1; }
  .earn-title { font-size:14px; color:#e7f1ef; font-weight:500; }
  .earn-desc { font-size:11px; color:#81918e; margin-top:3px; }
  .earn-pts { font-size:17px; font-weight:bold; color:#50d2c2; }
  .earn-btn {
    padding:7px 16px; border-radius:8px; background:#50d2c2;
    color:#071312; border:none; font-size:12px; cursor:pointer; font-weight:600;
    transition:all .2s;
  }
  .earn-btn:hover { filter:brightness(1.1); }

  .social-hint { font-size:13px; color:#a8b8b5; margin:0 0 10px; line-height:1.6; }
  .social-copy-box { display:flex; gap:8px; margin-bottom:12px; }
  .social-copy-box code {
    flex:1; padding:10px 12px; background:#0b1113; border:1px solid #1d2c2e; border-radius:8px;
    font-size:12px; color:#5bd8c6; word-break:break-all;
  }
  .social-go-btn { display:block; text-align:center; padding:10px; border-radius:8px; text-decoration:none; margin-bottom:12px; }
  .social-upload input[type=file] { display:none; }
  .social-upload-box {
    display:flex; flex-direction:column; align-items:center; justify-content:center; gap:7px;
    width:100%; min-height:110px; padding:18px 12px; background:#0b1113;
    border:2px dashed #29413e; border-radius:12px; cursor:pointer; text-align:center;
    box-sizing:border-box; transition:all .2s;
  }
  .social-upload-box:active { border-color:#50d2c2; background:#0d1517; }
  .social-upload-icon { font-size:34px; line-height:1; }
  .social-upload-box b { font-size:16px; color:#e7f1ef; font-weight:600; }
  .social-upload-box small { font-size:12px; color:#81918e; }
  .lottery-input {
    width:100%; padding:11px 14px; background:#0b1113;
    border:1px solid #29413e; border-radius:10px; color:#e7f1ef;
    margin-bottom:12px; font-size:14px; box-sizing:border-box;
  }
  .lottery-input:focus { outline:none; border-color:#50d2c2; }

  /* 积分明细 */
  .lottery-flows { display:flex; flex-direction:column; gap:8px; }
  .flow-item {
    display:flex; justify-content:space-between; align-items:center;
    padding:12px 14px; background:#0e1719; border-radius:10px; border:1px solid #1d2c2e;
  }
  .flow-left { display:flex; align-items:center; gap:10px; min-width:0; flex:1; }
  .flow-icon { font-size:20px; width:30px; text-align:center; flex-shrink:0; }
  .flow-info { min-width:0; }
  .flow-title { font-size:13.5px; color:#e7f1ef; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .flow-time { font-size:11px; color:#5a6b68; margin-top:3px; }
  .flow-change { font-size:15px; font-weight:700; white-space:nowrap; margin-left:10px; }
  .flow-in { color:#50d2c2; }
  .flow-out { color:#ff8787; }

  /* 彩带 */
  .confetti {
    position:fixed; width:10px; height:10px; top:-10px; z-index:10000;
    pointer-events:none; animation:confetti-fall 3s linear forwards;
  }
  @keyframes confetti-fall { to { transform:translateY(110vh) rotate(720deg); opacity:0; } }

  @media (max-width:600px) {
    .lottery-wrap { padding:2px 0 30px; }
    .lottery-catalog { padding:12px 10px; }
    .lottery-catalog-head { align-items:flex-start; flex-direction:column; }
    .lottery-catalog-head small { text-align:left; }
    .lottery-catalog-grid { grid-template-columns:repeat(3,minmax(0,1fr)); gap:6px; }
    .lottery-catalog-item { min-height:70px; }
    .fruit-machine { padding:11px; border-radius:22px; }
    .fruit-marquee-title { font-size:18px; letter-spacing:2px; }
    .fruit-grid { gap:5px; padding:8px; }
    .fruit-core { min-height:92px; }
    .fruit-core strong { font-size:22px; }
    .promo-coin img { width:30px; height:30px; }
    .promo-coin { font-size:10px; }
    .fruit-cell .fc-icon img { width:88%; height:88%; }
    .fruit-cell .fc-icon { font-size:42px; }
    .fruit-cell.cell-none .fc-icon { font-size:34px; }
    .fruit-start { width:132px; height:48px; font-size:17px; }
    .fruit-start small { font-size:9px; }
  }
  /* 产品化视觉覆写：与站点深色青绿色主题统一 */
  .lottery-wrap { max-width:980px; margin:0 auto; }
  .fruit-machine { max-width:560px; background:linear-gradient(180deg,#122426,#0a1518); border-color:#3ec8b7; box-shadow:0 16px 38px rgba(0,0,0,.42),inset 0 1px 0 rgba(255,255,255,.1),0 0 28px rgba(62,200,183,.12); }
  .fruit-marquee { background:linear-gradient(180deg,#17383a,#102628); border-color:#d4b45c; }
  .fruit-grid { background:#081315; border-color:#2d9e95; }
  .fruit-core { background:radial-gradient(circle at 50% 35%,rgba(62,200,183,.2),transparent 60%),#102628; border-color:#3ec8b7; }
  .fruit-core-mark,.fruit-core strong { color:#65dfce; text-shadow:0 0 14px rgba(62,200,183,.35); }
  .fruit-core small { color:#91bdb7; }
  .fruit-cell { background:linear-gradient(180deg,#f4f7ed,#dfe9df); border-color:rgba(62,200,183,.3); }
  .fruit-start { background:linear-gradient(180deg,#53d6c2,#169b8c); border-color:#a3f1df; box-shadow:0 5px 0 #09645d,0 10px 18px rgba(0,0,0,.35),inset 0 2px 8px rgba(255,255,255,.3); }
  .fruit-actions { gap:10px; }
  .fruit-ten-btn { background:linear-gradient(180deg,#315d68,#1c3b45); border-color:#6cb7bd; box-shadow:0 5px 0 #122a32,0 8px 14px rgba(0,0,0,.35); }
  .lottery-catalog { background:#0d1b1d; border-color:#234b4a; }
  .lottery-catalog-item { background:#102224; border-color:#1f403f; }
  .lottery-tabs { background:#0b1719; border-color:#23403f; }
  .points-board { margin:0 auto 16px; }
  .points-board { background:#0d2022; border-color:#286f69; }
  .pb-left b { color:#71e2d1; }
  .pb-earn { display:flex; align-items:center; gap:5px; border-radius:8px; padding:9px 13px; background:#102b2d; border:1px solid #2c8078; color:#8de8da; cursor:pointer; }
  .pb-earn:hover { background:#173a3c; border-color:#57c9bc; }
  .lottery-section-label { max-width:620px; margin:18px auto 8px; display:flex; align-items:baseline; gap:9px; }
  .lottery-section-label span { color:#e8f5f1; font-size:14px; font-weight:700; }
  .lottery-section-label small { color:#668d87; font-size:11px; }
  .lottery-marquee { background:linear-gradient(90deg,#0e2425,#0c1a1d); border-color:#27524f; }
  .marquee-label { color:#71e2d1; }
  .lottery-catalog-head strong { color:#f0f8f5; }
  .lottery-catalog-head small { color:#779b95; }
  .lottery-catalog-item { transition:transform .18s ease,border-color .18s ease,background .18s ease; }
  .lottery-catalog-item:hover { transform:translateY(-2px); border-color:#3aa99b; background:#142b2d; }
  .fruit-actions { margin-top:16px; }
  .fruit-start { font-size:18px; letter-spacing:2px; }
  .fruit-ten-btn { border-radius:9px; }
  .lottery-tabs { margin-top:22px; }
  .lottery-tab { color:#789b95; }
  .lottery-tab.active { color:#06201d; box-shadow:0 3px 10px rgba(80,210,194,.18); }
  .lottery-tab-content { background:#0b1719; border:1px solid #1b3535; border-radius:12px; padding:12px; }
  @media (max-width:600px) {
    .lottery-wrap { width:100%; }
    .fruit-machine { border-radius:12px; padding:8px; }
    .fruit-grid { gap:4px; padding:6px; }
    .fruit-cell .fc-icon img { width:88%; height:88%; }
    .fruit-core { min-height:84px; }
    .points-board { padding:12px 14px; gap:10px; }
    .pb-left b { font-size:22px; }
    .pb-earn { padding:9px 14px; font-size:12px; }
    .lottery-section-label { margin-top:14px; }
    .lottery-section-label small { display:none; }
    .lottery-tabs { overflow-x:auto; }
    .lottery-tab { min-width:108px; white-space:nowrap; padding:9px 7px; }
    .lottery-tab-content { padding:8px; }
  }
  /* 专业产品化主题：降低赌场感，统一为 AxiX 金融产品界面 */
  .lottery-wrap { max-width:900px; }
  .fruit-machine { max-width:620px; border:1px solid #29504e; border-radius:14px; padding:12px; background:#0b1517; box-shadow:0 18px 42px rgba(0,0,0,.32); }
  .fruit-marquee { margin-bottom:10px; padding:13px 12px; border:1px solid #2b6863; border-radius:9px; background:#10282a; box-shadow:none; }
  .fruit-marquee-title { color:#d9eeea; text-shadow:none; font-size:14px; letter-spacing:.5px; }
  .fruit-marquee-title > span { color:#d9eeea; font-size:13px; }
  .fruit-marquee-title small { color:#789e98; letter-spacing:0; font-weight:500; }
  .fruit-grid { gap:6px; padding:8px; border:1px solid #234542; border-radius:10px; background:#071012; box-shadow:none; }
  .fruit-cell { border:1px solid #2a4847; border-radius:7px; background:linear-gradient(180deg,#172b2d,#102023); box-shadow:inset 0 1px 0 rgba(255,255,255,.05); }
  .fruit-cell .fc-icon img { width:72px; height:72px; object-fit:contain; }
  .lottery-catalog-item .catalog-icon img { width:34px; height:34px; object-fit:contain; }
  .fruit-cell.active { border-color:#51d5c2; box-shadow:0 0 0 2px rgba(81,213,194,.24); transform:none; }
  .fruit-cell.hit { border-color:#f3c969; animation:none; box-shadow:0 0 0 2px rgba(243,201,105,.35); }
  .fruit-core { border:1px solid #2d7c73; border-radius:9px; background:#0e2729; box-shadow:none; }
  .fruit-core::before { inset:7px; border-color:rgba(99,225,208,.18); }
  .promo-glow { opacity:.65; }
  .promo-brand { font-size:18px; }
  .promo-logo { width:30px; height:30px; }
  .fruit-core strong { font-size:23px; color:#d9eeea; text-shadow:none; letter-spacing:2px; }
  .fruit-core small { color:#7ea7a0; }
  .promo-device { color:#d6c27a; border-color:#655d3a; background:rgba(214,194,122,.06); }
  .fruit-start { width:136px; height:46px; border:1px solid #69dfcf; border-radius:8px; background:linear-gradient(180deg,#2db5a5,#168f83); box-shadow:0 3px 0 #126b64,0 8px 16px rgba(0,0,0,.28); color:#f1fffc; text-shadow:none; font-size:16px; }
  .fruit-start:active { box-shadow:0 1px 0 #126b64; }
  .fruit-ten-btn { width:136px; height:46px; padding:0; border:1px solid #69dfcf; border-radius:8px; background:linear-gradient(180deg,#2db5a5,#168f83); box-shadow:0 3px 0 #126b64,0 8px 16px rgba(0,0,0,.28); color:#f1fffc; font-size:16px; font-weight:800; }
  .fruit-ten-btn small { display:block; font-size:10px; font-weight:600; margin-top:2px; opacity:.8; }
  .lottery-catalog { border-radius:12px; background:#0b1719; border-color:#1f3d3c; }
  .lottery-catalog-item { border-radius:8px; background:#101f21; }
  .lottery-catalog-item:hover { transform:none; background:#14292b; }
  .lottery-tabs { border-radius:9px; }
  .lottery-tab.active { background:#2eafa0; color:#071a18; }
  .lottery-tab-content { border-radius:10px; }
  @media (max-width:600px) {
    .fruit-machine { padding:8px; border-radius:11px; max-width:100%; }
    .fruit-marquee { padding:9px 6px; }
    .fruit-marquee-title { font-size:16px; }
    .fruit-marquee-title > span { font-size:11px; }
    .fruit-marquee-title small { font-size:9px; }
    .fruit-grid { gap:4px; padding:7px; }
    .fruit-cell .fc-icon { font-size:33px; }
    .fruit-cell .fc-icon img { width:88%; height:88%; }
    .fruit-cell.cell-none .fc-icon { font-size:28px; }
    .fruit-core { min-height:90px; gap:4px; }
    .promo-brand { font-size:16px; }
    .promo-logo { width:26px; height:26px; }
    .fruit-core strong { font-size:20px; letter-spacing:2px; }
    .fruit-core small { font-size:10px; }
    .promo-coin img { width:28px; height:28px; }
    .promo-coin { font-size:10px; min-width:30px; }
    .promo-device { font-size:11px; padding:4px 14px; }
    .fruit-start { min-width:110px; height:46px; font-size:17px; }
    .fruit-ten-btn { padding:10px 16px; font-size:13px; }
    .points-board { flex-wrap:wrap; }
  }
  `;
  const styleEl = document.createElement('style');
  styleEl.textContent = STYLE;
  document.head.appendChild(styleEl);

  const P = Portal;
  const API = '/api/lottery';
  let configCache = null;
  let pointsCache = 0;
  let mountSeq = 0, pointsReady = false;
  let subTabSeq = 0;
  let currentLotteryTab = 'leaderboard';

  const api = async (path, options) => {
    if (!options?.method || options.method === 'GET') return P.readJSON(`${API}/${path}`, options);
    const res = await fetch(`${API}/${path}`, options);
    let payload;
    try { payload = await res.json(); } catch { throw new Error('服务不可用'); }
    if (!res.ok) throw new Error(payload.error || '请求失败');
    return payload;
  };
  const authApi = async (path, options = {}) => {
    if (!window.currentWalletProfile?.authenticated && window.currentWalletConnection?.address
      && typeof ensurePlatformSession === 'function') {
      try { await ensurePlatformSession(); } catch {}
    }
    if (!window.currentWalletProfile?.authenticated) throw new Error('请先连接钱包');
    return api(path, options);
  };

  const esc = P.esc;
  const shortAddr = (a) => { const s = String(a || ''); return s.length > 10 ? `${s.slice(0, 6)}…${s.slice(-4)}` : s; };
  const fmtMoney = (v) => Number(v || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  // 币奖数量：小额保留更多位，避免 0.0001 ETH 显示成 0.00
  const fmtAmt = (v) => {
    const n = Number(v || 0);
    if (!n) return '0';
    if (n < 0.01) return n.toFixed(8).replace(/0+$/, '').replace(/\.$/, '');
    if (n < 1) return n.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
    return fmtMoney(n);
  };

  // ── 配置 ──────────────────────────────────────────────────────
  async function loadConfig() {
    if (configCache) return configCache;
    configCache = await api('config');
    // 预加载奖品图片（币种 logo + 显卡等），加载完成后重绘转盘
    const ids = (configCache.prizes || []).map(p => p.id).filter(id => COIN_IMG[id] || PRIZE_IMG[id]);
    let pending = new Set(ids);
    for (const id of ids) {
      const im = getPrizeImg(id);
      if (im.complete) { pending.delete(id); continue; }
      im.onload = () => {
        pending.delete(id);
        if (!pending.size && document.getElementById('fruit-grid')) renderFruitCells();
      };
    }
    return configCache;
  }

  // ── 积分数据 & 明细（供 AxiX矿机-积分子页 / 抽奖页明细 tab 共用） ──
  async function fetchPoints() {
    if (!window.currentWalletProfile?.authenticated && window.currentWalletConnection?.address
      && typeof ensurePlatformSession === 'function') {
      try { await ensurePlatformSession(); } catch {}
    }
    if (!window.currentWalletProfile?.authenticated) return { points: 0, flows: [], authed: false };
    try {
      const data = await authApi('points');
      return { points: data.points || 0, flows: data.flows || [], authed: true };
    } catch { return { points: null, flows: [], authed: true, error:true }; }
  }

  function flowItemHtml(f) {
    const meta = FLOW_META[f.type] || { icon: '•', label: f.note || '积分变动' };
    const change = Number(f.change || 0);
    const positive = change >= 0;
    const title = f.note || meta.label;
    const balanceTxt = (f.balance !== null && f.balance !== undefined) ? ` · 余额 ${Number(f.balance).toLocaleString()}` : '';
    return `<div class="flow-item">
      <div class="flow-left">
        <span class="flow-icon">${meta.icon}</span>
        <div class="flow-info">
          <div class="flow-title">${esc(title)}</div>
          <div class="flow-time">${new Date(f.createdAt).toLocaleString('zh-CN')}${balanceTxt}</div>
        </div>
      </div>
      <div class="flow-change ${positive ? 'flow-in' : 'flow-out'}">${positive ? '+' : ''}${Number(change).toLocaleString()}</div>
    </div>`;
  }

  function flowsListHtml(flows) {
    if (!flows || !flows.length) return '<div class="lottery-empty">暂无积分记录</div>';
    return `<div class="lottery-flows">${flows.map(flowItemHtml).join('')}</div>`;
  }

  // 「积分」主导航页 = 抽奖单页：积分条 + 中奖公告 + 方形水果机 + 排行榜/记录/明细
  window.lotteryMountPointsHome = async function(container, context = { isCurrent:() => true }) {
    if (!container) return;
    container.innerHTML = '<div class="lottery-loading">加载中...</div>';
    const seq = ++mountSeq, wallet = P.walletKey();
    const valid = () => seq === mountSeq && wallet === P.walletKey() && context.isCurrent();
    pointsReady = false;
    const configPromise = loadConfig();
    const pointsPromise = fetchPoints();
    const data = { points:0, authed:Boolean(window.currentWalletProfile?.authenticated) };
    const authed = data.authed;
    spinning = false;
    container.innerHTML = `
      <div class="lottery-wrap">
        <div id="lottery-data-status"></div>
        ${authed ? '' : '<div style="margin-bottom:12px;font-size:12px;color:#ffd43b">连接钱包后即可抽奖、查看积分明细</div>'}
        <!-- 积分卡（置顶） -->
        <div class="points-board">
          <div class="pb-left"><span class="pb-label">我的积分</span><b id="lottery-pts-num">${Number(data.points).toLocaleString()}</b><small>单抽 10 积分 · 十连抽 100 积分</small></div>
          <button class="pb-earn" onclick="openEarnPointsModal()">🎯 赚取积分</button>
        </div>
        <!-- 中奖公告（两行滚动） -->
        <div class="lottery-marquee">
          <div class="marquee-label">中奖公告</div>
          <div class="marquee-track">
            <div class="marquee-inner" id="marquee-inner">
              <div class="marquee-placeholder">期待你成为下一位幸运儿</div>
            </div>
          </div>
        </div>
        <!-- 经典方形老虎机 -->
        <div class="lottery-section-label"><span>幸运抽奖</span><small>选择单抽或十连抽，奖品随机发放</small></div>
        <div class="fruit-machine" id="fruit-machine">
          <div class="fruit-marquee">
            <div class="fruit-marquee-title"><span>AxiX REWARDS</span><span>积分抽奖</span><small>每次抽奖消耗 10 积分 · 奖品随机发放</small></div>
          </div>
          <div class="fruit-grid" id="fruit-grid">${fruitGridHtml()}</div>
          <div class="fruit-actions">
            <button type="button" class="fruit-start" id="fruit-start" onclick="doDraw(1)">开始<small>10 积分</small></button>
            <button type="button" class="fruit-ten-btn" id="fruit-ten-btn" onclick="doDraw(10)">10 连抽<small>100 积分</small></button>
          </div>
        </div>
        ${prizeCatalogHtml()}
        <!-- Tab 切换 -->
        <div class="lottery-tabs">
          <button class="lottery-tab ${currentLotteryTab === 'leaderboard' ? 'active' : ''}" data-tab="leaderboard" onclick="switchLotteryTab('leaderboard')">🏅 中奖排行榜</button>
          <button class="lottery-tab ${currentLotteryTab === 'records' ? 'active' : ''}" data-tab="records" onclick="switchLotteryTab('records')">📋 我的中奖记录</button>
          <button class="lottery-tab ${currentLotteryTab === 'points' ? 'active' : ''}" data-tab="points" onclick="switchLotteryTab('points')">💰 积分明细</button>
        </div>
        <div class="lottery-tab-content" id="lottery-tab-content">
          <div class="lottery-loading">加载中...</div>
        </div>
      </div>`;
    renderFruitCells();
    document.getElementById('lottery-pts-num').textContent = '加载中';
    setFruitDisabled(true);
    if (P.active('points')) loadMarquee();
    startIdleBlink();
    switchLotteryTab(currentLotteryTab);
    await Promise.all([
      configPromise.then(() => { if (valid()) { renderFruitCells(); setFruitDisabled(!pointsReady); } }).catch(error => {
        if (valid()) document.getElementById('lottery-data-status').insertAdjacentHTML('beforeend', P.error(error.message, "Portal.load('points',true)"));
      }),
      pointsPromise.then(next => {
        if (!valid()) return;
        pointsCache = next.points;
        pointsReady = next.authed && !next.error;
        document.getElementById('lottery-pts-num').textContent = next.error ? '加载失败' : Number(next.points).toLocaleString();
        if (next.error) document.getElementById('lottery-data-status').insertAdjacentHTML('beforeend', P.error('积分加载失败', "Portal.load('points',true)"));
        setFruitDisabled(!pointsReady || !configCache);
      }),
    ]);
  };
  window.lotteryRefreshPoints = fetchPoints;
  window.lotteryFlowsListHtml = flowsListHtml;

  // ── 方形水果机：外圈跑马灯（顺时针加速→减速→定格） ─────────────
  let spinning = false;
  let activeCell = -1;
  let idleTimer = null;

  function setActive(i) {
    activeCell = i;
    document.querySelectorAll('#fruit-grid .fruit-cell').forEach(c => c.classList.toggle('active', Number(c.dataset.idx) === i));
  }

  // 待机 attract：灯光停在头奖 BTC（上排正中）
  function startIdleBlink() {
    stopIdleBlink();
    const target = DISPLAY_PRIZES.indexOf('btc');
    setActive(target >= 0 ? target : 0);
  }
  function stopIdleBlink() { if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; } }

  function startMarqueeTimer() {
    if (window._marqueeTimer) clearInterval(window._marqueeTimer);
    window._marqueeTimer = setInterval(() => { if (P.active('points')) loadMarquee(); }, 10000);
  }

  function setFruitDisabled(disabled) {
    document.getElementById('fruit-machine')?.classList.toggle('spinning', disabled && spinning);
    const start = document.getElementById('fruit-start');
    const ten = document.getElementById('fruit-ten-btn');
    if (start) {
      start.disabled = disabled;
      start.innerHTML = spinning ? '转动中<small>SPIN</small>' : '开始<small>10 积分</small>';
    }
    if (ten) {
      ten.disabled = disabled;
      ten.innerHTML = spinning ? '转动中…' : '10 连抽<small>100 积分</small>';
    }
  }

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  // 跑马灯：外圈高亮顺时针跑 3~4 圈，末段减速，最终停在中奖格
  async function runFruitSpin(targetPrizeId, isWin) {
    const grid = document.getElementById('fruit-grid');
    if (!grid) return;
    grid.querySelectorAll('.fruit-cell').forEach(c => c.classList.remove('active', 'hit'));
    // 恢复固定展示位，再决定停止格
    cellPrizeIds = DISPLAY_PRIZES.slice();
    let stopIdx = cellPrizeIds.indexOf(targetPrizeId);
    if (stopIdx === -1) {
      // 奖品不在 8 个展示位中（或未中奖）：随机选停止格，停下时展示真实结果
      stopIdx = Math.floor(Math.random() * DISPLAY_PRIZES.length);
      cellPrizeIds[stopIdx] = targetPrizeId;
    }
    const slotCount = DISPLAY_PRIZES.length;
    // 固定从顶部起步，按顺时针外圈路径完整走圈，用户能清楚看到每一圈。
    const startFrom = 0;
    const loops = 4;
    const pathStop = Math.max(0, SPIN_PATH.indexOf(stopIdx));
    const totalSteps = loops * slotCount + pathStop;
    let pathPos = 0;
    const SLOW_ZONE = slotCount + 8; // 最后一整圈加 8 格逐步减速
    for (let s = 0; s <= totalSteps; s++) {
      // 尚在高速段时把目标格换成真实奖品，肉眼基本无感知
      if (s === totalSteps - slotCount) renderFruitCells();
      setActive(SPIN_PATH[pathPos]);
      const left = totalSteps - s;
      const progress = Math.max(0, Math.min(1, (SLOW_ZONE - left) / SLOW_ZONE));
      const delay = left < SLOW_ZONE
        ? Math.round(80 + Math.pow(progress, 2.35) * 520)
        : 78 + Math.floor(Math.random() * 16);
      await sleep(delay);
      pathPos = (pathPos + 1) % slotCount;
    }
    setActive(stopIdx);
    const hitCell = grid.querySelector(`.fruit-cell[data-idx="${stopIdx}"]`);
    if (isWin && hitCell) {
      hitCell.classList.add('hit');
      await sleep(1250);
      hitCell.classList.remove('hit');
    } else {
      await sleep(500);
    }
    hitCell?.classList.remove('active');
  }

  window.switchLotteryTab = function(tab) {
    currentLotteryTab = tab;
    const seq = ++subTabSeq, wallet = P.walletKey();
    document.querySelectorAll('.lottery-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
    const host = document.getElementById('lottery-tab-content');
    if (!host) return;
    const context = { isCurrent:() => seq === subTabSeq && wallet === P.walletKey() && host.isConnected };
    if (tab === 'leaderboard') loadLeaderboard(host, context);
    else if (tab === 'points') loadPointsFlows(host, context);
    else loadMyRecords(host, context);
  };

  // 积分明细 tab（含直推获得、抽奖消耗等全部流水）
  async function loadPointsFlows(host, context) {
    host.innerHTML = '<div class="lottery-loading">加载中...</div>';
    const data = await fetchPoints();
    if (!context.isCurrent()) return;
    if (data.error) { host.innerHTML = P.error('积分加载失败', "switchLotteryTab('points')"); return; }
    if (!data.authed) { host.innerHTML = '<div class="lottery-empty">连接钱包后查看积分记录</div>'; return; }
    host.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
        <div style="font-size:13px;color:#9db8b2">当前积分 <b style="color:#50d2c2;font-size:17px">${Number(data.points).toLocaleString()}</b></div>
        <button class="portal-button" style="padding:6px 14px" onclick="openEarnPointsModal()">🎁 积分任务</button>
      </div>
      ${flowsListHtml(data.flows)}`;
  }

  async function loadLeaderboard(host, context) {
    try {
      const data = await api('leaderboard?days=7');
      if (!context.isCurrent()) return;
      const wins = (data.wins || []).slice(0, 10);
      if (!wins.length) { host.innerHTML = '<div class="lottery-empty">暂无中奖记录</div>'; return; }
      host.innerHTML = `<table class="lottery-lb-table"><thead><tr><th>#</th><th>钱包</th><th>奖品</th><th>价值</th></tr></thead><tbody>
        ${wins.map((w, i) => `<tr>
          <td class="lb-rank">${i < 3 ? ['🥇','🥈','🥉'][i] : i + 1}</td>
          <td class="lb-wallet">${esc(shortAddr(w.wallet))}</td>
          <td style="display:flex;align-items:center;gap:6px">${prizeIconHtml(w.prizeId, 20)}<span>${esc(w.prizeName)}${w.symbol ? ` ${fmtAmt(w.amount)} ${w.symbol}` : ''}</span></td>
          <td class="lb-value">$${fmtMoney(w.valueUsdt)}</td>
        </tr>`).join('')}
      </tbody></table>`;
    } catch (e) { if (context.isCurrent()) host.innerHTML = '<div class="lottery-empty">加载失败</div>'; }
  }

  async function loadMyRecords(host, context) {
    try {
      const data = await authApi('wins');
      if (!context.isCurrent()) return;
      const wins = data.wins || [];
      if (!wins.length) { host.innerHTML = '<div class="lottery-empty">暂无中奖记录</div>'; return; }
      host.innerHTML = `<div class="lottery-records">
        ${wins.map(w => {
          const statusText = w.prizeType === 'none' ? '谢谢参与'
            : w.prizeType === 'physical'
              ? (w.status === 'pending_address' ? '<span class="rec-warn" onclick="fillAddress(\'' + w.id + '\')">待填地址</span>'
                : w.status === 'pending_ship' ? '待发货'
                : w.status === 'shipped' ? `已发货 ${w.trackingNo || ''}` : w.status)
              : '已到账';
          const icon = prizeIconHtml(w.prizeId, 22);
          return `<div class="rec-item">
            <div class="rec-left">
              <div class="rec-prize"><span>${icon}</span> ${esc(w.prizeName)}${w.symbol ? ` ${fmtAmt(w.amount)} ${w.symbol}` : ''}</div>
              <div class="rec-time">${new Date(w.createdAt).toLocaleString('zh-CN')}</div>
            </div>
            <div class="rec-status">${statusText}</div>
          </div>`;
        }).join('')}
      </div>`;
    } catch (e) { if (context.isCurrent()) host.innerHTML = '<div class="lottery-empty">加载失败</div>'; }
  }

  // ── 积分任务弹窗 ────────────────────────────────────────────────
  window.openEarnPointsModal = function() {
    const cfg = configCache || { pointRules: {} };
    const r = cfg.pointRules || {};
    const html = `
      <div class="lottery-modal-mask" onclick="closeLotteryModal(event)">
        <div class="lottery-modal" onclick="event.stopPropagation()">
          <div class="lottery-modal-head">
            <h3>🎁 积分任务</h3>
            <button class="lottery-close" onclick="closeLotteryModal()">✕</button>
          </div>
          <div class="lottery-modal-body">
            <div class="earn-list">
              <div class="earn-item">
                <div class="earn-icon">⛏️</div>
                <div class="earn-info">
                  <div class="earn-title">自己激活 Mini 矿机（0.002 BNB）</div>
                  <div class="earn-desc">激活后获得 ${r.self_activate_plan1 || 10} 积分</div>
                </div>
                <div class="earn-pts">+${r.self_activate_plan1 || 10}</div>
              </div>
              <div class="earn-item">
                <div class="earn-icon">👑</div>
                <div class="earn-info">
                  <div class="earn-title">自己激活 Pro 矿机（0.05 BNB）</div>
                  <div class="earn-desc">激活后获得 ${r.self_activate_plan2 || 300} 积分</div>
                </div>
                <div class="earn-pts">+${r.self_activate_plan2 || 300}</div>
              </div>
              <div class="earn-item">
                <div class="earn-icon">👥</div>
                <div class="earn-info">
                  <div class="earn-title">邀请好友激活 Mini 矿机</div>
                  <div class="earn-desc">好友激活后你获得 ${r.direct_activate_plan1 || 10} 积分</div>
                </div>
                <div class="earn-pts">+${r.direct_activate_plan1 || 10}</div>
              </div>
              <div class="earn-item">
                <div class="earn-icon">👥</div>
                <div class="earn-info">
                  <div class="earn-title">邀请好友激活 Pro 矿机</div>
                  <div class="earn-desc">好友激活后你获得 ${r.direct_activate_plan2 || 100} 积分</div>
                </div>
                <div class="earn-pts">+${r.direct_activate_plan2 || 100}</div>
              </div>
              <div class="earn-item">
                <div class="earn-icon">🐦</div>
                <div class="earn-info">
                  <div class="earn-title">发推特推广</div>
                  <div class="earn-desc">每日 1 次，截图审核通过得 ${r.social_twitter || 10} 积分</div>
                </div>
                <button class="earn-btn" onclick="openSocialModal('twitter')">去发布</button>
              </div>
              <div class="earn-item">
                <div class="earn-icon">📢</div>
                <div class="earn-info">
                  <div class="earn-title">发朋友圈推广</div>
                  <div class="earn-desc">每日 1 次，截图审核通过得 ${r.social_moments || 10} 积分</div>
                </div>
                <button class="earn-btn" onclick="openSocialModal('moments')">去发布</button>
              </div>
            </div>
          </div>
        </div>
      </div>`;
    showModal(html);
  };

  // ── 社交推广弹窗 ──────────────────────────────────────────────
  // 与平台推荐页完全一致的专属链接（/api/referrals/profile 的 link）
  async function getPlatformRefLink() {
    if (!window.currentWalletProfile?.authenticated && window.currentWalletConnection?.address
      && typeof ensurePlatformSession === 'function') {
      try { await ensurePlatformSession(); } catch {}
    }
    if (!window.currentWalletProfile?.authenticated) return '';
    try {
      const res = await fetch('/api/referrals/profile');
      const data = await res.json();
      if (data?.link) return `${location.origin}${data.link}`;
      if (data?.code) return `${location.origin}/?ref=${data.code}`;
    } catch {}
    return '';
  }

  window.openSocialModal = async function(platform) {
    if (!window.currentWalletProfile?.authenticated && window.currentWalletConnection?.address
      && typeof ensurePlatformSession === 'function') {
      try { await ensurePlatformSession(); } catch {}
    }
    if (!window.currentWalletProfile?.authenticated) { showToast('请先连接钱包', 'error'); return; }
    const isTwitter = platform === 'twitter';
    const buildText = (refLink) => {
      const tail = refLink ? ` ${refLink}` : '';
      const introduction = window.I18n?.t('加入 AxiX Exchange，激活矿机每日产出 AIX！') || '加入 AxiX Exchange，激活矿机每日产出 AIX！';
      return isTwitter
        ? `${introduction}${tail} #AxiX #AIX`
        : `${introduction}${tail}`;
    };
    const html = `
      <div class="lottery-modal-mask" onclick="closeLotteryModal(event)">
        <div class="lottery-modal" onclick="event.stopPropagation()">
          <div class="lottery-modal-head">
            <h3>${isTwitter ? '🐦 推特推广' : '📢 朋友圈推广'}</h3>
            <button class="lottery-close" onclick="closeLotteryModal()">✕</button>
          </div>
          <div class="lottery-modal-body">
            <p class="social-hint">① 复制下方文案，${isTwitter ? '点击下方按钮跳转推特发布' : '打开朋友圈发布'}</p>
            <div class="social-copy-box">
              <code id="social-text-code">${window.I18n?.t('链接获取中…') || '链接获取中…'}</code>
              <button class="portal-button primary" onclick="copySocialText(this)">复制</button>
            </div>
            ${isTwitter ? `<a id="social-go-twitter" href="#" target="_blank" class="portal-button primary social-go-btn">🚀 去推特发布</a>` : ''}
            <p class="social-hint" style="margin-top:16px">② 发布后截图上传，审核通过得 10 积分（每日限 1 次）</p>
            <div class="social-upload">
              <label class="social-upload-box" for="social-screenshot">
                <span class="social-upload-icon">📷</span>
                <b id="social-upload-title">点击上传截图</b>
                <small>支持 JPG / PNG 图片</small>
              </label>
              <input type="file" id="social-screenshot" accept="image/*" onchange="previewSocialImg(this)">
              <img id="social-preview" style="display:none;max-width:100%;border-radius:8px;margin-top:8px">
            </div>
            <button class="portal-button primary" style="width:100%;margin-top:16px" onclick="submitSocial('${platform}')">提交审核</button>
          </div>
        </div>
      </div>`;
    showModal(html);
    const refLink = await getPlatformRefLink();
    const updateText = () => {
      const codeEl = document.getElementById('social-text-code');
      if (!codeEl) { window.removeEventListener('languagechange', updateText); return; }
      const text = buildText(refLink);
      window._socialText = text;
      codeEl.textContent = text;
      const goEl = document.getElementById('social-go-twitter');
      if (goEl) goEl.href = `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}`;
    };
    updateText();
    socialLanguageListener = updateText;
    window.addEventListener('languagechange', updateText);
  };

  window.copySocialText = function(btn) {
    const text = window._socialText || '';
    navigator.clipboard?.writeText(text).then(() => {
      const orig = btn.textContent;
      btn.textContent = '已复制';
      setTimeout(() => btn.textContent = orig, 1500);
    });
  };

  window.previewSocialImg = function(input) {
    const file = input.files?.[0];
    if (!file) return;
    const title = document.getElementById('social-upload-title');
    if (title) title.textContent = `已选择：${file.name}（点击可更换）`;
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = document.getElementById('social-preview');
      img.src = e.target.result;
      img.style.display = 'block';
      window._socialImg = e.target.result;
    };
    reader.readAsDataURL(file);
  };

  window.submitSocial = async function(platform) {
    if (!window._socialImg) { showToast('请先上传截图', 'error'); return; }
    try {
      await authApi('social/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ platform, screenshotUrl: window._socialImg }),
      });
      showToast('提交成功，等待审核', 'ok');
      closeLotteryModal();
    } catch (e) { showToast(e.message || '提交失败', 'error'); }
  };

  // ── 收件地址弹窗 ──────────────────────────────────────────────
  window.fillAddress = function(winId) {
    const html = `
      <div class="lottery-modal-mask" onclick="closeLotteryModal(event)">
        <div class="lottery-modal" onclick="event.stopPropagation()">
          <div class="lottery-modal-head"><h3>📦 填写收件地址</h3><button class="lottery-close" onclick="closeLotteryModal()">✕</button></div>
          <div class="lottery-modal-body">
            <input id="addr-name" placeholder="收件人姓名" class="lottery-input">
            <input id="addr-phone" placeholder="联系电话" class="lottery-input">
            <textarea id="addr-detail" placeholder="详细地址（省市区+街道门牌）" class="lottery-input" rows="3"></textarea>
            <button class="portal-button primary" style="width:100%;margin-top:8px" onclick="submitAddress('${winId}')">提交地址</button>
          </div>
        </div>
      </div>`;
    showModal(html);
  };

  window.submitAddress = async function(winId) {
    const name = document.getElementById('addr-name').value.trim();
    const phone = document.getElementById('addr-phone').value.trim();
    const detail = document.getElementById('addr-detail').value.trim();
    if (!name || !phone || !detail) { showToast('请填写完整', 'error'); return; }
    try {
      await authApi(`wins/${winId}/address`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, phone, detail }),
      });
      showToast('地址已提交，等待发货', 'ok');
      closeLotteryModal();
      switchLotteryTab('records');
    } catch (e) { showToast(e.message || '提交失败', 'error'); }
  };

  // ── 抽奖（驱动外圈跑马灯） ────────────────────────────────────
  window.doDraw = async function(count) {
    if (!pointsReady || !configCache) return showToast('请等待积分和奖品加载完成', 'error');
    if (spinning) return;
    spinning = true;
    setFruitDisabled(true);
    try {
      const endpoint = count === 10 ? 'draw-ten' : 'draw';
      const data = await authApi(endpoint, { method: 'POST' });
      const wins = data.wins || (data.win ? [data.win] : []);
      if (!wins.length) throw new Error('抽奖失败');
      // 1连抽停在所中奖品；10连抽停在最优奖品（全谢谢参与则停在谢谢参与）
      const best = wins.find(x => x.prizeType !== 'none');
      const stopPrizeId = count === 1 ? wins[0].prizeId : (best?.prizeId || 'none');
      const isWin = !!(count === 1 ? wins[0].prizeType !== 'none' : best);
      await runFruitSpin(stopPrizeId, isWin);
      // 恢复固定展示位
      cellPrizeIds = DISPLAY_PRIZES.slice();
      renderFruitCells();
      spinning = false;
      setFruitDisabled(false);
      showWinResult(wins);
    } catch (e) {
      spinning = false;
      setFruitDisabled(false);
      showToast(e.message || '抽奖失败，请重试', 'error');
    }
  };

  async function showWinResult(wins) {
    try {
      const data = await authApi('points');
      pointsCache = data.points || 0;
      const numEl = document.getElementById('lottery-pts-num');
      if (numEl) numEl.textContent = pointsCache;
    } catch {}

    if (wins.length === 1) {
      const w = wins[0];
      const icon = prizeIconHtml(w.prizeId, 64);
      const html = `
        <div class="lottery-modal-mask" onclick="closeLotteryModal(event)">
          <div class="lottery-modal" style="max-width:380px" onclick="event.stopPropagation()">
            <div class="lottery-modal-head"><h3>🎉 抽奖结果</h3><button class="lottery-close" onclick="closeLotteryModal()">✕</button></div>
            <div class="lottery-modal-body win-body win-modal">
              <div class="win-emoji">${icon}</div>
              <div class="win-prize-name">${esc(w.prizeName)}</div>
              ${w.symbol ? `<div class="win-amount">${fmtAmt(w.amount)} ${w.symbol}</div>` : ''}
              ${w.prizeType === 'crypto' ? '<div class="win-tip">✓ 已发放至平台钱包余额</div>' : ''}
              ${w.prizeType === 'none' ? '<div class="win-tip">再接再厉，好运马上来！</div>' : ''}
              ${w.prizeType === 'physical'
                ? `<button class="portal-button primary" style="width:100%" onclick="fillAddress('${w.id}')">填写收件地址</button>`
                : `<button class="portal-button primary" style="width:100%" onclick="closeLotteryModal()">确定</button>`}
            </div>
          </div>
        </div>`;
      showModal(html);
      if (w.prizeType !== 'none') launchConfetti();
    } else {
      // 10 连抽：全部 10 次明细，中奖的置顶高亮，谢谢参与灰显
      const sorted = [...wins].sort((a, b) => (a.prizeType !== 'none' ? -1 : 1) - (b.prizeType !== 'none' ? -1 : 1));
      const hitCount = wins.filter(w => w.prizeType !== 'none').length;
      const rows = sorted.map(w => {
        const icon = prizeIconHtml(w.prizeId, 22);
        const win = w.prizeType !== 'none';
        return `<div class="rec-item" style="${win ? 'background:rgba(80,210,194,.08);border-radius:8px' : 'opacity:.45'}">
          <div class="rec-left"><div class="rec-prize"><span>${icon}</span> ${esc(w.prizeName)}${w.symbol ? ` ${fmtAmt(w.amount)} ${w.symbol}` : ''}</div></div>
          <div class="rec-status">${win ? (w.prizeType === 'physical' ? '<span class="rec-warn">待填地址</span>' : '<span style="color:#50d2c2">中奖</span>') : '谢谢参与'}</div>
        </div>`;
      }).join('');
      const html = `
        <div class="lottery-modal-mask" onclick="closeLotteryModal(event)">
          <div class="lottery-modal" onclick="event.stopPropagation()">
            <div class="lottery-modal-head"><h3>🎰 10连抽结果</h3><button class="lottery-close" onclick="closeLotteryModal()">✕</button></div>
            <div class="lottery-modal-body">
              <div style="text-align:center;margin-bottom:14px;color:#50d2c2;font-size:14px">10 次抽奖完成，其中 ${hitCount} 次中奖</div>
              <div class="lottery-records">${rows}</div>
            </div>
          </div>
        </div>`;
      showModal(html);
      if (hitCount > 0) launchConfetti();
    }
    loadMarquee();
  }

  function launchConfetti() {
    const colors = ['#50d2c2', '#ffd43b', '#74c0fc', '#9775fa', '#f783ac', '#63e6be'];
    for (let i = 0; i < 50; i++) {
      const el = document.createElement('div');
      el.className = 'confetti';
      el.style.left = Math.random() * 100 + 'vw';
      el.style.background = colors[Math.floor(Math.random() * colors.length)];
      el.style.animationDelay = Math.random() * 0.5 + 's';
      el.style.animationDuration = (2 + Math.random() * 2) + 's';
      if (Math.random() > 0.5) el.style.borderRadius = '50%';
      document.body.appendChild(el);
      setTimeout(() => el.remove(), 4000);
    }
  }

  // ── 滚动公告 ──────────────────────────────────────────────────
  async function loadMarquee() {
    try {
      const data = await api('recent');
      const wins = data.wins || [];
      const inner = document.getElementById('marquee-inner');
      if (!inner) return;
      if (!wins.length) { inner.innerHTML = '<div class="marquee-placeholder">期待你成为下一位幸运儿</div>'; return; }
      const items = wins.slice(0, 20).map(w => {
        const amt = w.symbol ? ` ${fmtAmt(w.amount)} ${w.symbol}` : '';
        return `<div class="marquee-item">🎉 恭喜 <span class="marquee-wallet">${esc(shortAddr(w.wallet))}</span> 抽到 <b>${esc(w.prizeName)}</b>${amt}</div>`;
      }).join('');
      inner.innerHTML = items + items;
    } catch {}
  }

  // ── 二级弹窗工具（不关闭抽奖主页） ────────────────────────────
  function showModal(html) {
    closeLotteryModal();
    const div = document.createElement('div');
    div.id = 'lottery-modal-root';
    div.innerHTML = html;
    document.body.appendChild(div);
  }
  window.closeLotteryModal = function(e) {
    if (e && e.target !== e.currentTarget) return;
    if (socialLanguageListener) window.removeEventListener('languagechange', socialLanguageListener);
    socialLanguageListener = null;
    document.getElementById('lottery-modal-root')?.remove();
  };

  // ── 独立「积分」主导航页 ───────────────────────────────────────
  P.register('points', {
    render() {
      const panel = document.getElementById('tab-points');
      if (!panel) return;
      panel.innerHTML = `<div class="portal-shell">${P.header('积分抽奖', '10 积分抽一次，BTC、ETH、BNB、USDT 与手机大奖等你拿')}<div id="points-content"></div></div>`;
    },
    load(context) {
      const host = document.getElementById('points-content');
      if (host) return window.lotteryMountPointsHome(host, context);
    },
    activate:startMarqueeTimer,
    deactivate() { clearInterval(window._marqueeTimer); window._marqueeTimer = null; stopIdleBlink(); },
    reset() { ++subTabSeq; ++mountSeq; pointsReady = false; pointsCache = 0; }
  });
})();
