# Tasks：矿机「激活名额进度」后台可设置

依赖顺序执行；每步完成即勾选。

- [x] T1 后端存储与读写：`resources/app/src/a-token-service.js`
  - 新增 `readActivationSettings()`
  - 改写 `getActivationMeta()` → 返回 `{ cap, activatedCount(=真实+offset), activatedCountReal, updatedAt }`
  - 新增 `setActivationMeta({ cap, activatedCount })`，按差值 `activatedCountOffset` 落库到 `service_settings` key `a_token_activation_meta`
  - 导出对象中加入 `setActivationMeta`
  - 验证：`node --check src/a-token-service.js`

- [x] T2 后端接口：`resources/app/src/a-token-admin-api.js`
  - 新增 `POST /api/admin/a-token/activation/progress`（带 allowRequest 限流，复用 readBody/send）
  - `GET /api/admin/a-token/miners` 响应追加 `activationMeta`
  - 验证：`node --check src/a-token-admin-api.js`

- [x] T3 前台读取：`resources/app/public/js/earn.js`
  - 第 459 行、第 589 行 `const cap = 1000000;` → 从 `plansCache.activationMeta.cap` 读取，缺省回退 1000000
  - 验证：`node --check public/js/earn.js`

- [x] T4 后台 UI：`resources/app/public/js/operator-admin.js`
  - `renderAMiner()` 新增「📈 矿机激活进度（前台展示）」卡片（名额总数 / 已激活人数 / 保存按钮 / 真实激活数提示）
  - 追加保存事件：校验 → `aApi('/activation/progress', POST)` → `loadAMiner()`
  - 验证：`node --check public/js/operator-admin.js`

- [x] T5 版本号同步（实际落点与初版规格不同，见下）
  - `public/index.html` L1430 `earn.js?v=20261011-team-fast-2` → `20261015-activation-progress-1`（earn.js 由 index.html 直接引 用，不走 page-loader；page-loader 内无 earn 消费者，故不加 versions 项、其自身 ?v 保持 market-price-1）
  - `public/admin.html` L301 `operator-admin.js?v=20261015-activation-progress-1` ✔

- [x] T6 本地实测（node src/server.js，PORT=8082，新代码已重启）
  - `node tools/activation-progress-20261015/verify.mjs`（临时脚本，已删）7 组断言全通过：初始默认值 / 设置 cap+人数 / 仅传人数 cap 不变 / 仅传 cap 人数不变 / 真实激活继续叠加 / 非法入参兜底 / GET /miners 回显
  - HTTP 端到端：admin 登录 → POST `/api/admin/a-token/activation/progress {cap:20000,activatedCount:1234}` → 200；`GET /api/a-token/plans` 与 `GET /api/admin/a-token/miners` 均返回同一 activationMeta；仅传 activatedCount 时 cap 保持 20000；测试后已重置回 `1000000 / 0`
  - 静态资源：`/js/earn.js?v=20261015-activation-progress-1` 含 2 处 `activationMeta?.cap` 读取；`/js/operator-admin.js?v=20261015-activation-progress-1` 含新卡片与保存事件；`/admin.html` 引用新版本号

- [x] T7 用户确认 → 已「全部部署」（2026-10-15 15:31-15:33）
  - 用户指令：全部部署，并包含合约跟单那批
  - `.\tools\ssh-helper.ps1 -Action deploy`：代码-线上 MD5 差异 17 个文件全部上传，MD5 复验通过，服务重启 `active`
  - 备份：`/opt/wg-platform/backups/sync-20261015-153153`
  - 部署清单（三批合并且互相验证）：
    - 本次激活进度：`src/a-token-service.js`、`src/a-token-admin-api.js`、`public/js/earn.js`、`public/js/operator-admin.js`（+ `public/index.html`、`public/admin.html` 版本号）
    - AIX 市价单：`src/a-token-order-service.js`、`public/js/a-token-trade.js`、`public/js/page-loader.js`
    - 合约跟单（ai-managed）：`public/js/ai-managed.js`、`public/styles/ai-managed.css`、`public/promo-guide.html`、`public/js/i18n-extra.js`、`public/js/i18n-zh-en.js`、`src/ai-managed-api.js`、`src/ai-managed-service.js`、`src/database.js`
  - 线上验证（只读）：`GET /api/a-token/plans` → `activationMeta={cap:1000000, activatedCount:11836, activatedCountReal:11836}`（新字段生效）；`/js/earn.js?v=20261015-activation-progress-1` 含新逻辑；`/js/a-token-trade.js?v=20261015-market-price-1` 含 `fmtPrice4`；`admin.html`/`index.html` 均引用新版本号；`promo-guide.html` 200；`/api/ai-managed/*` 路由存在（401 需鉴权，属正常）
  - 遗留提示：进度条上线后默认仍是 cap=1,000,000、真实 11836（≈1.18%），需后台「AIX 矿机管理 → 📈 矿机激活进度」填值保存后才生效

- [x] T8 交互简化：后台改为可直接填「目标进度 %」（2026-10-15 15:44 已上线）
  - 用户反馈「直接填百分比多少不是更简单吗」→ 在卡片首位新增「目标进度 %」输入（0~100，两位小数），填 % 自动换算覆盖「已激活人数」（`Math.round(名额总数 × % ÷ 100)`）；改人数/名额则反向回算 %
  - 后端与公开接口零改动（仍存 cap/activatedCount），保留「真实激活继续累加、人数可手改」语义
  - `public/js/operator-admin.js`、`public/admin.html`（`operator-admin.js?v=20261015-activation-progress-2`）两个文件已部署，MD5 复验通过，frontend-only 无需重启
  - 备份：`/opt/wg-platform/backups/sync-20261015-154440`
  - 例：填 60 → 名额 1,000,000 不变、已激活自动 600,000 → 前台进度条 60%
