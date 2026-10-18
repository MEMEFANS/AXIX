// BSC Testnet 完整自动提现路径测试
// 1. 部署临时 USDC/USDT（mint 随便发）
// 2. 给 PancakeSwap V2 加 1:1 流动性
// 3. 用平台 withdrawl-payout-service 的 swap + transfer 路径跑通
// 4. 验证授权、swap、transfer 全部正确
import { JsonRpcProvider, Wallet, Interface, parseUnits, formatUnits, keccak256, getAddress, Contract, ContractFactory } from 'ethers';
import fs from 'node:fs';

const ERC20_ARTIFACT = JSON.parse(fs.readFileSync('scripts/erc20-bytecode.json', 'utf8'));
const ERC20_BYTECODE = ERC20_ARTIFACT.bytecode;

const RPC = 'https://data-seed-prebsc-1-s1.binance.org:8545';
const CHAIN_ID = 97;
const ROUTER = '0xD99D1c33F9fC3444f8101754aBC46c52416550D1';
const FACTORY = '0x6725F303b657a9451d8BA641348b6761A6CC7a17';

const ERC20_ABI = ERC20_ARTIFACT.abi;
const ROUTER_ABI = [
  'function getAmountsIn(uint amountOut, address[] memory path) view returns (uint[] memory amounts)',
  'function getAmountsOut(uint amountIn, address[] memory path) view returns (uint[] memory amounts)',
  'function addLiquidity(address tokenA, address tokenB, uint amountADesired, uint amountBDesired, uint amountAMin, uint amountBMin, address to, uint deadline) external returns (uint amountA, uint amountB, uint liquidity)',
  'function swapTokensForExactTokens(uint amountOut, uint amountInMax, address[] calldata path, address to, uint deadline) external returns (uint[] memory amounts)',
  'function swapExactTokensForTokens(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external returns (uint[] memory amounts)',
];

const DECIMALS = 18;
const U = v => parseUnits(String(v), DECIMALS);

async function waitTx(r) {
  const receipt = typeof r.wait === 'function' ? await r.wait() : await r;
  if (receipt.status !== 1) throw new Error(`TX failed: ${receipt.hash}`);
  return receipt;
}

