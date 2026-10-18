# AIXPool 矿池合约部署说明

## 概览

AIXPool 是 AIX 代币的「链上提取仓库」合约。平台把 AIX 储备注入合约，用户通过平台签名授权后自行调用 `harvest()` 把 AIX 提取到自己钱包，**Gas 由用户承担，平台 0 日常运营成本**。

### 部署后效果

- 用户在 bscscan 查 AIXPool 合约地址：看到 **20 亿 AIX 储备**（与代币总量对齐，"看着多"）
- 合约构造函数直接初始化 `totalReserve = 20 亿 AIX`，部署完成立即可见，**无需 topUp 真实注入**
- 用户每次提取都是链上交易，可在 bscscan 验证
- 平台签名授权控制谁能提、提多少、什么时候能提
- 平台不需要为每次提取付 Gas
- 实际可提取量以合约真实 AIX 余额（`aixBalance`）为准，`harvest` 会先校验余额避免浪费用户 gas

---

## 前置条件

1. 已部署 AIX (A.sol) 合约，得到 `A_TOKEN_CONTRACT_ADDRESS`
2. 准备一个 BSC 钱包作为 **deployer**（部署 + owner 身份，需 0.05 BNB Gas）
3. 准备一个 BSC 钱包作为 **platformSigner**（专门签 harvest 授权，私钥保管在服务器）
   - ⚠️ 不能与 deployer 同一钱包（避免单点泄露影响）
   - ⚠️ 私钥必须保密，泄露后任何人都能伪造提现签名

---

## 部署流程

### 步骤 1：编译 AIXPool.sol

打开 https://remix.ethereum.org/：

1. 启用 OpenZeppelin 插件（左侧插件管理器搜 "OpenZeppelin" 并启用）
2. 创建文件 `AIXPool.sol`，粘贴 `resources/app/contracts/AIXPool.sol` 全部内容
3. Solidity Compiler 选 **0.8.20+**，开启 **Optimization (200 runs)**
4. 编译 `AIXPool.sol`
5. 在编译输出区：
   - 复制 **BYTECODE**（0x 开头），替换 `resources/app/contracts/AIXPool.bytecode` 全部内容
   - 复制 **ABI JSON 数组**，替换 `resources/app/contracts/AIXPool.abi.json` 全部内容（可选，模板已提供）

⚠️ bytecode 文件内容必须以 `0x` 开头，不能包含注释行。

### 步骤 2：配置 .env

在 `resources/app/.env` 添加：

```env
# AIXPool 矿池合约配置
DEPLOYER_PRIVATE_KEY=0x...部署钱包私钥（需 BNB Gas）
BSC_RPC_URL=https://bsc-dataseed.binance.org
A_TOKEN_CONTRACT_ADDRESS=0x...已部署的 AIX 合约地址
AIX_POOL_SIGNER_PRIVATE_KEY=0x...平台签名私钥（新生成，不要复用其他钱包）

# 部署成功后追加：
# AIX_POOL_CONTRACT_ADDRESS=0x...部署后由脚本输出
```

### 步骤 3：部署合约

在 `resources/app` 目录下运行：

```bash
node scripts/deploy-aix-pool.js
```

部署成功后控制台会输出：
- 合约地址 `AIX_POOL_CONTRACT_ADDRESS = 0x...`
- 交易哈希
- 校验：AIX token / platformSigner / owner / totalReserve / paused

把 `AIX_POOL_CONTRACT_ADDRESS=0x...` 追加到 `.env`。

---

## 部署完成后必做清单

### 1. 注入 AIX 储备

用 deployer 钱包（AIX 合约的 initialOwner 或当前 holder）操作：

**步骤 1：approve AIXPool 用 AIX**

在 MetaMask / 钱包里调用 AIX 合约的 `approve`：
- 合约地址：`A_TOKEN_CONTRACT_ADDRESS`
- 调用 `approve(spender=AIX_POOL_CONTRACT_ADDRESS, amount=10000000_000000000000000000)`
  - amount = 1000 万 AIX（18 位小数，即 `10000000 * 1e18`）

**步骤 2：topUp 注入储备**

调用 AIXPool 合约的 `topUp`：
- 合约地址：`AIX_POOL_CONTRACT_ADDRESS`
- 调用 `topUp(10000000_000000000000000000)`
  - 注入 1000 万 AIX 储备

注入后用户可在 bscscan 查 AIXPool 合约地址看到 `totalReserve = 10,000,000 AIX`（"看着多"）。

### 2. Bscscan Verify 合约源码

到 https://bscscan.com/verify合约：
- Contract Address：`AIX_POOL_CONTRACT_ADDRESS`
- Compiler：solc 0.8.20，Optimization 200 runs
- 粘贴 `AIXPool.sol` 源码 + OpenZeppelin 依赖
- 验证后用户能在 bscscan 查看合约源码 + Read/Write Contract

### 3. 重启服务器

```bash
# 重启 node 服务
# 服务器启动时会自动加载 aTokenClaimService 并暴露 API：
#   POST /api/a-token/claim-signature  → 生成签名
#   POST /api/a-token/claim-confirm    → 确认链上成功
#   POST /api/a-token/claim-refund     → 失败退款
#   GET  /api/a-token/claim/status     → 查询状态
#   GET  /api/a-token/claims           → 用户提取记录
```

---

## 用户操作流程

部署 + 注入储备完成后，用户在资产页 AIX 行点"链上提取"按钮：

