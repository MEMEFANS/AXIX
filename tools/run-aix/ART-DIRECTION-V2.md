# 奔跑吧 AIX · 第二版美术制作单

目标：重做主角和背景，达到精修手游宣传画与游戏素材的统一质感；不能把现有简单几何程序图形换个配色作为交付。所有改动仅在本地。

## 统一风格

原创 3D 潮玩精灵，柔软果冻与细腻磨砂材质；紫罗兰主色、薄荷青轮廓光、少量香槟金点缀。以精灵和赛道为主体，减少杂乱装饰。场景采用电影式景深、清晰的前中后景与有方向的灯光。画面有体积、材质与光影，车道及障碍仍需清楚可读。

主角：有辨识度的 AIX 小精灵，短肢、圆润但非正圆，微微后掠的双耳，半透明紫色身体与青色眼睛，表情机灵自信。AIX 字样由游戏层叠加，避免生成文字畸变。保持各动作的头身比例、耳形、材质和灯光一致。不能使用现有 IP 或官方币种 Logo。

## 首批素材

1. 大厅主视觉：竖屏星空跑道，小精灵向前冲刺，周围少量晶体与光粒，顶部留标题空间，底部留按钮空间。
2. 主角独立素材：待机、奔跑、冲刺、左右闪避、受击；角色轮廓一致，脚底接触点一致，留足运动边距。
3. 星空之城：悬浮轨道、远景星球、霓虹建筑，多层深度，中央三车道视线通畅。
4. 交易所大厅：宏大室内空间、远景行情灯墙、青金色地面反射，不生成实际可读行情文字。
5. 稳定币海域：深蓝海面、浮桥、远景岛屿、青色生物荧光，中央路径清楚。
6. 六种独立障碍：有厚重金属感的巨币怪、棱晶兽、机械箱怪、半透明幽灵、引力黑洞、行情晶刺。每个有不同轮廓、材质与表情，不能套皮。

## 生成提示词基准

Use case: stylized-concept

Asset type: polished mobile portrait runner game artwork for Run AIX.

Style: premium original stylized 3D collectible character art, soft translucent jelly and finely textured matte materials, convincing volume and contact shadows, cinematic soft lighting, restrained bloom, coherent art direction, crisp readable silhouettes.

Palette: deep midnight indigo, luminous violet, mint cyan rim lighting, restrained champagne gold accents.

Character identity: original small purple cosmic sprite, expressive mint eyes, short limbs, two swept-back ears, subtly asymmetrical bean-shaped body, charming confident expression, identifiable at small sizes. Preserve exactly the same character identity across all poses.

Composition: clear central gameplay path, foreground/midground/background separation, uncluttered focal hierarchy. No baked-in UI or typography.

Avoid: primitive flat geometric placeholder art, wireframe roads, repetitive rectangular buildings, generic robot helmet, emoji faces, excessive neon noise, copied commercial characters, official token logos, watermarks, unreadable generated text.

每个素材分别补充场景、姿态、视角和构图要求；先审主角与主场景，再扩展整套，避免一批素材风格不一致。

## 接入与验收

- 精修素材进入项目资源目录；角色、背景、障碍分别加载，不把整张宣传图直接冒充可玩赛道。
- 保留三车道碰撞投影、换道动画、冲刺火焰和距离变化。
- 页面标题、按钮与 HUD 使用真实 HTML 文本，避免烧进图片。
- 检查 320 / 375 / 430 手机尺寸、透明边缘、角色脚底位置、障碍辨识度、资源体积与加载失败处理。
- 继续沿用已有网站账户、只读 AIX 余额及独立试玩积分，不部署服务器。

## 当前资源生成状态

本会话无内置 image_gen 工具，本机未配置 OPENAI_API_KEY。尚未调用收费 API，也未生成或冒充已完成的精修素材。备用 API 生成等待用户明确同意并在本机配置密钥。
