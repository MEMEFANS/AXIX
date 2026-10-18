# 资产列表 AIX 数量显示修复

发布完成：北京时间 2026-10-11 04:48:15。

首次直接打开资产页时，账户模块读取尚未懒加载的图表变量 `tradeCurrentMarkPrice`，抛出 ReferenceError，平台账户数据未传递给资产列表。与此同时，列表只使用平台账户快照中的 AIX 数量，未显示已返回的钱包账本余额。

修复：保护图表变量读取；AIX 可用数量优先读取钱包账本，缺少该字段时回退平台账户；冻结数量继续读取平台冻结余额；退出及切换钱包时清除旧平台数据。AIX 数量最多显示 8 位小数，极小的正余额显示 `<0.00000001`。

验证：Chrome 手机视口回归通过，包括首次进入资产页且不加载图表、平台接口延迟、可用和冻结数量、新钱包零余额、小额余额与退出清空。手机钱包启动测试、资产统计专项测试通过。测试使用模拟账户及接口，无真实签名或资金操作。

生产仅发布 4 个静态前端文件，保留生产已有改动。源站与公网 4 个文件内容验证通过；公网首页移除 Cloudflare 注入的分析脚本后，内容哈希与源站一致。服务保持 active/running，PID 9731，未重启。服务端保护文件及配置哈希不变；部署脚本没有访问数据库，也没有修改账户余额、奖励流水或执行补款。

发布编号：`assets-quantity-20261010-204815`。

备份目录：`/opt/wg-platform/backups/assets-quantity-20261010-204815/`。

证据：`assets-quantity-deployment-result.json`、`assets-quantity-public-result.json`、`assets-quantity-fix/deploy-manifest.json`、`assets-quantity-fix/mobile-balance.png`。