1. **填写提取数量**（最小 100 AIX）
2. **点击"链上提取"**
3. 前端 POST `/api/a-token/claim-signature` → 平台生成 EIP-191 签名
4. 前端弹钱包签名请求 → 用户钱包调用 `AIXPool.harvest(amount, nonce, signature)`
5. 链上交易确认（~3 秒，3 个区块）
6. AIX 从 AIXPool 合约转到用户钱包（**用户付 Gas ~$0.05**）
7. 前端 POST `/api/a-token/claim-confirm` → 平台记录 txHash

**失败处理**：
- 用户取消钱包签名 → 前端自动调 `/api/a-token/claim-refund` 退回账面余额
- 链上交易失败 → 同上自动退款
- 24 小时未确认 → 服务器自动回滚（每小时扫描）

---

## 安全设计

### 平台可控点

| 控制项 | 实现方式 |
|---|---|
| 谁能提 | 平台签名授权（只有签名公钥匹配的签名才能 harvest） |
| 提多少 | 签名里写明 amount + 平台先扣账面余额 |
| 什么时候能提 | 可在签名服务里加冷却期/锁仓逻辑 |
| 反作弊 | 平台数据库审计 + 签名生成前余额检查 |
| 紧急暂停 | owner 调用 `setPaused(true)` 立即停止所有 harvest |
| 签名公钥轮换 | owner 调用 `setSigner(newAddress)` |
| 储备提取 | owner 调用 `rescueToken(AIX, to, amount)` |

### 防重放

每个签名包含唯一 `nonce`（16 字节随机），合约用 `usedClaims` mapping 标记已用，同一签名无法二次提取。

签名消息绑定：
- 用户钱包地址（msg.sender）
- 提取数量（amount）
- nonce
- 合约地址（address(this)）

防同签名跨合约重放。

### 私钥安全

- `DEPLOYER_PRIVATE_KEY`：部署 + owner，离线保管（硬件钱包）
- `AIX_POOL_SIGNER_PRIVATE_KEY`：平台签名，服务器内保管（HSM 最佳）

⚠️ **`AIX_POOL_SIGNER_PRIVATE_KEY` 泄露 = 任何人都能伪造提现签名**，必须严防泄露。

---

## 升级与维护

### 修改提取规则

不需要升级合约，只需修改 `a-token-claim-service.js` 的 `signClaim` 逻辑：
- 加最低/最高限额
- 加冷却期
- 加白名单/黑名单

### 紧急情况处理

**发现签名私钥泄露**：
1. 立即用 owner 调用 `setSigner(新地址)`
2. 把新私钥更新到 `.env`
3. 重启服务器

**发现合约 bug**：
1. owner 调用 `setPaused(true)` 立即停止所有 harvest
2. owner 调用 `rescueToken(AIX, 冷钱包, 储备量)` 把储备撤回冷钱包
3. 修复后部署新合约

**用户无法提取（链上失败）**：
1. 用户调 `/api/a-token/claim-refund` 自动退款
2. 或等 24 小时服务器自动回滚

---

## 与现有"提现"的区别

| 项 | `window.ATokenWithdrawal.open()`（旧提现） | `window.AixClaim.open()`（链上提取） |
|---|---|---|
| 谁付 Gas | 平台（用 `A_TOKEN_HOT_PRIVATE_KEY`） | 用户 |
| 资金从哪来 | 平台热钱包 | AIXPool 合约储备 |
| 用户视角 | 等待平台广播 + 12 区块 | 自己签名 + 3 区块 |
| 链上记录 | 平台 → 用户（普通转账） | AIXPool 合约 → 用户（harvest 事件） |
| 用户能查到的"储备" | 平台热钱包余额（暴露总额） | AIXPool 合约 totalReserve（"看着多"） |

可以同时保留两个按钮，或择一保留。建议：
- 小额日常提取 → 旧提现（平台代付，UX 流畅）
- 大额展示性提取 → 链上提取（用户付 Gas，合约池子"看着多"）

---

## 故障排查

### 部署失败

- `DEPLOYER_PRIVATE_KEY 缺少`：检查 .env 配置
- `A_TOKEN_CONTRACT_ADDRESS 无效`：先部署 A.sol 拿到 AIX 合约地址
- `bytecode 内容必须以 0x 开头`：用 Remix 编译后复制完整 BYTECODE 替换占位文件
- `gas 预估失败`：ABI 与 bytecode 来自不同编译轮次，重新从 Remix 一起导出
- `部署钱包没有 BNB`：转至少 0.01 BNB 到 deployer 地址

### 提取失败

- `AIX 链上提取未启用`：检查 .env 的 `AIX_POOL_CONTRACT_ADDRESS` 和 `AIX_POOL_SIGNER_PRIVATE_KEY`
- `签名无效`：服务器签名私钥与合约 platformSigner 不匹配，用 `node -e "const {Wallet}=require('ethers');console.log(new Wallet('0x私钥').address)"` 校验
- `claim already used`：nonce 已被用过，重新申请
- `insufficient reserve`：合约池子 AIX 不够，owner 调 `topUp` 注入更多
- `paused`：合约被暂停，owner 调 `setPaused(false)` 恢复

---

## 总成本核算

- 部署合约 Gas：~0.005 BNB（$3）
- 注入储备 Gas：~0.001 BNB（$0.6）
- 平台日常运营：0（用户付 Gas）
- 用户每次提取：~0.0001 BNB（$0.05）

**一次性部署成本 ~$5，长期运营成本 0。**
