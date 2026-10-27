# 跑步与场景运动 V3

运行入口：http://127.0.0.1:4173/run-aix.html 。仅本地测试，未部署。

- `runner-animation.js`：八帧背面跑步循环，按实际前进距离播放；换道倾身，冲刺光效。暂停与检查点保持当前帧。
- `world-motion.js`：以米为坐标的地面、车道虚线、接缝和路边灯柱，共享障碍投影。景物向近处放大并循环经过镜头；远景随换道轻微视差。
- `engine.js`：修正暂停时换道插值仍继续的问题。
- 角色帧表：`resources/app/public/games/run-aix/assets/run-cycle-v3.png`；源图保留于 `output/imagegen/run-aix/run-cycle-v3-source.png`。透明处理和头部对齐脚本为 `prepare-run-cycle.ps1`。

生成方式：用户已授权的卡扣媒体 API，gpt-image-2，high/2k，参考原人物保持角色身份。提示词完整保存在 `art-jobs/run-cycle-v3-prompt.txt`。任务 `img_d79d108aaa6b45358d08a9c402cdf3f0`，实际新增费用 USD 0.20。

验证：既有逻辑、交互、完整流程共 30 项，美术 4 项，运动 6 项。`motion-check.mjs` 检查角色独立八姿势、距离相位、道路连续变化、透视方向及暂停像素冻结，并生成 `run-cycle-v3.webm` 实机录像。不是服务器部署，也未增加真实代币操作。
