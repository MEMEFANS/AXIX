# 奔跑吧 AIX · 本地游戏

默认入口现为 **V4 免费操作冒险**，包括主大厅、固定训练、三世界六关、每日远征、收藏、成绩和设置。见 [ADVENTURE-V4.md](ADVENTURE-V4.md)。游戏：http://127.0.0.1:4173/run-aix.html 。不消耗积分或 AIX，不预抽胜负。

下面保留 V3 独立概率试玩说明，其入口已移至 http://127.0.0.1:4173/run-aix-classic.html 。既有账本与本机配置保持独立。

## V3 独立概率试玩

根据《奔跑吧AIX_游戏需求文档_v3.md.docx》实现的可试玩阶段版本。包含玩法、公开的概率模式、本机规则与障碍配置、试算、模拟账本、安慰积分抽奖和本机榜单。仅本地开发，未部署；消耗、返还和销毁均使用试玩积分。

## 启动

在仓库根目录运行任意一种预览服务：

```powershell
node tools/run-aix/preview.mjs
```

或者不依赖 Node 的 Windows 版本：

```powershell
powershell -ExecutionPolicy Bypass -File tools/run-aix/start-preview.ps1
```

- 免费操作冒险：<http://127.0.0.1:4173/run-aix.html>
- 独立概率试玩：<http://127.0.0.1:4173/run-aix-classic.html>
- 本机配置：<http://127.0.0.1:4173/run-aix-config.html>

服务只绑定回环地址，不加载 `.env`、数据库或交易后端。独立预览没有网站登录会话，真实 AIX 余额显示未登录；同源网站内只读 `/api/a-token/profile`，不要求连接钱包。页面刷新即可加载修改。

## 当前规则

- 默认采用用户确认的明细表：全损60%、保本15%、小赚18%、翻倍6%、高倍1%。各档内按候选米数等概率选择。
- 概率模式在开局抽取结果区，大厅和规则页明确披露。早撞减速，停点踉跄；继续连点可恢复。操作不提高抽中的结果，提前带走可能降低返还。
- 配置页可切换操作挑战模式：不抽结果，致命碰撞或超过连点间隔即结束。
- 默认100m保本，每10m增加0.1倍；200m可带走2倍或锁底继续，500m为5倍。开跑、恢复后有1秒准备，之后停点超过0.2秒触发断连。
- 默认每秒7次点击进入火箭冲刺；速度和障碍密度随距离增加，每排保留安全道。
- 默认等额结果模板的理论返还率为 **57.55%**；支持1万至100万局试算。提前收取、新手保护等会改变实际结果，不包含在模板试算中。
- 本机规则和障碍库各保留最近30个版本，可保存、回滚、恢复默认；新参数下一局生效。刷新恢复保留原局规则、障碍库、结果区及已扣门槛。

## 实现与边界

已有16种障碍、三套场景、预警/逼近/命中/消散表现、五类受击动作、天气和合成音效。原六种障碍沿用精修PNG，新增障碍用独立Canvas造型。完整60+障碍及全部逐帧美术仍待补全。

试玩积分与安慰积分分开记账。全损赠送安慰积分，抽奖概率固定公示，仅返本机试玩积分或收藏装扮。日榜与总榜只收录本机完成对局，不填充虚构玩家，不发榜单奖励。销毁数字明确标为模拟。

真实AIX扣返、链上销毁、公共榜单、服务端权威对局、奖池及有权限控制的运营后台尚未接入。本机配置页不是生产后台，本地存储不是资产账本。OKX iOS / Android钱包实机测试尚未完成。

完整对照与文档冲突处理见 [V3-IMPLEMENTATION.md](V3-IMPLEMENTATION.md)。

## 验证

以下检查不需要启动预览或安装npm依赖（Node.js 22+）：

```powershell
node tools/run-aix/rules-check.mjs
node tools/run-aix/catalog-check.mjs
node tools/run-aix/catalog-integration-check.mjs
node tools/run-aix/practice-check.mjs
node tools/run-aix/v3-engine-check.mjs
node tools/run-aix/engine-check.mjs
```

`v3-engine-check.mjs` 检查两种模式、1200局结果一致性、不同帧率操作挑战、检查点与存档；`engine-check.mjs` 保留关闭断连的纯道路回归，不代表默认概率模式。

浏览器整合：保持预览运行，使用独立Chrome测试配置启动CDP端口9233，再运行 `node tools/run-aix/v3-browser-check.mjs`。脚本会清空**该测试浏览器**的本机游戏数据，不可连接日常使用的浏览器配置。它使用合成账户和仅在测试页生效的时钟/操作驱动，检查真实界面与存储流程；不连接真实钱包。

2026-10-20整合报告为 `v3-browser-results.json`：7组通过，覆盖重复开始、跑到75m后刷新恢复旧规则、下一局采用新规则、全损→安慰→抽奖、200→500m、榜单及320/390屏宽。未发现运行异常；账户请求仅GET profile。

结算异常分支另见 `v3-settlement-browser-check.mjs` / `v3-settlement-browser-results.json`：覆盖重复结果、不一致结果、重试后恢复未完成局及存储失败的页面内结算提示。使用同一独立CDP端口9233。

`v3-pending-browser-check.mjs` / `v3-pending-browser-results.json` 单独检查另一标签已有未完成对局时，开局按钮引导恢复原局且不重复扣分；同样使用独立CDP端口9233。

本地测试浏览器缓存目录已忽略。`browser-results.json`、`extended-results.json`、`DIFFICULTY-V5.md` 和 `ART-DIRECTION-V2.md` 等保留为先前阶段记录，当前V3验收以新报告为准。

## 代码入口

| 文件 | 用途 |
| --- | --- |
| `resources/app/public/run-aix.html` | 游戏页面 |
| `resources/app/public/run-aix-config.html` | 本机配置页面 |
| `games/run-aix/rules.js` | 规则校验、结果抽取、收益曲线、试算及版本历史 |
| `games/run-aix/catalog.js` | 障碍开关、权重、米数、车道、场景、行为、台词及历史 |
| `games/run-aix/engine.js` / `difficulty.js` | 对局、碰撞、断连、检查点、结果区与道路生成 |
| `games/run-aix/store.js` | 模拟积分、恢复、幂等结算、抽奖、榜单与日限额 |
| `games/run-aix/main.js` | 界面、输入及生命周期整合 |
| `games/run-aix/hazards.js` / `art.js` / `effects.js` / `audio.js` | 障碍、场景、受击、天气及音效 |
| `games/run-aix/operator.js` / `operator.css` | 本机配置与试算界面 |
| `games/run-aix/session.js` | 网站账户和真实AIX余额只读适配 |

表中 `games/run-aix/` 均位于 `resources/app/public/` 下。既有位图资源与生成记录见 `art-manifest-v2.json`、`art-prompts-v2.md` 和 `resources/app/public/games/run-aix/assets/`。
