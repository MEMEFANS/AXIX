// BSC Testnet 提现自动放款路径探测脚本
// 先确认：RPC 通 → 合约有代码 → USDC/USDT 有池子能 swap
import { JsonRpcProvider, Interface, formatUnits, parseUnits, Wallet, keccak256, isAddress, getAddress } from 'ethers';

const RPC = 'https://data-seed-prebsc-1-s1.binance.org:8545';
const CHAIN_ID = 97;
const USDT = '0x337610d27c682E347C9cD60BD4b3b107C9d34dDd';
const USDC = '0x64544969ed7EBf5f083679233325356EbE738930';
const ROUTER = '0xD99D1c33F9fC3444f8101754aBC46c52416550D1';

const ERC20_ABI = ['function balanceOf(address) view returns (uint256)', 'function decimals() view returns (uint8)', 'function symbol() view returns (string)'];
const ROUTER_ABI = [
  'function getAmountsIn(uint amountOut, address[] memory path) view returns (uint[] memory amounts)',
  'function getAmountsOut(uint amountIn, address[] memory path) view returns (uint[] memory amounts)',
  'function swapExactTokensForTokens(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external returns (uint[] memory amounts)',
  'function swapTokensForExactTokens(uint amountOut, uint amountInMax, address[] calldata path, address to, uint deadline) external returns (uint[] memory amounts)',
];

async function main() {
  const p = new JsonRpcProvider(RPC, CHAIN_ID, { staticNetwork: true });
  const block = await p.getBlockNumber();
  console.log(`✅ RPC 通，BSC 测试网 chain=${CHAIN_ID} block=${block}`);

  const check = async (label, addr) => {
    const code = await p.getCode(addr);
    const size = code.length - 2;
    console.log(`${label} ${addr.slice(0,6)}...${addr.slice(-4)} → ${size} bytes ${size > 0 ? '✅' : '❌ 无代码'}`);
    return size > 0;
  };

  const ok = {};
  ok.router = await check('Router', ROUTER);
  ok.usdt = await check('USDT', USDT);
  ok.usdc = await check('USDC', USDC);

  if (!(ok.router && ok.usdt && ok.usdc)) {
    console.log('❌ 关键合约缺失，无法继续测试');
    process.exit(1);
  }

  const usdt = new Interface(ERC20_ABI);
  const usdc = new Interface(ERC20_ABI);
  const rt = new Interface(ROUTER_ABI);

  const path = [USDC, USDT];
  const amountOut = parseUnits('10', 18); // 要换出 10 USDT

  try {
    const data = rt.encodeFunctionData('getAmountsIn', [amountOut, path]);
    const result = await p.call({ to: ROUTER, data });
    const decoded = rt.decodeFunctionResult('getAmountsIn', result);
    console.log(`\n✅ getAmountsIn(10 USDT, USDC→USDT) = ${formatUnits(decoded[0][0], 18)} USDC`);
    console.log(`   需要 ${formatUnits(decoded[0][0], 18)} USDC 才能换出 10 USDT`);
  } catch (e) {
    console.log(`\n❌ getAmountsIn 失败: ${e.message}`);
  }

  try {
    const data = rt.encodeFunctionData('getAmountsOut', [parseUnits('10', 18), path]);
    const result = await p.call({ to: ROUTER, data });
    const decoded = rt.decodeFunctionResult('getAmountsOut', result);
    console.log(`✅ getAmountsOut(10 USDC, USDC→USDT) = ${formatUnits(decoded[0][1], 18)} USDT`);
  } catch (e) {
    console.log(`❌ getAmountsOut 失败: ${e.message}`);
  }

  // 测一下 WBNB 路径有没有流动性（USDT 没有直接池的话会走 WBNB）
  try {
    const WBNB = '0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd';
    const path2 = [USDC, WBNB, USDT];
    const data = rt.encodeFunctionData('getAmountsOut', [parseUnits('10', 18), path2]);
    const result = await p.call({ to: ROUTER, data });
    const decoded = rt.decodeFunctionResult('getAmountsOut', result);
    console.log(`✅ getAmountsOut(10 USDC, USDC→WBNB→USDT) = ${formatUnits(decoded[0][2], 18)} USDT`);
  } catch (e) {
    console.log(`❌ WBNB 路径失败: ${e.message}`);
  }
}
main().catch(e => console.error(e));
