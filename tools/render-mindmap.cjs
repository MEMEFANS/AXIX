const fs = require('node:fs');
const path = require('node:path');
const puppeteer = require('../resources/app/node_modules/puppeteer');
const desktop = 'C:/Users/cy020/Desktop';
const W = 3000, H = 2800;
const groups = [
  ['平台定位', '#50d2c2', [
    ['品牌', 'AxiX Exchange · 一站式数字资产交易平台'],
    ['网络', 'BNB Smart Chain（BSC）· 平台代币 AIX'],
    ['产品', '现货交易 / 永续合约 / AIX 交易 / 矿机质押 / 合约跟单'],
    ['入口', '官网 axix.cc · Web3 钱包连接']
  ]],
  ['AIX 经济模型', '#70dfba', [
    ['固定总量', '20 亿枚 · 矿机产出上限 10 亿 / 质押产出上限 10 亿'],
    ['销毁规则', '每日固定销毁 100 万枚 · 累计销毁上限 19.8 亿枚（99%）'],
    ['手续费分配', '卖出与互转手续费：50% 销毁 + 50% 进入 A10 分红池'],
    ['跟单消耗', '销毁 1,000 AIX 开通 30 天 VIP · 续费重新销毁']
  ]],
  ['矿机与质押', '#50d2c2', [
    ['Mini 矿机', '0.002 BNB · 30 天 · 总产出 100 AIX · 日均约 3.33 AIX'],
    ['Pro 矿机', '0.05 BNB · 90 天 · 总产出 1,500 AIX · 日均约 16.67 AIX'],
    ['矿机规则', '两种套餐各限购 1 份 / 钱包 · 链上确认到账 · 每日结算'],
    ['活期质押', '100 AIX 起 · 日利率 0.30% · 灵活存取'],
    ['定期质押', '30 天：0.80% / 日，1,000 AIX 起；60 天：1.00% / 日，2,000 起'],
    ['定期规则', '90 天：1.20% / 日，5,000 AIX 起 · 利息日结 · 到期本金可取']
  ]],
  ['团队等级与分润', '#aef5e8', [
    ['等级门槛', '个人 / 团队 AIX 持有量共同评定 · 等级快照每 5 分钟刷新'],
    ['A1—A3', 'A1：1,000 / 5,000（10%）　A2：2,000 / 1 万（20%）　A3：4,000 / 5 万（30%）'],
    ['A4—A6', 'A4：8,000 / 10 万（40%）　A5：1.6 万 / 50 万（50%）　A6：3.2 万 / 100 万（60%）'],
    ['A7—A9', 'A7：6.4 万 / 500 万（70%）　A8：12.8 万 / 1,000 万（80%）　A9：25.6 万 / 5,000 万（90%）'],
    ['矿机分润', '直推 15% · 间推 10% · 级差＝上级比例－矿工比例 · 平级奖 10%'],
    ['A10 分红', '个人 50 万 / 团队 1 亿 · 不参与级差和平级 · 每日均分手续费分红池']
  ]],
  ['交易与互转', '#7cbcf4', [
    ['撮合机制', 'AIX 挂单撮合（P2P 订单簿）· 买方 0 手续费'],
    ['阶梯费率', '直推有效人数 0—1 / 2—3 / 4—5 / 6—7 / 8—9 / ≥10'],
    ['对应费率', '卖出与互转：50% / 40% / 30% / 20% / 10% / 3%'],
    ['有效人数', '被推荐人持有运行中的矿机或质押有效本金'],
    ['资金规则', '未成交挂单可撤销解冻 · 互转由转让方付费，收款方免手续费']
  ]],
  ['合约跟单与资金', '#e9c67c', [
    ['VIP 权益', '1,000 AIX / 30 天 · 开通代币永久销毁、不返还'],
    ['跟单规则', 'VIP 有效期内随进随出 · 按项目规则赎回本金不扣罚金'],
    ['推荐佣金', '跟单收益直推 10% · 间推 0 · 与矿机分润独立'],
    ['充值提现', '充值全额入账、0 手续费 · 最低提现 10 USDT · BSC 链上出款']
  ]]
];
const esc = s => s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
const logo = fs.readFileSync(path.join(__dirname, '../resources/app/public/assets/brand/logo.png')).toString('base64');
let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><rect width="${W}" height="${H}" fill="#fbfdfd"/><style>text{font-family:'Microsoft YaHei','Segoe UI',sans-serif;letter-spacing:0}</style>`;
const txt = (x,y,s,size=30,color='#344b50',weight=400) => `<text x="${x}" y="${y}" font-size="${size}" fill="${color}" font-weight="${weight}">${esc(s)}</text>`;
svg += '<rect x="100" y="100" width="56" height="6" fill="#19aa98"/>';
svg += txt(100,165,'AxiX / 生态全景',46,'#122c30',700);
svg += txt(100,213,'PROJECT ECOSYSTEM · 产品与规则总览',23,'#78908f');
let y = 300;
const centers = [];
groups.forEach(([title,color,rows], index) => {
  color = ['#159b89','#27977e','#0e9eaa','#348b79','#4b91aa','#a18c58'][index];
  const cy = y + (rows.length-1)*34;
  centers.push({cy,color});
  svg += `<path d="M620 1320 C775 1320 650 ${cy} 900 ${cy}" fill="none" stroke="${color}" stroke-width="5" opacity=".65"/>`;
  svg += txt(870,cy-35,String(index+1).padStart(2,'0'),22,color,600);
  svg += txt(870,cy+10,title,37,'#153c3b',700);
  svg += `<path d="M870 ${cy+34}H1170" stroke="${color}" stroke-width="4"/><path d="M1170 ${cy+34} Q1215 ${cy+34} 1215 ${cy} V${y} M1215 ${cy}V${y+(rows.length-1)*68}" stroke="${color}" stroke-width="2" fill="none" opacity=".5"/>`;
  rows.forEach(([label,value],i)=>{
    const ry=y+i*68;
    svg += `<path d="M1215 ${ry}H1245" stroke="${color}" stroke-width="2" opacity=".5"/>`;
    svg += txt(1265,ry+9,label,29,color,700);
    svg += txt(1470,ry+9,value,index===3 ? 27 : 30);
  });
  y += rows.length*68+75;
});
svg += `<image href="data:image/png;base64,${logo}" x="115" y="1085" width="150" height="150"/>`;
svg += txt(115,1335,'AxiX',116,'#153c3b',700);
svg += txt(120,1400,'EXCHANGE',37,'#159b89',600);
svg += '<path d="M120 1440H360" stroke="#50d2c2" stroke-width="5"/>';
svg += txt(120,1510,'数字资产交易生态',34,'#344b50',600);
svg += txt(120,1568,'交易 · 算力 · 质押 · 跟单',27,'#78908f');
svg += txt(120,1630,'axix.cc',27,'#159b89');
svg += '<path d="M100 2660H2900" stroke="#dbe8e6" stroke-width="2"/>';
svg += txt(100,2705,'内容依据：项目玩法介绍、平台介绍及前端配置。具体参数与执行以平台实际规则为准。',23,'#78908f');
svg += txt(100,2747,'图中利率与分润为规则描述，不代表收益承诺；代币价格与交易结果受市场影响。',23,'#78908f');
svg += '</svg>';
const basename = path.join(desktop, 'AxiX-项目思维导图-美工优化版');
fs.writeFileSync(basename+'.svg',svg);
fs.writeFileSync(basename+'.html',`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>AxiX 项目思维导图</title><style>html,body{margin:0;background:#0a0e17}svg{display:block;width:100%;height:auto}</style>${svg}</html>`);
(async()=>{
  const browser=await puppeteer.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
  try {
    const page=await browser.newPage();
    await page.setViewport({width:W,height:H,deviceScaleFactor:2});
    await page.setContent(`<html><body style="margin:0">${svg}</body></html>`);
    await page.evaluate(()=>document.fonts.ready);
    const overflow=await page.evaluate(()=>Array.from(document.querySelectorAll('text')).filter(t=>t.getBBox().x+t.getBBox().width>2920).map(t=>t.textContent));
    if(overflow.length) throw Error('Text overflow: '+overflow.join('; '));
    await page.screenshot({path:basename+'.png'});
    await page.setViewport({width:1500,height:1400,deviceScaleFactor:1});
    await page.setContent(`<html><body style="margin:0">${svg.replace('width="3000" height="2800"','width="1500" height="1400"')}</body></html>`);
    await page.screenshot({path:path.join(__dirname,'mindmap-preview.png')});
    console.log(basename+'.png');
  } finally {await browser.close();}
})();
