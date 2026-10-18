// 用项目自带的 solc 编译 MintableERC20.sol，输出 bytecode 到 erc20-bytecode.json
import fs from 'node:fs';
import path from 'node:path';
import solc from 'solc';

const solFile = path.resolve('scripts/MintableERC20.sol');
const source = fs.readFileSync(solFile, 'utf8');
const input = {
  language: 'Solidity',
  sources: { 'MintableERC20.sol': { content: source } },
  settings: {
    optimizer: { enabled: true, runs: 200 },
    outputSelection: { '*': { '*': ['evm.bytecode.object', 'abi'] } },
  },
};
const output = JSON.parse(solc.compile(JSON.stringify(input)));
const contract = output.contracts['MintableERC20.sol'].MintableERC20;
const result = {
  bytecode: contract.evm.bytecode.object,
  abi: contract.abi,
};
fs.writeFileSync('scripts/erc20-bytecode.json', JSON.stringify(result, null, 2));
console.log('✅ 编译完成，bytecode 长度 =', result.bytecode.length);
