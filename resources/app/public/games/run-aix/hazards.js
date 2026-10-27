// V3 障碍目录。原有六张 PNG 保留，新障碍由 art.js 独立绘制。
// behavior 控制玩法；impact 控制角色受击、粒子和对应的合成音效。
export const HAZARDS = Object.freeze([
  { id: 'btc', name: 'BTC 巨币砸顶', color: '#ffc058', behavior: 'block', impact: 'crush', minDistance: 0, line: '冲太猛，被 BTC 砸了个包，失败！' },
  { id: 'eth', name: 'ETH 菱晶绊脚', color: '#b7a2ff', behavior: 'block', impact: 'trip', minDistance: 0, line: '不好意思，被 ETH 绊倒了。' },
  { id: 'bnb', name: 'BNB 黄箱天降', color: '#ffe36c', behavior: 'block', impact: 'crush', minDistance: 0, line: '被 BNB 黄箱拍地上了。' },
  { id: 'ghost', name: 'FTM 鬼影', color: '#6ef2e3', behavior: 'block', impact: 'freeze', minDistance: 20, line: '被 FTM 鬼影飘了一下。' },
  { id: 'hole', name: '黑洞销毁', color: '#e496ff', behavior: 'block', impact: 'spin', minDistance: 40, line: '跑着跑着，被黑洞吸进去销毁了。' },
  { id: 'spike', name: '一根大插针', color: '#ff829c', behavior: 'block', impact: 'launch', minDistance: 0, line: '被插针爆了。' },
  { id: 'ltc', name: 'LTC 快银飞弹', color: '#d4e7ff', behavior: 'sweep', impact: 'trip', minDistance: 15, warningDistance: 34, line: '被 LTC 闪了一下，遗憾退场。' },
  { id: 'sol', name: 'SOL 卡顿地刺怪', color: '#9d84ff', behavior: 'block', impact: 'trip', minDistance: 55, line: '网络拥堵，SOL 宕机把你送走了。' },
  { id: 'xrp', name: 'XRP 水龙卷', color: '#8ae8ff', behavior: 'sweep', impact: 'launch', minDistance: 65, line: '被 XRP 水龙卷卷走了。' },
  { id: 'doge', name: 'DOGE 柴犬冲撞队', color: '#edbc72', behavior: 'sweep', impact: 'launch', minDistance: 25, line: '被 DOGE 柴犬大军撞翻了。' },
  { id: 'usdt', name: 'USDT 暴风雪', color: '#69dfbb', behavior: 'weather', impact: 'freeze', minDistance: 90, line: '天上降下 USDT 暴风雪，被砸没了。' },
  { id: 'dai', name: 'DAI 冰冻法师', color: '#9adfff', behavior: 'weather', impact: 'freeze', minDistance: 75, line: '被 DAI 冻成冰棍了。' },
  { id: 'gas', name: 'Gas 泥潭火怪', color: '#ffad65', behavior: 'slow', impact: 'trip', minDistance: 80, slowDuration: 1.8, line: 'Gas 太高，跑不动了。' },
  { id: 'whale', name: '巨鲸摆尾', color: '#83b7ff', behavior: 'sweep', impact: 'launch', minDistance: 140, line: '被鲸尾拍飞出屏了。' },
  { id: 'bear', name: '熊市巨熊', color: '#c1b9d2', behavior: 'block', impact: 'crush', minDistance: 110, line: '被熊掌拍地上了。' },
  { id: 'liquidation', name: '清算机器人激光', color: '#ff7895', behavior: 'sweep', impact: 'freeze', minDistance: 180, line: '碰到清算机器人的激光，被清算了。' },
].map(hazard => Object.freeze({ warningDistance: 56, ...hazard })));

export const HAZARD_BY_ID = Object.freeze(Object.fromEntries(HAZARDS.map(hazard => [hazard.id, hazard])));

export function hazardPhase(obstacle) {
  if (obstacle.passed || obstacle.ahead < 0) return 'dissolve';
  if (obstacle.ahead <= 8) return 'hit';
  if (obstacle.ahead <= 30) return 'approach';
  return 'warning';
}