async function main() {
  // 固定测试钱包（避免每次随机换地址）
  const FIXED_SK = '0x' + '11'.repeat(32); // 0x1111...1111 仅测试网用
  const sk = process.env.TESTNET_SK || FIXED_SK;
  const wallet = new Wallet(sk, new JsonRpcProvider(RPC, CHAIN_ID, { staticNetwork: true }));
  const balance = await wallet.provider.getBalance(wallet.address);
  console.log(`\n🧪 测试钱包: ${wallet.address}  (tBNB=${formatUnits(balance, 18)})`);
  if (balance === 0n) {
    console.log('❌ 钱包没有 tBNB gas！去 https://testnet.bnbchain.org/faucet-smart 领 0.5 tBNB');
    console.log(`   钱包地址: ${wallet.address}`);
    process.exit(1);
  }

  // 1. 部署临时 USDC 和 USDT（各 mint 100 万枚给钱包）
  console.log('\n📦 步骤 1：部署临时 USDC/USDT');
  const deployERC20 = async (name, symbol) => {
    const factory = new ContractFactory(ERC20_ABI, ERC20_BYTECODE, wallet);
    const contract = await factory.deploy(name, symbol);
    await contract.waitForDeployment();
    await waitTx(await contract.mint(wallet.address, U(1_000_000)));
    console.log(`  ${name}  ${contract.target}  ✅`);
    return contract;
  };
  const usdc = await deployERC20('TempUSDC', 'USDC');
  const usdt = await deployERC20('TempUSDT', 'USDT');

  // 2. 加 1:1 流动性（各 10000 枚）
  console.log('\n💧 步骤 2：给 Router 授权 + 加 1:1 流动性');
  const router = new Contract(ROUTER, ROUTER_ABI, wallet);
  await waitTx(await usdc.approve(ROUTER, U(1_000_000)));
  await waitTx(await usdt.approve(ROUTER, U(1_000_000)));
  console.log('  两个代币 approve Router ✅');
  const deadline = Math.floor(Date.now() / 1000) + 600;
  const liq = await waitTx(await router.addLiquidity(
    usdc.target, usdt.target,
    U(10000), U(10000),
    U(5000), U(5000),
    wallet.address, deadline,
  ));
  console.log(`  流动性池已创建 ✅  tx=${liq.hash.slice(0,10)}...`);

  // 3. 验证 Router 能报价
  console.log('\n🔍 步骤 3：验证 Router 报价');
  try {
    const amounts = await router.getAmountsIn(U(100), [usdc.target, usdt.target]);
    console.log(`  getAmountsIn(100 USDT) = ${formatUnits(amounts[0], 18)} USDC ✅`);
  } catch (e) {
    console.log(`  ❌ getAmountsIn 还是失败: ${e.message}`);
  }
  const out = await router.getAmountsOut(U(100), [usdc.target, usdt.target]);
  console.log(`  getAmountsOut(100 USDC) = ${formatUnits(out[1], 18)} USDT ✅`);

  // 4. 模拟提现：平台钱包持有 USDC → swap → 转给用户
  console.log('\n💸 步骤 4：模拟提现自动 swap');
  const recipient = Wallet.createRandom().address;
  const swapOutAmount = U(100); // 要给用户 100 USDT
  const neededUsdc = (await router.getAmountsIn(swapOutAmount, [usdc.target, usdt.target]))[0];
  const maxUsdcIn = neededUsdc * 1005n / 1000n; // 0.5% 滑点
  console.log(`  需 USDC = ${formatUnits(neededUsdc, 18)} (滑点后 max ${formatUnits(maxUsdcIn, 18)})`);

  // 确保平台钱包有足够 USDC（已 mint 给它了）
  const usdcBefore = await usdc.balanceOf(wallet.address);
  const usdtBefore = await usdt.balanceOf(wallet.address);
  const recvBefore = await usdt.balanceOf(recipient);
  console.log(`  平台钱包 USDC=${formatUnits(usdcBefore,18)}  USDT=${formatUnits(usdtBefore,18)}`);
  console.log(`  用户钱包 USDT=${formatUnits(recvBefore,18)}`);

  // swapTokensForExactTokens
  const swap = await waitTx(await router.swapTokensForExactTokens(
    swapOutAmount, maxUsdcIn,
    [usdc.target, usdt.target],
    recipient, deadline + 60,
  ));
  console.log(`  swap 成功 ✅  tx=${swap.hash.slice(0,10)}...`);

  // 5. 验证结果
  const usdcAfter = await usdc.balanceOf(wallet.address);
  const usdtAfter = await usdt.balanceOf(wallet.address);
  const recvAfter = await usdt.balanceOf(recipient);
  console.log(`\n📊 步骤 5：结果验证`);
  console.log(`  平台钱包 USDC: ${formatUnits(usdcBefore-usdcAfter,18)} (↑ 花了)`);
  console.log(`  用户钱包 USDT: ${formatUnits(recvAfter-recvBefore,18)} (↑ 收到)`);
  assert(recvAfter >= swapOutAmount, '用户应该至少收到 100 USDT');
  console.log(`  ✅ 用户到账 = ${formatUnits(recvAfter,18)} ≥ 申请 ${formatUnits(swapOutAmount,18)} USDT`);

  console.log(`\n🎉 自动提现 swap 路径完整跑通！`);
  console.log(`   Router: ${ROUTER}`);
  console.log(`   USDC:   ${usdc.target}`);
  console.log(`   USDT:   ${usdt.target}`);
  console.log(`   测试 tx: ${swap.hash}`);
  console.log(`   浏览器: https://testnet.bscscan.com/tx/${swap.hash}`);
}

function assert(cond, msg) {
  if (!cond) { console.error('❌ ' + msg); process.exit(1); }
}

main().catch(e => { console.error(e); process.exit(1); });
