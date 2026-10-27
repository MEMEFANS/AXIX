# 轮换 BNB Pro 台数展示（已上线）

2026-10-20 北京时间约 03:06 发布，公网约 03:08 验证通过。线上保持 Mini 0.002 BNB / Pro 0.05 BNB 激活，Pro 仍按每两笔一笔进入新轮换地址。20/400 AIX 激活版本仍只在本地待部署。

## 生效范围

以下两个查看地址的前台团队页、后台团队激活查询、后台用户详情和相关 Pro 编辑基数，排除付到轮换地址的 BNB Pro 激活。已有全局后台矿机汇总继续按两个团队的并集扣除，避免嵌套重复计算。

- `0x31f80338d1effe26fdf48b48aabfdbddd6f177bd`
- `0x436252b4759eee30066a0d1101911caa7a63ccf2`

轮换地址：`0x1266d38865460cf7d0c06985ac5587a5e85de2c0`。旧轮换地址 `0x0c89b9ddc29f3e4ac968a3e02611bd95a2df1361` 的历史排除和付款核验保留。

新确认记录保存链上实际收款地址 `verifiedCollectionAddress`。动态排除只接受 confirmed、Pro、BNB、实际核验为轮换收款的记录，按 30 秒缓存自动更新。历史经链上核验的 111 笔清单保留；停止旧服务后再次补核验，闭合发布间隙。

真实激活、矿机、余额、持仓、等级、收益及审计数据保留；后台原始字段仍供审计，页面 Pro 比较值采用排除后的基数。另有 AIX Pro 的钱包不会一起隐藏。保存未修改的 Pro 显示值不会再次扣减。

## 发布与核验

仅发布 `candidate/` 中从生产 BNB 基线制作的六个文件及服务器排除配置。没有整体上传 `resources/app`，没有切换到 AIX 支付、写入生产数据库或修改 `.env`。

- 7 项 BNB 回归全部通过，见 `stage-test-results.json`。
- 本地 AIX / BNB 两套后台详情、UI、保存差值检查通过，见 `admin-detail-check.json`。
- 独立生产数据库副本前后 45 张业务表指纹相同，见 `production-copy-results.json`。
- 发布停止窗口内 SQLite / WAL 和 `.env` 指纹相同，服务约 15.74 秒恢复。
- 停服最终回填核验 173 笔近期交易，其中 23 笔轮换付款均已在历史清单内，没有新增历史排除；当前新地址动态路径由合成交易和临时 SQLite 测试覆盖，没有实际发送测试付款。
- 本机后台两类团队接口及全局两类矿机接口通过，见 `deploy-results.json`。
- 公网套餐仍为 BNB，后台脚本版本 `20261020-pro-rotation-1` 且脚本 SHA256 与候选完全相同，见 `public-verification.json`。
- 服务 active，发布后的错误日志为空，rescue timer 已停止。

发布时两个团队分别排除 85 / 111 个 Pro 钱包；后台全局并集排除 111 台。原手动展示增量保留，因此团队显示值与排除后的真实基数可以不同。

服务器备份：`/opt/wg-platform/backups/pro-rotation-display-20261020-030547`。其中包含原六文件、原排除配置、发布结果和用于发布失败自动恢复的脚本；不包含数据库回退操作。

## 工作区

相同报告逻辑已同步至本地 AIX 待部署版本。后续部署 AIX 版本时应以本次线上 BNB 版本为基线核对，保留服务器 `pro-reporting-exclusions.json` 和本次动态排除逻辑。

公网下载文件通过 PowerShell `Invoke-WebRequest` 获取，再运行 `node tools/pro-rotation-display-20261020/verify-public.cjs --downloaded` 核对。当前环境 Node 直连公网 TLS 不稳定，服务器直接访问公网域名受访问规则限制，PowerShell 公网访问及生产本机接口均验证成功。
