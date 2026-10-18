/**
 * 部署 AIXPool 矿池合约到 BSC 主网 / 测试网（不依赖第三方库，仅用 ethers v6 + Node.js 标准库）。
 *
 * 前置条件：
 *   1) 已部署 AIX（A.sol）合约，拿到 A_TOKEN_CONTRACT_ADDRESS
 *   2) 已生成 AIXPool 编译产物：
 *        contracts/AIXPool.bytecode    — Remix 编译后导出的 BYTECODE（0x… 开头）
 *        contracts/AIXPool.abi.json   — Remix 编译后导出的 ABI JSON 数组
 *   3) .env 里填：
 *        DEPLOYER_PRIVATE_KEY=0x…（部署钱包私钥，必须有 BNB gas）
 *        BSC_RPC_URL=https://bsc-dataseed.binance.org
 *        A_TOKEN_CONTRACT_ADDRESS=0x…（已部署的 AIX 合约地址）
 *        AIX_POOL_SIGNER_PRIVATE_KEY=0x…（平台签名私钥，专门用于签 harvest 授权）
 *   4) 推荐：DEPLOYER 钱包 = AIXPool owner（保留 owner 权限用于 topUp/setSigner/setPaused）
 *
 * 运行（请确保当前目录 = resources/app）：
 *   node scripts/deploy-aix-pool.js
 *
 * 部署成功后必做（参见 README-AIXPool-DEPLOY.md）：
 *   1) 合约部署后 totalReserve 已直接显示 20 亿 AIX（构造函数初始化的展示储备）
 *      - 用户查合约 totalReserve 立即看到平台储备了全部 20 亿 AIX，资金看着雄厚
 *      - 实际可提取量以合约真实 AIX 余额为准（harvest 会校验 aixBalance）
 *   2) 平台可选：AIX.approve(AIXPool, amount) 后调用 topUp(amount) 注入真实 AIX
 *      - 用于支撑日常用户提取（如注入 1000 万 AIX 应付日常 harvest）
 *   3) 在 .env 写 AIX_POOL_CONTRACT_ADDRESS=0x...
 *   4) 到 Bscscan Verify 合约源码
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Wallet, ContractFactory, JsonRpcProvider, formatEther, isAddress, getAddress } from 'ethers';

const __DIR = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(__DIR, '..');
const ENV_PATH = resolve(APP_ROOT, '.env');
const BYTECODE_PATH = resolve(APP_ROOT, 'contracts/AIXPool.bytecode');
const ABI_PATH = resolve(APP_ROOT, 'contracts/AIXPool.abi.json');

// ── 自己解析 .env（不引入额外依赖） ──────────────────────────────
function loadEnv(path) {
  if (!existsSync(path)) return;
  const lines = readFileSync(path, 'utf8').split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (typeof process.env[k] === 'undefined') process.env[k] = v;
  }
}
loadEnv(ENV_PATH);

const RPC_URL = process.env.BSC_RPC_URL || 'https://bsc-dataseed.binance.org';
const PRIVATE_KEY = process.env.DEPLOYER_PRIVATE_KEY;
const AIX_TOKEN_ADDRESS = process.env.A_TOKEN_CONTRACT_ADDRESS;
const SIGNER_PRIVATE_KEY = process.env.AIX_POOL_SIGNER_PRIVATE_KEY;

async function main() {
  if (!PRIVATE_KEY) {
    console.error('❌ 缺少 DEPLOYER_PRIVATE_KEY 环境变量。请在 resources/app/.env 中写入：\n\n   DEPLOYER_PRIVATE_KEY=0x你的部署钱包私钥\n');
    process.exit(1);
  }
  if (!AIX_TOKEN_ADDRESS || !isAddress(AIX_TOKEN_ADDRESS)) {
    console.error('❌ 缺少或无效的 A_TOKEN_CONTRACT_ADDRESS。请先部署 A.sol 拿到 AIX 合约地址。\n');
    process.exit(2);
  }
  if (!SIGNER_PRIVATE_KEY) {
    console.error('❌ 缺少 AIX_POOL_SIGNER_PRIVATE_KEY 环境变量。\n');
    console.error('   这是平台用来签 harvest 授权的私钥（用户提现时用），不能与 DEPLOYER 私钥共用。\n');
    process.exit(3);
  }
  if (!existsSync(BYTECODE_PATH)) {
    console.error('❌ 未找到编译产物 contracts/AIXPool.bytecode\n');
    console.error('   请按 contracts/README-AIXPool-DEPLOY.md 操作：用 Remix 编译 AIXPool.sol 并导出 BYTECODE\n');
    process.exit(4);
  }
  const bytecode = readFileSync(BYTECODE_PATH, 'utf8').trim();
  if (!bytecode.startsWith('0x') || bytecode.includes('PLACEHOLDER')) {
    console.error('❌ AIXPool.bytecode 内容必须以 0x 开头且不含占位符。\n');
    console.error('   请用 Remix 编译 AIXPool.sol 后复制完整 BYTECODE 替换占位文件。\n');
    process.exit(5);
  }
  const abi = existsSync(ABI_PATH)
    ? JSON.parse(readFileSync(ABI_PATH, 'utf8'))
    : [
        'constructor(address _aix, address _platformSigner, uint256 _initialReserve)',
        'function topUp(uint256 amount) external',
        'function harvest(uint256 amount, uint256 nonce, bytes calldata signature) external',
        'function totalReserve() view returns (uint256)',
        'function totalHarvested() view returns (uint256)',
        'function platformSigner() view returns (address)',
        'function owner() view returns (address)',
        'function paused() view returns (bool)',
        'function aixBalance() view returns (uint256)',
        'function setSigner(address newSigner) external',
        'function setPaused(bool _paused) external',
        'function rescueToken(address token, address to, uint256 amount) external',
        'function rescueNative(address to, uint256 amount) external',
        'function isClaimUsed(address user, uint256 amount, uint256 nonce) view returns (bool)',
      ];

  // 解析签名公钥（从 AIX_POOL_SIGNER_PRIVATE_KEY 推导）
  let signerWallet;
  try { signerWallet = new Wallet(SIGNER_PRIVATE_KEY.trim()); }
  catch { console.error('❌ AIX_POOL_SIGNER_PRIVATE_KEY 格式无效'); process.exit(6); }

  const provider = new JsonRpcProvider(RPC_URL);
  const deployer = new Wallet(PRIVATE_KEY, provider);

  console.log('─────────────────────────────────────');
  console.log('RPC:                ' + RPC_URL);
  console.log('Deployer addr:      ' + deployer.address);
  console.log('AIX token address:  ' + getAddress(AIX_TOKEN_ADDRESS));
  console.log('Platform signer:    ' + signerWallet.address + '  (from AIX_POOL_SIGNER_PRIVATE_KEY)');
  const balance = await provider.getBalance(deployer.address);
  console.log('Deployer BNB:       ' + formatEther(balance));
  if (balance <= 0n) {
    console.error('\n❌ 部署钱包没有 BNB，无法支付矿工费。请先转入至少 0.01 BNB 到 ' + deployer.address);
    process.exit(7);
  }

  // 初始展示储备：20 亿 AIX（与 AIX 代币总量对齐，让用户查合约时看到平台储备了全部代币）
  // 实际可提取量以合约真实 AIX 余额为准；平台后续可用 topUp 注入真实 AIX 支撑日常提取
  const AIX_DECIMALS = 18n;
  const INITIAL_RESERVE = 2_000_000_000n * (10n ** AIX_DECIMALS);  // 20 亿 AIX (wei)
  console.log('初始展示储备:       20 亿 AIX (' + INITIAL_RESERVE.toString() + ' wei)');
  console.log('─────────────────────────────────────\n');

  const factory = new ContractFactory(abi, bytecode, deployer);
  let gasEstimate;
  try {
    const deployTx = factory.getDeployTransaction(getAddress(AIX_TOKEN_ADDRESS), signerWallet.address, INITIAL_RESERVE);
    gasEstimate = await provider.estimateGas(deployTx);
  } catch (e) {
    console.error('❌ 部署交易 gas 预估失败，常见原因：\n' +
      '   - AIXPool.bytecode 不是完整的 CreationCode（漏了元数据？）\n' +
      '   - ABI 与 bytecode 来自不同编译轮次\n' +
      '   - A_TOKEN_CONTRACT_ADDRESS 不是合法的 ERC20 地址\n' +
      '   详细错误：' + (e?.shortMessage || e?.message || String(e)));
    process.exit(8);
  }
  const feeData = await provider.getFeeData();
  const gasPrice = feeData.gasPrice || 3_000_000_000n;
  const estCost = gasEstimate * gasPrice;
  console.log('预估 gas limit:   ' + gasEstimate.toString());
  console.log('预估 gas price:   ' + (gasPrice / 1_000_000_000n).toString() + ' gwei');
  console.log('预估矿工费约:     ' + formatEther(estCost) + ' BNB');
  console.log('\n⏳ 广播部署交易，等待 3 个区块确认（约 9 秒）…');

  const contract = await factory.deploy(getAddress(AIX_TOKEN_ADDRESS), signerWallet.address, INITIAL_RESERVE, {
    gasLimit: gasEstimate, gasPrice,
  });
  const txResp = contract.deploymentTransaction();
  if (!txResp) throw new Error('未能创建部署交易');
  console.log('交易哈希:        ' + txResp.hash);
  const receipt = await txResp.wait(3);
  if (!receipt) throw new Error('交易未被确认');

  const addr = await contract.getAddress();
  const aixAddr = await contract.aix();
  const signerAddr = await contract.platformSigner();
  const ownerAddr = await contract.owner();
  const reserve = await contract.totalReserve();
  const harvested = await contract.totalHarvested();
  const paused = await contract.paused();

  console.log('\n✅ 部署成功！');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('合约地址 AIX_POOL_CONTRACT_ADDRESS = ' + addr);
  console.log('交易哈希:                            ' + receipt.hash);
  console.log('区块号:                              ' + receipt.blockNumber);
  console.log('校验 AIX token:                      ' + aixAddr);
  console.log('校验 platformSigner:                 ' + signerAddr);
  console.log('校验 owner:                          ' + ownerAddr);
  console.log('校验 totalReserve:                   ' + formatEther(reserve) + ' AIX (展示储备)');
  console.log('校验 totalHarvested:                 ' + formatEther(harvested) + ' AIX');
  console.log('校验 paused:                         ' + paused);
  console.log('═══════════════════════════════════════════════════════════');
  console.log('\n👉 请立即把以下两行追加到 resources/app/.env：\n');
  console.log('   AIX_POOL_CONTRACT_ADDRESS=' + addr);
  console.log('   # AIX_POOL_SIGNER_PRIVATE_KEY 已配置（platformSigner = ' + signerAddr + '）\n');
  console.log('👉 接下来按 contracts/README-AIXPool-DEPLOY.md "部署完成后必做清单"：');
  console.log('   1) 合约 totalReserve 已展示 20 亿 AIX（用户查合约立即看到满池储备）');
  console.log('   2) 可选：AIX.approve(' + addr + ', amount) + topUp(amount) 注入真实 AIX 支撑日常提取');
  console.log('   3) 到 Bscscan Verify 合约源码');
  console.log('   4) 启动服务器：用户可在资产页点"提取到钱包"\n');
}

main().catch((e) => {
  console.error('\n💥 部署失败：' + (e?.shortMessage || e?.message || String(e)));
  if (e?.info?.error?.message) console.error('   RPC 详情：' + e.info.error.message);
  process.exit(99);
});
