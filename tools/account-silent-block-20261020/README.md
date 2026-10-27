# 生产账户静默限制记录

部署日期：2026-10-20（Asia/Shanghai）

已处理邀请码：

- `7M2VGLHB` → `0x09e324a6e3d626812de3fa39b0c86ebb0cfde780`
- `GP7R29JL` → `0xb8a4aa7e03622e01d58f5e4d46d57851d16d38f2`
- `ZSZ9ZS34` → `0x9aa09a7ffacdcc3178d19a17b7ab9e48beb11419`

生产验证结果：3 个账户均为静默限制状态、目标会话数为 0、后续提现冻结；本次撤销 18 个会话。资金记录摘要、提现历史、余额和环境配置保持不变。公开 HTTPS、匿名会话接口和 BNB 矿机配置检查通过，服务 active 且 `NRestarts=0`。

首次部署检查因现有 `/api/a-token/plans` 接口本身约需 12 秒而触发自动回滚；提高检查等待时间后重新部署成功。第一次回滚恢复了原账户状态，未留下限制。

前端静默拦截脚本只对刷新后加载的新页面生效；已打开的旧页面需要刷新或重新进入。后端限制已即时生效。

验证记录：`preflight.json`、`backend-check-results.json`、`frontend-guard-browser-results.json`、`deploy-results.json`、`postcheck-results.json`。
