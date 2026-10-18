# A 币（AToken）· 合约与部署指南

> 目标：把 **A.sol** 部署到 BSC 主网，得到链上合约地址（例如 `0xAbCd...1234`），
> 随后填到服务器 `.env` 的 `A_TOKEN_CONTRACT_ADDRESS` 里，前端就能在"钱包资产页"自动
> 添加该代币，并支持用户向平台充值 A / 平台向用户提币 A。

---

## 一、合约功能一览

| 特性 | 说明 |
|---|---|
| 代币符号 / 全称 | `A` / `A Coin`（需要改名字的话直接编辑 `A.sol` 里构造函数中那两行字符串） |
| 总量 | **10 亿 A（1,000,000,000 × 10¹⁸）**，在部署时一次性 mint 给部署者钱包，**合约内不再提供 mint 函数** |
| 精度 | 18 位（与 ETH/BNB 一致，与平台内盘 `A_TOKEN_DECIMALS = 18` 对齐） |
| 销毁 | 所有持币用户都可以调用标准 `burn(uint256 amount)` 或 `burnFrom(account, amount)` 永久销毁自己的 A |
| EIP-2612 Permit | 支持链下签名授权（未来若上薄饼 / 自建 Router 做免 approve 交易可直接用） |
| Owner 权限 | 仅 1 个：`emergencyWithdraw(token, amount)` — 从合约地址提走误转进来的 BNB / 任意代币 |
| 安全推荐 | 部署完成后执行 `renounceOwnership()`，把 Owner 地址清为 0，任何人无法再调用 emergencyWithdraw，完全去中心 |

---

## 二、3 种部署方式（任选一种，推荐 A）

### 方式 A · Remix 在线部署（最省心，零依赖，不用装 solc）

1. 打开 https://remix.ethereum.org/
2. **左侧 Files 面板** → 点 `+` 新建文件，粘贴本目录的 `A.sol` 全部内容并保存
3. **Solidity Compiler** 页 → 选 `0.8.20+commit...`，Compiler config 里勾选 `Enable optimization: 200 runs`，
   点 **Compile A.sol**，等编译完成
4. **Deploy & Run Transactions** 页：
   - Environment 选 **Injected Provider — MetaMask**
   - 把 MetaMask 切到 **BSC 主网（Chain ID 56）**，确保部署钱包里有至少 **0.003～0.01 BNB** 的 gas
   - **CONTRACT** 下拉选 `AToken`
   - **Deploy** 按钮前的 `initialOwner` 输入框填你的 Owner 钱包地址（一般就是你连接的这个钱包地址即可）
   - 点 **Deploy** → MetaMask 弹出确认 → 等待链上确认
5. 确认后在左侧 **Deployed Contracts** 里就能看到合约地址，复制下来 → 填到服务器 `.env`：
   ```
   A_TOKEN_CONTRACT_ADDRESS=0x你的合约地址
   ```

### 方式 B · 用本项目附带的脚本部署（先在 Remix 拿到编译产物）

1. 按方式 A 的前 3 步在 Remix 编译通过后，**Compiler 页最下方点 `Compilation Details` → 复制 `BYTECODE`
   整个字符串（以 `0x` 开头）到剪贴板**；同时复制 `ABI` 整个 JSON 数组
2. 在本目录新建两个文件：
   ```
   resources/app/contracts/AToken.bytecode   (内容就是刚才的 0x…BYTECODE)
   resources/app/contracts/AToken.abi.json   (内容就是刚才的 ABI JSON 数组)
   ```
3. 在 `.env` 里加：
   ```
   DEPLOYER_PRIVATE_KEY=你的部署钱包私钥（0x...，不要泄露给任何人！）
   BSC_RPC_URL=https://bsc-dataseed.binance.org
   ```
4. 运行：
   ```bash
   cd resources/app
   node scripts/deploy-a-token.js
   ```
5. 控制台会打印：
   ```
   🚀 Deployed AToken at:  0xAbCd...1234
   🎯 InitialOwner (Owner / 全量接收地址):  0xYourWallet
   ```
   把 `0xAbCd...1234` 填进 `.env` 的 `A_TOKEN_CONTRACT_ADDRESS`

### 方式 C · Hardhat 工程（以后要加资金池 / 质押 / 矿机链上合约再用）

如需部署全套合约再告诉我，会补 `hardhat.config.js` + `@nomicfoundation/hardhat-toolbox` + 测试。目前只部署 1 份
代币合约，以上 A / B 两种方式就够了。

---

## 三、部署完成后必做清单（按顺序）

```
  在 Remix / Bscscan Write Contract 页面连接 Owner 钱包依次调用：
```

| 步骤 | 函数 | 参数 | 目的 |
|---|---|---|---|
| 1 | `transfer(to, value)` | to=**你的平台提币热钱包地址**，value=预留的提币准备金（例如 `200000000000000000000000000` = 2 亿 A） | 让用户提币时即时到账，不用每次都从 Owner 冷钱包转 |
| 2 | `transfer(to, value)` 或 `burn(value)` | to=**你的多签/冷钱包地址** 转剩余 8 亿，或者直接 `burn` 掉不想流通的部分 | 锁仓 / 提前通缩 |
| 3（可选但推荐） | `renounceOwnership()` | 无参数 | 彻底销毁 Owner 权限，除了标准 `transfer / approve / burn / permit` 之外，任何人（包括你）都不能对合约做任何非标准操作，社区最安心 |

完成后把 **提币热钱包地址** 和 **该钱包私钥** 分别填到 `.env`：
```
# 可选，仅当你要做"用户提币 A → 链上自动 transfer"时配置
A_TOKEN_HOT_WALLET=你的提币热钱包地址
A_TOKEN_HOT_PRIVATE_KEY=对应的私钥（不要提交 git，仅允许放在服务器本地）
```
（现在的代码里默认还没开自动提币功能，只做记账 —— 需要时告诉我，补一个 `/api/a-token/withdraw` 接口即可）

---

## 四、在 Bscscan 上 Verify 合约（开源验证，可选但强烈推荐）

1. 打开 `https://bscscan.com/address/你的合约地址#code` → 点 **Verify and Publish**
2. 选 **Solidity (Single file)** → Compiler `v0.8.20+commit.a1b79de6` → EVM Version `default`
3. Optimization → **Yes, 200 runs**
4. Enter the Solidity Contract Code：直接把 `A.sol` 整段粘贴
5. Constructor Arguments ABI-encoded：留空（因为 ABI v2 编码会自动解析）
6. 勾选 "I agree..." 点 Verify，等 30 秒左右 → 页面出现 ✅ 小绿勾，所有人都可以看到源码。

---

## 五、常见参数速查

与后端 `a-token-service.js` 完全一致：

```
总量:            1,000,000,000 A  (10^9 * 10^18 units)
初始价格:        0.1 USDT / A  (后台可调，不受合约约束)
通缩销毁上限:    1 亿 A（= 总量 10%，后端记账约束，合约不强制——合约允许 burn 任意数量）
```
