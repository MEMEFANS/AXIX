import json
import pathlib

audit = pathlib.Path(__file__).resolve().parent
deployment = json.loads((audit/'deployment-result.json').read_text(encoding='utf-8'))
public = json.loads((audit/'public-verification.json').read_text(encoding='utf-8'))
browser = json.loads((audit/'public-browser-result.json').read_text(encoding='utf-8'))
assert deployment['deployed'] and public['passed'] and browser['passed']
manifest = json.loads((audit/'manifest.json').read_text(encoding='utf-8'))
manifest.update({'deployed':True,'release':deployment['release'],'completed_at_utc':deployment['completed_at_utc'],
                 'production_server_patch_excludes_unrelated_settle_daily':True,'production_manifest':'release-manifest.json'})
(audit/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2),encoding='utf-8')
report = (audit/'report.md').read_text(encoding='utf-8')
report = report.replace('本次代码修改已完成并验证，尚未部署。生产操作均为只读检查，没有更改生产数据库、余额、奖励、提现开关或账号。',
                        '本次安全修复与独立资金后台已部署，并通过线上接口、公网响应与浏览器验证。发布脚本没有执行生产加款、扣款、提现审核或奖励补发，提现设置与冻结状态保持不变。正常服务启动后会继续同步用户和团队状态。')
report = report.split('## 后续发布注意')[0]
report += f'''## 发布记录

- 发布版本：`{deployment['release']}`，完成时间（UTC）：`{deployment['completed_at_utc']}`。
- 线上备份：`{deployment['backup_directory']}`，包含原始代码、账本备份、候选包验证和发布清单。回退只恢复代码，没有恢复或覆盖生产数据库。
- 更新 17 个运行文件并重启 `wg-platform`；230 个保护文件哈希保持不变，包含钱包服务、奖励相关代码、`.env` 和此前页面性能优化。正式资金后台为 `https://axix.cc/funds-admin.html`，旧提现入口跳转至此。
- 发布包按新读取的线上原文合并本次差异，排除了本地已有、未上线的手动日结接口。
- 首次发布检查发现历史安全处置审计仅有 `note/rows` JSON，普通入账列表的格式化会失败。自动回退成功后，将独立资金列表改为读取账本规范字段；26 条历史处置记录正常显示，不同资产按自己的精度格式化。回归测试与线上账本副本验证通过后再次发布成功。
- 候选包在隔离账本副本上检查了 33 条资产调整、106 条社交审核记录。切换代码期间全部 46 张数据库表的内容指纹保持一致。恢复服务后只有用户与团队等级表因正常同步发生变动，提现设置与冻结名单未变。
- 线上源站验证管理令牌、普通后台账号登录、独立资金权限、旧资金 API 拒绝、跨站请求拒绝以及 50 条无效截图过滤，其中 2 条历史脚本原文不再返回。
- 公网 16 项入口、版本脚本和响应头检查通过。公网浏览器 6 项验证通过，涵盖手机资金后台登录、提现列表、入账记录、锁定清理、普通后台登录、社交截图过滤及客服内容显示；没有执行资金写入。
- 一次额外本地发布包浏览器复测命令被自动审批拒绝（仅返回 blocked by policy），没有重试该命令。已有隔离浏览器测试、候选语法检查、真实账本副本验证和公网浏览器验证共同覆盖发布结果。
- 本机原有 8082 进程未被重启。本次线上 Node 进程为 {deployment['service']['MainPID']}。

证据：`deployment-result.json`、`public-verification.json`、`public-browser-result.json`、`release-manifest.json`。正式账号与令牌仅写入用户桌面的登录信息文件，不放进发布清单或报告。
'''
(audit/'report.md').write_text(report,encoding='utf-8')
login = json.loads((audit/'login-private.json').read_text(encoding='utf-8'))
destination = pathlib.Path('C:/Users/cy020/Desktop/后台登录信息-20261011.txt')
content = f'''AXIX 后台登录信息（2026-10-11 已验证）

资金后台：测试入账 + 提现审核
地址：https://axix.cc/funds-admin.html
登录方式：在“资金管理令牌”输入框粘贴以下令牌，不需要账号。
管理令牌：{login['fundsToken']}

运营后台：图片审核 + 在线客服等
地址：https://axix.cc/admin.html
账号：{login['username']}
密码：{login['password']}

旧提现地址：https://axix.cc/withdraw-admin.html（自动跳转到资金后台）
资金后台刷新或锁定后需要重新输入令牌。
'''
destination.write_text(content,encoding='utf-8-sig')
temporary = audit/'login-private.json'
assert temporary.resolve().parent == audit.resolve()
temporary.unlink()
print(json.dumps({'deployed':True,'release':deployment['release'],'desktop_login_file':str(destination),'username':login['username'],'password':login['password'],'fundsToken':login['fundsToken']},ensure_ascii=False,indent=2))
