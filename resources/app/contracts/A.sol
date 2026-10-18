// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title AToken  —  A 币（A Coin，简称 A）
 * @notice 总量固定 20 亿（2,000,000,000 × 10¹⁸），18 位小数，BSC 主网发行。
 *         与平台内盘叙事对齐：矿机产出份额 10 亿 + 质押产出份额 10 亿 = 20 亿；
 *         AIXPool 矿池合约构造时以 20 亿作为初始展示储备，三者自洽。
 *
 *         设计取舍（与当前平台"内盘记账 + 提币走链上"模式匹配）：
 *          - 构造函数中一次性 mint 全部 20 亿给 initialOwner，不再提供 mint()。
 *            这意味着合约一旦部署，**总量永远不会增加**，不会出现"团队无限增发"质疑。
 *          - 若未来需要"矿机产出直接链上发放"，可复制本文件到可 mint 版本
 *            加 `function mint(address to, uint256 amount) external onlyOwner { _mint(to, amount); }`
 *            但推荐继续用"内盘产出 + Owner transfer 提币热钱包"模式，安全可控得多。
 *          - 继承 ERC20Permit：未来若要上薄饼/Router 集成 EIP-2612 免 approve 交易，
 *            或做签名免 gas 授权，无需升级合约。
 *          - emergencyWithdraw 兜底：防止用户把 BNB / 任意代币误转到合约地址时彻底锁死。
 *
 *         推荐部署后立即执行的 3 步（顺序别错）：
 *           1) transfer(提币热钱包地址, 预计先运营的提币储备数量, 比如 2 亿 A)
 *           2) transfer(多签/冷钱包地址, 剩下的 A)   或   burn(剩余数量) 直接通缩掉
 *           3) renounceOwnership()   — 彻底放弃 Owner 权限，任何人包括你都不再能 emergencyWithdraw
 *              （如果还想保留 emergencyWithdraw 兜底，就不执行第 3 步，Owner 用硬件钱包保管）
 */
contract AToken is ERC20, ERC20Burnable, ERC20Permit, Ownable {
    uint256 public constant MAX_SUPPLY = 2_000_000_000 * 10 ** 18;

    constructor(address initialOwner)
        ERC20("A Coin", "A")
        ERC20Permit("A Coin")
        Ownable(initialOwner)
    {
        _mint(initialOwner, MAX_SUPPLY);
    }

    /**
     * @dev 紧急提取误转入本合约的 BNB / ERC20。仅 Owner 可调用。
     *      token = address(0) 表示提取 BNB。
     */
    function emergencyWithdraw(address token, uint256 amount) external onlyOwner {
        if (token == address(0)) {
            (bool ok, ) = payable(owner()).call{value: amount}("");
            require(ok, "AToken: native transfer failed");
        } else {
            IERC20(token).transfer(owner(), amount);
        }
    }
}
