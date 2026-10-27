# AIX 矿机激活改动（本地待部署）

状态：2026-10-19 本地完成并验证。用户要求今天不部署；没有上传文件、重启线上服务、执行生产数据库迁移或安排自动部署。

## 已确认规则

| 矿机 | 激活费用 | 总产出 | 产出周期 | 限制 |
| --- | --- | --- | --- | --- |
| Mini | 平台可用余额 20 AIX | 100 AIX | 30 天 | 每钱包终身一次，包含历史激活和赠送 |
| Pro | 每台平台可用余额 400 AIX | 每台 1,500 AIX | 每台 90 天 | 可以反复激活、同时持有多台，无全站激活名额上限 |

激活费用全部销毁，计入现有交易大厅的今日和累计销毁；不进入手续费分红池。扣款、销毁、激活记录、矿机创建与激活积分回调在同一 SQLite/钱包事务内执行。原有北京时间日结算法不变。

前端只调用 personal_sign 授权平台扣款，不发送 BNB 或链上代币转账。签名绑定套餐、固定价格、请求编号和时间。请求编号永久落在激活记录 ID 中，网络超时、重复提交、刷新、重新签名和服务重启均复用同一笔购买。

交易大厅打开期间每 5 秒获取最新销毁总数；进入页面和本地激活成功事件也触发刷新。

## 兼容与数据边界

- 不重置历史余额、矿机、收益、BNB 激活记录或已设置的团队展示扣减。
- 上线后的第一次服务初始化，将切换时间持久化到 `a_token_activation_aix_cutover_v1`。旧 BNB 漏单只接受切换前的链上付款，重启不会重新开放 BNB 激活；原有待确认订单继续核验。同钱包的新 AIX Pro 与补发的历史 BNB Pro 可并存，新矿机不会阻止历史付款补发。
- 新 AIX 记录的 `paymentAsset` 为 `AIX`、`txHash` 为 `null`。数据库保留历史 NOT NULL 字段，内部支付以空 SQL 值存储，哈希唯一索引仅约束真实非空链上哈希。迁移保留历史记录。
- 已扣款、销毁并发矿机的 AIX 记录不能通过后台“驳回”改状态，以免产生账实不符。
- 两个指定地址的历史轮换 Pro 展示扣减继续有效；同钱包新买的 AIX Pro 不会一起被扣除。团队“人数”仍按钱包去重，矿机“台数”按实际矿机记录统计。
- 原有全局 99% 通缩上限保持有效；如果剩余可销毁额度不足以全额销毁激活费，本次交易整体失败并回滚，不会只销毁一部分却扣走全额费用。

## 本次涉及文件

- `resources/app/src/a-token-activation-service.js`
- `resources/app/src/a-token-api.js`
- `resources/app/src/a-token-miner-service.js`
- `resources/app/src/a-token-service.js`
- `resources/app/src/a-token-team-service.js`（在已有两个地址扣减修改上补充重复 Pro 兼容）
- `resources/app/src/database.js`（在已有查询修改上增加兼容迁移与按 ID 查找）
- `resources/app/public/js/earn.js`
- `resources/app/public/js/a-token-trade.js`
- `resources/app/public/js/operator-admin.js`
- `resources/app/public/js/page-loader.js`
- `resources/app/public/index.html`
- `resources/app/public/admin.html`
- `resources/app/package.json`
- 新增/更新的相关测试。

工作区还包含此前的互转、团队统计及其他原有修改；未回退或覆盖这些工作。明天部署时需要一并核对当前线上版本，前后端版本应配套更新；本说明不是部署授权。

## 本地验证

通过的功能验证：

- `test/a-token-aix-activation.test.js`：20/400 AIX 精确扣款、全额销毁、Mini 终身一次、历史赠送限制、Pro 多台及每台完整 90 天产出、持久重试、钱包签名与过期验证、切换前 BNB 恢复、切换后 BNB 拒绝、数据库迁移，以及销毁/激活/矿机/积分/钱包落库各环节故障回滚。
- `test/earn-aix-activation.test.js`：本机 Chrome + 本机临时 HTTP 服务 + 合成钱包/临时数据库；手机和桌面布局、取消签名、双击、连续 Pro、响应中断后刷新恢复、会话恢复、过期请求重新签名复用编号、切换钱包、旧套餐模式拦截、交易大厅定时刷新累计销毁。
- `test/a-token-pro-reporting.test.js`：两个地址的历史扣减与新 AIX Pro 保留。
- `test/a-token-burn.test.js`
- `test/a-token-ecosystem.test.js`
- `test/a-token-reconcile.test.js`
- `test/atomic-ledger.test.js`
- `test/a-token-income.test.js`
- `test/a-token-team-loading.test.js`
- `test/earn-team-loading.test.js`
- 修改的 JS 文件语法检查及 `git diff --check`。

新增集中测试入口：`npm run test:aix-activation`（需要依赖和 Chrome，可通过 `CHROME_PATH` 指定）。本机依赖安装在 `output/aix-activation-local/deps`，由 `resources/app/node_modules` 目录联接使用；未修改生产依赖。

预览：`output/aix-activation-local/screenshots/activation-mobile.png`、`activation-desktop.png`、`trade-live-burn.png`。页面中的钱包、余额和矿机全部为测试数据。

## 2026-10-20 BNB 线上增量同步

线上另行发布了轮换 BNB Pro 台数的动态展示排除，详见 `tools/pro-rotation-display-20261020/README.md`；线上仍使用 0.002 / 0.05 BNB，20/400 AIX 支付未上线。

本地已同步实际链上收款地址持久化、动态排除、后台 Pro 详情与编辑基数、保存差值及 AIX 矿机保留。明天部署时须保留这部分逻辑及服务器的 `pro-reporting-exclusions.json`，避免覆盖本次线上增量。本文原“未上传/未重启”状态仅指 AIX 激活版本。
