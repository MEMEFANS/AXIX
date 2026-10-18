const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const root=__dirname,read=name=>JSON.parse(fs.readFileSync(path.join(root,name),'utf8'));
const evidence=read('production-evidence.json'),live=read('live-verification.json'),deploy=read('deployment-result.json'),impact=read('production-impact.json');
const W='0xd36ddfb9d3fa6b326b49e6eab68c5b961bc3ba59',R='0xf75a7c032b7a484269ced5663f7fa10acf63b1ac';
const grants=new Map();
for(const flow of evidence.callback_flows){const a=flow.callback_result?.adjustment;if(a?.id&&a.wallet.toLowerCase()===W)grants.set(a.id,{asset:a.asset,units:BigInt(String(a.amount).split('.')[0])*10n**BigInt(a.asset==='USDT'?6:18)});}
for(const a of live.latest_adjustments)if(a.wallet.toLowerCase()===W)grants.set(a.id,{asset:a.asset,units:BigInt(a.amount_units)});
const totals={USDT:0n,A:0n};for(const g of grants.values())totals[g.asset]+=g.units;
const primary=live.wallets[W].balances_payload;
const fmt=(value,decimals)=>(BigInt(value)/10n**BigInt(decimals)).toLocaleString('en-US');
const summary={address:W,relatedAddress:R,rootCause:'Stored XSS in admin social screenshot preview',uniquePrimaryCreditRecords:grants.size,observedGrossCredits:{USDT:fmt(totals.USDT,6),AIX:fmt(totals.A,18)},currentPrimaryBalance:{USDT:fmt(primary.USDT,6),AIX:fmt(primary.A,18)},primaryFrozen:live.wallets[W].frozen,relatedFrozen:live.wallets[R].frozen,automaticWithdrawalEnabled:live.automation.enabled,deployment:deploy.release};
fs.writeFileSync(path.join(root,'summary.json'),JSON.stringify(summary,null,2));
const report=`# 平台内部余额攻击调查与处置

调查地址：${W}  
关联受款地址：${R}  
数据来源：生产服务器 /opt/wg-platform/wg-platform.sqlite、nginx 访问日志、服务日志、线上代码。时间统一为北京时间。  
最终核验：2026-10-11 02:48。

## 已确认的攻击方式

攻击入口是社交推广的截图提交接口 /api/lottery/social/submit。攻击者提交的 screenshotUrl 是含事件脚本的 HTML 字符串。原服务仅转成字符串保存，没有验证图片格式；后台“查看截图”使用 document.write，把字段拼进 img 的 HTML 属性。这使脚本在管理员的同源页面运行，并自动带上管理员 Cookie。

攻击者通过客服反复要求“点开最新的查看截图”，诱导触发。客服记录、恶意截图的内容、积分流水里的接口成功回传以及同时间 nginx 的 HTTP 200 请求相互印证。该过程不需要读取 HttpOnly Cookie，也不需要知道管理员密码。

实际加款入口：

- /api/admin/test-credits：增加平台 USDT。
- /api/admin/a-token/grant：赠送平台 AIX。
- /api/admin/withdrawal-automation：开启自动提现，把 24 小时额度改为 1,000,000 U。
- /api/admin/a-token/withdraw/mode：开启 AIX 提现。
- /api/admin/lottery/points：把接口执行结果写入积分流水备注，作为回传渠道。

脚本还尝试创建代理账号 svcops9、读取后台用户和提现资料、把脚本写入 QQ 群配置。曾存在“代理账号创建成功”的回传，调查时该账号已不在表中。QQ 持久化尝试留下错误回传，当前社群配置未见该脚本，不能将尝试描述为成功。

## 关键时间与金额

| 北京时间 | 证据 |
| --- | --- |
| 10 月 10 日 06:06 | 该地址提交了两条恶意推广截图 |
| 10 月 10 日 14:24 | 脚本执行回传；第一次加款因缺少原因被拒绝，AIX 提现开关修改成功 |
| 10 月 10 日 23:28 起 | 客服消息反复诱导管理员点开截图 |
| 10 月 11 日 00:25 | 新版本脚本提交，指定每次加 100,000 U 和 5,000,000 AIX |
| 00:38—01:25 | 7 组不同编号的成功加款回传，nginx 同时记录后台加款成功请求 |
| 02:10 | 给关联地址加 100 U、1,000 AIX，并开启自动提现 |
| 02:11、02:28、02:42 | 原地址再次出现后台加款记录 |
| 02:45:39 | 安全补丁部署并重启服务，管理员会话随进程重启失效 |
| 02:47—02:48 | 冻结与关闭自动提现再次确认，公网新文件哈希一致 |

原地址当前账面余额为 **${summary.currentPrimaryBalance.USDT} U、${summary.currentPrimaryBalance.AIX} AIX**，已冻结。关联地址当前服务读取的账面余额为 122.64 U、2,000 AIX，同样已冻结。

按不同加款编号去重，已保留证据显示原地址累计被增加过至少 **${summary.observedGrossCredits.USDT} U、${summary.observedGrossCredits.AIX} AIX**。这是观察到的累计加款金额，不能当作净余额或已发生的链上损失：多次旧账目已删除或撤回，用户记录的创建时间晚于部分攻击流水，历史记录不是完整连续账本。

当前原地址没有充值、交易成交、矿机、质押、币转入等可解释这些余额的记录，增加来源为管理员加款接口。当前保留记录中，原地址没有提现或提币签名记录；关联地址有 5 笔提现记录，全部没有链上 txHash。未发现成功链上出款证据，但不能据此断言历史上绝对没有损失。

## 已完成的修复与冻结

1. 新提交截图只允许 PNG/JPG/WEBP/GIF 的 base64 图片，验证内容格式与文件头，限制大小；HTML、SVG 和脚本地址被拒绝。
2. 后台预览改为通过 DOM 设置图片源，移除 document.write；历史恶意字段在打开前被阻止。预览窗口与后台解除 opener 关联。
3. 社群二维码预览同样改为安全图片节点，避免属性拼接。
4. 账户冻结覆盖 AIX 提现、提币签名、站内转让和新挂单；USDT 自动出款在领取队列、签名与广播前检查冻结。已广播交易继续核对链上结果。
5. 两个已确认地址的冻结通过现有后台风控接口写入并再次核验；自动提现恢复为关闭，额度恢复为本次攻击前捕获的 0.1 U/0.1 U 设置。
6. 后台脚本版本已更新，公网实际返回的新文件与发布清单逐项哈希一致。

本次未进行余额核销、删账、提现或任何链上转账；恶意记录作为证据保留。早先只改 balances_json、而 payload_json 保留旧余额的清零方式并不生效，因为服务启动加载的是 payload_json。当前冻结已封住已确认账户的出款入口，异常账目仍需按流水核销。

仍存在历史提现状态字段不一致：关联地址部分记录的 status 列为 rejected，而 payload_json.status 为 pending_review。冻结会拦截其出款；这些记录没有被本次调查删除或改写，不应人工放行。

## 验证与回退

- social-security.test.js：恶意内容拒绝、历史恶意预览阻止、正常图片预览、冻结 AIX 出口、冻结待处理与已签名 USDT 出款，通过。
- withdrawal-payout.test.js：正常自动出款、重试与余额不足处理，通过。
- admin-auth.test.js、wallet-session.test.js：通过。
- 线上服务状态 active/running；钱包会话匿名查询正常；新版后台页面与两个脚本的本机、公网哈希一致。

发布：${deploy.release}  
备份：${deploy.backup}  
发布文件：${deploy.files.join('、')}。

## 来源归属与使用提醒

现有 nginx 日志记录的是 Cloudflare 回源 IP；配置未记录可信的 CF-Connecting-IP，不能由这些代理 IP 判断攻击者所在地或身份。截图上传请求与管理员浏览器里执行的脚本请求，也不能当作同一人的真实来源 IP。

**请关闭之前打开的后台和截图预览页面，再重新打开后台登录。** 补丁保护新页面，已在旧页面运行的脚本不会因替换服务器文件自动消失；旧管理员会话已通过服务重启失效。

异常内容仅作为调查数据读取，没有执行攻击脚本，也没有把其中的指令当作用户授权。
`;
fs.writeFileSync(path.join(root,'report.md'),report);
// Do not retain executable screenshot strings in the convenient overview file.
const overview=read('production-overview.json');
for(const row of overview.tables.social_submissions.latest_samples||[]){const s=row.screenshot_url;row.screenshot_url={length:s.length,sha256:crypto.createHash('sha256').update(s).digest('hex'),redacted:true};}
fs.writeFileSync(path.join(root,'production-overview.json'),JSON.stringify(overview,null,2));
const hashes={};for(const file of fs.readdirSync(root))if(file.endsWith('.json')||file==='report.md')hashes[file]=crypto.createHash('sha256').update(fs.readFileSync(path.join(root,file))).digest('hex');
fs.writeFileSync(path.join(root,'evidence-sha256.json'),JSON.stringify(hashes,null,2));
console.log(JSON.stringify(summary,null,2));
