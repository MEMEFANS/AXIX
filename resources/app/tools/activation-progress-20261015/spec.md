# Spec：矿机「激活名额进度」后台可设置

需求（用户原话）：「矿机里面那个矿机激活进度做一个可以设置进度的在后台」

## 1. 目标对象定位（结论）

前台位置：导航「AxiX矿机」→ 子标签「激活」页顶部的「**激活名额进度**」进度条（含文案「激活用户赠送矿机，满额后关闭赠送」）。

- [earn.js](file:///c:/Users/cy020/Desktop/WG-Grid-Studio-完整成交账本/resources/app/public/js/earn.js#L584-L613) `renderActivation()`：`const cap = 1000000;` → `capPct = min(100, activatedCount / cap * 100)` → 渲染 `.cap-wrap/.cap-bar/.cap-fill`。
- [earn.js](file:///c:/Users/cy020/Desktop/WG-Grid-Studio-完整成交账本/resources/app/public/js/earn.js#L445-L487) `renderGuestContent()`：同一进度条的游客版（同样硬编码 `cap = 1000000`）。
- 当前 `activatedCount` 来自真实「已确认激活数」，`cap` 硬编码 1,000,000，因此进度条长期显示 0%，无法运营调控。

## 2. 数据链路（现状）

```
service_settings(setting_key='a_token_activation_meta')
  └─ aTokenService.getActivationMeta()            // a-token-service.js L128-131，默认 cap=1_000_000，activatedCount=真实计数
       ├─ activationService.getMeta()             // a-token-activation-service.js L43
       │    └─ GET /api/a-token/plans → activationMeta   // a-token-api.js L70-86
       │         └─ earn.js plansCache.activationMeta    // 前台读取
       └─ GET /api/admin/a-token/stats → activation       // a-token-admin-api.js L21-28
```

关键发现：`getActivationMeta()` 已支持从 `service_settings` 覆盖字段，但**全仓库无任何写入方**（已 grep 确认 `ACTIVATION_META_KEY` 仅被读）。因此本次只需补「写入链路 + 后台 UI + 前台读取 cap」。

## 3. 方案（最小改动）

存储语义：在 `ACTIVATION_META_KEY` 下存 `{ cap, activatedCountOffset, updatedAt }`。
前台展示人数 = **真实已确认激活数 + activatedCountOffset**，因此后台设定后，真实新增激活仍会继续累加（与既有「团队展示数据」按差值存储的做法一致）。

### 3.1 后端 `resources/app/src/a-token-service.js`

1. 改写 `getActivationMeta()`（L128-131）：

```js
function readActivationSettings() {
  const raw = db.db.prepare('SELECT payload_json FROM service_settings WHERE setting_key=?').get(ACTIVATION_META_KEY);
  return raw ? JSON.parse(raw.payload_json) : {};
}
function getActivationMeta() {
  const stored = readActivationSettings();
  const real = db.countConfirmedATokenActivations();
  const cap = Math.max(1, Math.floor(Number(stored.cap)) || 1_000_000);
  const offset = Math.max(0, Math.floor(Number(stored.activatedCountOffset)) || 0);
  return { cap, activatedCount: real + offset, activatedCountReal: real, updatedAt: stored.updatedAt || null };
}
```

2. 新增 `setActivationMeta({ cap, activatedCount })`（紧邻 getActivationMeta）：

```js
function setActivationMeta({ cap, activatedCount } = {}) {
  const stored = readActivationSettings();
  const real = db.countConfirmedATokenActivations();
  const nextCap = cap !== undefined && Number.isFinite(Number(cap))
    ? Math.max(1, Math.floor(Number(cap)))
    : Math.max(1, Math.floor(Number(stored.cap)) || 1_000_000);
  const current = real + Math.max(0, Math.floor(Number(stored.activatedCountOffset)) || 0);
  const nextCount = activatedCount !== undefined && Number.isFinite(Number(activatedCount))
    ? Math.max(0, Math.floor(Number(activatedCount)))
    : current;
  db.db.prepare('INSERT INTO service_settings(setting_key,payload_json,updated_at) VALUES(?,?,?) ON CONFLICT(setting_key) DO UPDATE SET payload_json=excluded.payload_json,updated_at=excluded.updated_at')
    .run(ACTIVATION_META_KEY, JSON.stringify({ cap: nextCap, activatedCountOffset: nextCount - real, updatedAt: clock() }), clock());
  return getActivationMeta();
}
```

3. 在返回对象（L431 附近，`getActivationMeta,` 旁）新增 `setActivationMeta,`。

### 3.2 后端 `resources/app/src/a-token-admin-api.js`

在「矿机激活开关」块（L126-133）之后新增路由：

```js
// ── 矿机激活名额进度（前台展示可调）──
if (request.method === 'POST' && pathname === '/api/admin/a-token/activation/progress') {
  if (allowRequest && !allowRequest(request, res, 'a-token-admin', 30, 60_000)) return true;
  const body = await readBody(request);
  const patch = {};
  if (body.cap !== undefined) patch.cap = body.cap;
  if (body.activatedCount !== undefined) patch.activatedCount = body.activatedCount;
  const activationMeta = aTokenService.setActivationMeta(patch);
  return send(res, 200, { ok: true, activationMeta });
}
```

并在 GET `/api/admin/a-token/miners`（L195-209）响应中加入 `activationMeta: aTokenService.getActivationMeta(),`，供后台面板回显当前值（不必新增 GET 接口）。

### 3.3 前台 `resources/app/public/js/earn.js`

- L458-460（`renderGuestContent`）与 L588-590（`renderActivation`）两处：
  `const cap = 1000000;` → 改为读取元数据：
  ```js
  const cap = Number(plansCache?.activationMeta?.cap) > 0 ? Number(plansCache.activationMeta.cap) : 1000000;
  ```
  `activatedCount` 逻辑不变（后端已把 offset 计入）。
- 兜底常量 `FALLBACK_PLANS.activationMeta`（L315）保持不变（离线兜底）。

### 3.4 后台 UI `resources/app/public/js/operator-admin.js`

在 `renderAMiner()`（L1213-1304）渲染的 HTML 中，插入到「🔎 搜索筛选」卡片之前一张新卡片：

```html
<div class="admin-a-card">
  <h3>📈 矿机激活进度（前台展示）</h3>
  <p>控制「AxiX矿机 → 激活」页顶部「激活名额进度」进度条。已激活人数 = 真实确认激活数 + 后台补量，真实激活仍会继续累加。</p>
  <div class="admin-a-form-grid" style="grid-template-columns:1fr 1fr auto;gap:12px;align-items:flex-end">
    <label>激活名额总数<input id="am-prog-cap" type="number" min="1" step="1" value="${...}"></label>
    <label>已激活人数（前台显示）<input id="am-prog-count" type="number" min="0" step="1" value="${...}"></label>
    <label style="align-self:flex-end">${aBtn('💾 保存进度', { id:'am-prog-save' })}</label>
  </div>
  <div class="admin-inline-status" id="am-prog-status">真实确认激活 ${real} 人</div>
</div>
```

取值来自 `m.activationMeta`（`cap` / `activatedCount` / `activatedCountReal`）。

事件（在 `renderAMiner()` 末尾事件绑定区追加）：

```js
$id('am-prog-save')?.addEventListener('click', async () => {
  const cap = Number($id('am-prog-cap').value);
  const count = Number($id('am-prog-count').value);
  const st = $id('am-prog-status');
  if (!Number.isFinite(cap) || cap < 1) return toast('名额总数需 ≥ 1');
  if (!Number.isFinite(count) || count < 0) return toast('已激活人数需 ≥ 0');
  if (count > cap) return toast('已激活人数不能大于名额总数');
  st.textContent = '保存中...';
  try {
    await aApi('/activation/progress', { method:'POST', body: JSON.stringify({ cap, activatedCount: count }) });
    toast('✓ 已保存激活进度');
    await loadAMiner();
  } catch (e) { st.textContent = e.message; toast(e.message); }
});
```

### 3.5 静态资源版本号（必须同步，否则线上不生效）

- [page-loader.js](file:///c:/Users/cy020/Desktop/WG-Grid-Studio-完整成交账本/resources/app/public/js/page-loader.js#L5) `versions` 表新增 `'earn':'20261015-activation-progress-1'`（earn 当前走默认 `version`，改 earn.js 必须显式加版本）。
- [index.html](file:///c:/Users/cy020/Desktop/WG-Grid-Studio-完整成交账本/resources/app/public/index.html#L1429) 第 1429 行 `page-loader.js?v=` → `20261015-activation-progress-1`。
- [admin.html](file:///c:/Users/cy020/Desktop/WG-Grid-Studio-完整成交账本/resources/app/public/admin.html#L301) 第 301 行 `operator-admin.js?v=` → `20261015-activation-progress-1`。

## 4. 明确不做

- 不改 `a-token-activation-service.js` 的 `CAP = 1_000_000` 硬校验（名额上限拦截仍按真实计数，避免后台调显示值影响真实业务拦截）。
- 不改 `.cap-bar/.cap-fill` 样式、不改文案。
- 不引入新的 service_settings key。
- 不部署（部署需用户确认，且本次不得带上未部署的 AIX 市价单改动）。

## 5. 验证

1. `node --check` 四个改动文件：`src/a-token-service.js`、`src/a-token-admin-api.js`、`public/js/earn.js`、`public/js/operator-admin.js`。
2. 本地起服（`node src/server.js`，PORT=8082），后台登录后：
   - `POST /api/admin/a-token/activation/progress {cap:20000, activatedCount:1234}` → 返回 `activationMeta.activatedCount === 1234`。
   - `GET /api/a-token/plans` → `activationMeta = { cap:20000, activatedCount:1234 }`。
   - `GET /api/admin/a-token/miners` → 含 `activationMeta`。
   - 再 POST `{activatedCount:1300}`（不传 cap）→ cap 保持 20000。
3. 前台手动核对：「AxiX矿机 → 激活」进度条宽度 = 1234/20000 ≈ 6.17%（游客与已登录两种视图）。
4. 用户确认效果后再决定是否部署。
