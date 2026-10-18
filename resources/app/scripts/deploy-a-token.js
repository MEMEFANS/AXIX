/**
 * 部署 A 币（AToken）合约到 BSC 主网 / 测试网（不依赖第三方库，仅用 ethers v6 + Node.js 标准库）。
 *
 * 使用前先按 contracts/README-DEPLOY.md 的"方式 B"准备好：
 *   1) contracts/AToken.bytecode    — Remix 编译后导出的 BYTECODE（0x… 开头）
 *   2) contracts/AToken.abi.json    — Remix 编译后导出的 ABI JSON 数组
 *   3) .env 里填：
 *        DEPLOYER_PRIVATE_KEY=0x…（部署钱包私钥，必须有 BNB gas，不要提交 git）
 *        BSC_RPC_URL=https://bsc-dataseed.binance.org
 *        INITIAL_OWNER_ADDRESS=0x…   可选；不填时默认等于部署钱包地址
 *
 * 运行（请确保当前目录 = resources/app）：
 *   node scripts/deploy-a-token.js
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Wallet, ContractFactory, JsonRpcProvider, formatEther } from 'ethers';

const __DIR = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(__DIR, '..');
const ENV_PATH = resolve(APP_ROOT, '.env');
const BYTECODE_PATH = resolve(APP_ROOT, 'contracts/AToken.bytecode');
const ABI_PATH = resolve(APP_ROOT, 'contracts/AToken.abi.json');

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
const INITIAL_OWNER = process.env.INITIAL_OWNER_ADDRESS;

async function main() {
  if (!PRIVATE_KEY) {
    console.error('❌ 缺少 DEPLOYER_PRIVATE_KEY 环境变量。请在 resources/app/.env 中写入：\n\n   DEPLOYER_PRIVATE_KEY=0x你的部署钱包私钥\n');
    process.exit(1);
  }
  if (!existsSync(BYTECODE_PATH)) {
    console.error(
      '❌ 未找到编译产物 contracts/AToken.bytecode\n\n' +
      '   请按 contracts/README-DEPLOY.md 的 "方式 A" 前 3 步操作：\n' +
      '   1) 打开 https://remix.ethereum.org/  粘贴 A.sol 并编译（solc 0.8.20, optimization 200 runs）\n' +
      '   2) 在 Compilation Details 里复制 BYTECODE（0x 开头的整段）  →  存为 contracts/AToken.bytecode\n' +
      '   3) 复制 ABI JSON 数组  →  存为 contracts/AToken.abi.json\n'
    );
    process.exit(2);
  }
  const bytecode = readFileSync(BYTECODE_PATH, 'utf8').trim();
  if (!bytecode.startsWith('0x')) {
    console.error('❌ AToken.bytecode 内容必须以 0x 开头，请确认粘贴的是完整 BYTECODE。');
    process.exit(3);
  }
  const abi = existsSync(ABI_PATH)
    ? JSON.parse(readFileSync(ABI_PATH, 'utf8'))
    : [
        'constructor(address initialOwner)',
        'function name() view returns (string)',
        'function symbol() view returns (string)',
        'function decimals() view returns (uint8)',
        'function totalSupply() view returns (uint256)',
        'function owner() view returns (address)',
      ];

  const provider = new JsonRpcProvider(RPC_URL);
  const deployer = new Wallet(PRIVATE_KEY, provider);
  const initialOwner = INITIAL_OWNER || deployer.address;

  console.log('─────────────────────────────────────');
  console.log('RPC:            ' + RPC_URL);
  console.log('Deployer addr:  ' + deployer.address);
  console.log('Initial Owner:  ' + initialOwner);
  const balance = await provider.getBalance(deployer.address);
  console.log('Deployer BNB:   ' + formatEther(balance));
  if (balance <= 0n) {
    console.error('\n❌ 部署钱包没有 BNB，无法支付矿工费。请先转入至少 0.005 BNB 到 ' + deployer.address);
    process.exit(4);
  }
  console.log('─────────────────────────────────────\n');

  const factory = new ContractFactory(abi, bytecode, deployer);
  let gasEstimate;
  try {
    const deployTx = factory.getDeployTransaction(initialOwner);
    gasEstimate = await provider.estimateGas(deployTx);
  } catch (e) {
    console.error('❌ 部署交易 gas 预估失败，常见原因：\n' +
      '   - AToken.bytecode 不是完整的 CreationCode（漏了元数据部分？）\n' +
      '   - ABI 与 bytecode 来自不同编译轮次，请重新从 Remix 一起导出\n' +
      '   详细错误：' + (e?.shortMessage || e?.message || String(e)));
    process.exit(5);
  }
  const feeData = await provider.getFeeData();
  const gasPrice = feeData.gasPrice || 3_000_000_000n;
  const estCost = gasEstimate * gasPrice;
  console.log('预估 gas limit:   ' + gasEstimate.toString());
  console.log('预估 gas price:   ' + (gasPrice / 1_000_000_000n).toString() + ' gwei');
  console.log('预估矿工费约:     ' + formatEther(estCost) + ' BNB');
  console.log('\n⏳ 广播部署交易，等待 3 个区块确认（约 9 秒）…');

  const contract = await factory.deploy(initialOwner, { gasLimit: gasEstimate, gasPrice });
  const txResp = contract.deploymentTransaction();
  if (!txResp) throw new Error('未能创建部署交易');
  console.log('交易哈希:        ' + txResp.hash);
  const receipt = await txResp.wait(3);
  if (!receipt) throw new Error('交易未被确认');

  const addr = await contract.getAddress();
  const name = await contract.name().catch(() => '???');
  const sym = await contract.symbol().catch(() => '???');
  const ts = await contract.totalSupply().catch(() => 0n);
  const owner = await contract.owner().catch(() => '???');

  console.log('\n✅ 部署成功！');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('合约地址 A_TOKEN_CONTRACT_ADDRESS = ' + addr);
  console.log('交易哈希:                         ' + receipt.hash);
  console.log('区块号:                           ' + receipt.blockNumber);
  console.log('校验 name:                        ' + name);
  console.log('校验 symbol:                      ' + sym);
  console.log('校验 totalSupply:                 ' + formatEther(ts) + ' A');
  console.log('校验 owner:                       ' + owner);
  console.log('═══════════════════════════════════════════════════════════');
  console.log('\n👉 请立即把以下一行追加到 resources/app/.env：\n\n   A_TOKEN_CONTRACT_ADDRESS=' + addr + '\n');
  console.log('👉 然后按 contracts/README-DEPLOY.md "部署完成后必做清单"：');
  console.log('   1) transfer() 把 1～2 亿 A 转到你的平台提币热钱包');
  console.log('   2) 剩余转到冷钱包 或 直接 burn() 销毁');
  console.log('   3) （推荐）调用 renounceOwnership() 销毁 Owner 权限');
  console.log('   4) 到 Bscscan Verify 合约源码开源 ✅');
}

main().catch((e) => {
  console.error('\n💥 部署失败：' + (e?.shortMessage || e?.message || String(e)));
  if (e?.info?.error?.message) console.error('   RPC 详情：' + e.info.error.message);
  process.exit(99);
});
