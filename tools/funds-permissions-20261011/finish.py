import json
import pathlib

audit=pathlib.Path(__file__).resolve().parent
deployment=json.loads((audit/'deployment-result.json').read_text(encoding='utf-8'))
public=json.loads((audit/'public-verification.json').read_text(encoding='utf-8'))
browser=json.loads((audit/'public-browser-result.json').read_text(encoding='utf-8'))
local=json.loads((audit/'browser-result.json').read_text(encoding='utf-8'))
assert deployment['deployed'] and public['passed'] and browser['passed'] and local['passed']
manifest=json.loads((audit/'manifest.json').read_text(encoding='utf-8'))
manifest.update({'deployed':True,'release':deployment['release'],'completed_at_utc':deployment['completed_at_utc'],'production_manifest':'release-manifest.json'})
(audit/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2),encoding='utf-8')
report=f'''# 运营账号的资产与矿机发放权限修复

已发布：`{deployment['release']}`，UTC 完成时间：`{deployment['completed_at_utc']}`。
生产备份：`{deployment['backup_directory']}`。

## 修复范围

运营账号原先可以通过 `/api/admin/a-token/grant`、`debit` 直接调整 USDT/AIX，通过 `grant-miner` 创建产出矿机。`activations/confirm` 还可在没有通过链上付款校验时人工确认并创建矿机。

- 服务器入口和 AIX 运营路由内部都拒绝 `grant`、`debit`、`grant-miner`、`grant-stake`、`activations/confirm`。旧处理代码移除；运营 cookie 或在旧接口上附加资金令牌都不能恢复权限。
- 资金后台 `/funds-admin.html` 新增“资产调整”和“赠送矿机”。新 API 为 `/api/wallet/admin/asset-adjustments`、`miner-grants`，必须独立资金令牌验证。运营 cookie、错误/缺失令牌、跨站请求在读取请求体或执行服务前拒绝。
- 资产调整沿用原原子账本服务及审计。请求编号必填，重试检查钱包、数量、币种和加减方向，防止同编号跨操作复用；USDT 使用 6 位、AIX 使用 18 位精度。
- 矿机赠送使用原套餐和同钱包同套餐限一次规则。创建矿机、保存重试凭证和审计记录在同一 SQLite 事务中提交；审计失败回滚矿机，重启后重复编号仍返回原矿机。
- 运营页面的资产调整、矿机赠送表单换为资金后台入口。资金令牌仍只保存在页面内存，锁定时清除新增表单和记录。新脚本带版本号更新。
- 用户正常链上付款验证与自动确认仍调用原服务，普通客服、社交审核、读取矿机信息仍可使用。本次没有改动其他运营业务权限，也没有加入双因素登录或大额复核。

## 验证

- `npm run test:admin-security` 通过：图片/客服安全、提现冻结、原资金接口、新增资产/矿机权限、重复提交、精度、余额不足、审计失败回滚、重开数据库后的幂等性。
- 隔离浏览器覆盖实际服务器路由及手机表单：旧资金请求被拒绝、无资金令牌拒绝新接口、运营写表单移除、资产与矿机提交失败重试沿用原编号、历史 HTML 文本按文字显示、锁定清理全部资金列表，共 {len(local['scenarios'])} 项场景通过。
- 发布前在生产账本副本上验证候选 API、旧运营路由拒绝，以及已有历史截图过滤。正式发布只更新 8 个运行文件，{deployment['protected_files_unchanged']} 个保护文件保持原哈希，原钱包/奖励代码、页面速度优化和配置保留。服务已重启。
- 代码切换期间全部 {deployment['database_tables_checked']} 张数据库表内容指纹一致；没有恢复/覆盖生产数据库。服务恢复后正常同步用户与团队等级。发布前后提现设置与冻结名单一致，自动提现原状态为 {deployment['verification']['automatic_withdrawal_enabled']}。
- 初次发布预检使用上次发布的“自动提现应关闭”假设而停止，未切换代码或停止服务。改为对本次读取的实际设置做前后相等检查后正常发布，没有修改用户的提现配置。
- 源站和公网浏览器验证旧路径返回 403、新资金路径不接受运营 cookie；资金令牌可以读取资产/矿机记录，客服与图片审核页面正常。公网 {len(public['checks'])} 项入口/响应头检查、{len(browser['checks'])} 项浏览器场景全部通过。
- 线上验证仅登录、读取、退出，没有对真实账户执行加币、扣币或矿机赠送。

证据：`manifest.json`、`release-manifest.json`、`deployment-result.json`、`browser-result.json`、`public-verification.json`、`public-browser-result.json`。修改前源文件在 `before/`，审阅差异在 `review/`。资金后台地址和原登录令牌保持原样。
'''
(audit/'report.md').write_text(report,encoding='utf-8')
print('Published and verified:',deployment['release'])
