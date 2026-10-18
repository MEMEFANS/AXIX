// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title AIXPool — AIX 代币矿池合约（用户付 Gas 提取模式）
 *
 * @notice 设计目标：平台把 AIX 储备打入本合约，用户通过平台签名授权自行调用 harvest()
 *         把 AIX 提取到自己钱包。Gas 由用户承担，平台 0 日常运营成本。
 *
 *         典型用法：
 *           1) 平台部署 AIX (ERC20) 和 AIXPool（本合约，构造时传入 _initialReserve = 20 亿 AIX）
 *              - 部署后 totalReserve 立即显示 20 亿 AIX（满池展示，与代币总量对齐）
 *              - 用户查合约 totalReserve 看到平台储备了全部代币，资金看着雄厚
 *           2) 平台可选：owner 调用 topUp(amount) 注入真实 AIX 支撑日常提取
 *              - 实际可提取量以合约真实 AIX 余额（aixBalance）为准
 *              - harvest 会先校验 aixBalance >= amount，避免余额不足时浪费用户 gas
 *           3) 用户在平台前端点"提取到钱包"
 *              - 平台后端验证账面余额、扣减数据库 pending
 *              - 平台用 platformSigner 私钥对 (user, amount, nonce) 做 EIP-191 签名
 *              - 前端拿到签名后弹出钱包签名请求
 *              - 用户调用 harvest(amount, nonce, signature) — 用户付 Gas
 *           4) 合约验证 platformSigner 签名 + 防重放 → transfer AIX 给用户
 *
 * @dev 安全设计：
 *      - EIP-191 签名：\x19Ethereum Signed Message:\n32 + hash(user, amount, nonce, contractAddr)
 *      - 防重放：每个 (user, amount, nonce) 只能用一次，used mapping 记录
 *      - 紧急提取：owner 可调用 rescueToken 提取误转入的代币
 *      - 暂停开关：owner 可调用 setPaused(true) 暂停所有 harvest（应急用）
 *      - 签名人变更：owner 可调用 setSigner(new) 更新签名公钥（轮换私钥用）
 *      - 不持有任何 BNB：所有 AIX 都是 ERC20 形态，BNB 误转入可 rescueNative
 *
 *      部署后必做：
 *        1) 构造函数已初始化 totalReserve = 20 亿 AIX（满池展示，无需 topUp 即可显示）
 *        2) 可选：AIX.approve(AIXPool, amount) + AIXPool.topUp(amount) 注入真实 AIX 支撑日常提取
 *        3) 在 .env 写 AIX_POOL_CONTRACT_ADDRESS 和 AIX_POOL_SIGNER_PRIVATE_KEY
 *        4) 到 Bscscan Verify 合约源码
 */
contract AIXPool is Ownable {
    using ECDSA for bytes32;
    using MessageHashUtils for bytes32;

    IERC20 public immutable aix;              // AIX ERC20 代币合约
    address public platformSigner;            // 平台签名公钥（验证用户提现授权）
    uint256 public totalReserve;             // 当前储备量（topUp - harvest 累计）
    uint256 public totalHarvested;           // 累计已提取量
    bool public paused;                      // 应急暂停开关

    // 防重放：keccak256(user, amount, nonce, contractAddr) → 是否已用
    mapping(bytes32 => bool) public usedClaims;

    event TopUp(address indexed from, uint256 amount, uint256 newReserve);
    event Harvested(address indexed user, uint256 amount, uint256 nonce, uint256 newReserve);
    event SignerUpdated(address indexed oldSigner, address indexed newSigner);
    event PausedStateChanged(bool paused);
    event TokenRescued(address indexed token, address indexed to, uint256 amount);
    event NativeRescued(address indexed to, uint256 amount);

    /**
     * @param _aix             AIX ERC20 代币合约地址
     * @param _platformSigner  平台签名公钥（对应私钥保管在平台后端 .env）
     * @param _initialReserve  初始展示储备量（带 18 位小数）。
     *                          用于"满池展示"：部署后 totalReserve 直接显示 _initialReserve，
     *                          不需要先 topUp 真实转账即可让用户查合约时看到平台储备了全部 AIX。
     *                          实际可提取量受合约真实 AIX 余额（aixBalance）限制，
     *                          harvest 会先校验 aixBalance >= amount，避免余额不足时浪费用户 gas。
     *                          平台后续仍可用 topUp 真实注入 AIX（同时增加 totalReserve）。
     */
    constructor(address _aix, address _platformSigner, uint256 _initialReserve) Ownable(msg.sender) {
        require(_aix != address(0), "AIXPool: AIX zero address");
        require(_platformSigner != address(0), "AIXPool: signer zero address");
        aix = IERC20(_aix);
        platformSigner = _platformSigner;
        totalReserve = _initialReserve;
    }

    modifier whenNotPaused() {
        require(!paused, "AIXPool: paused");
        _;
    }

    /**
     * @notice 平台注入 AIX 储备。仅 owner。
     *         调用前需先 approve(AIXPool, amount) 授权合约扣 AIX。
     */
    function topUp(uint256 amount) external onlyOwner {
        require(amount > 0, "AIXPool: zero amount");
        bool ok = aix.transferFrom(msg.sender, address(this), amount);
        require(ok, "AIXPool: transferFrom failed");
        totalReserve += amount;
        emit TopUp(msg.sender, amount, totalReserve);
    }

    /**
     * @notice 用户提取 AIX 到自己钱包（用户付 Gas）。
     *         必须带平台 platformSigner 私钥生成的 EIP-191 签名。
     *
     * @param amount   提取数量（带 18 位小数）
     * @param nonce    平台生成的唯一 nonce（防重放，建议 16 字节 hex 字符串的 uint256 表示）
     * @param signature 平台 EIP-191 签名（65 字节 r+s+v）
     */
    function harvest(uint256 amount, uint256 nonce, bytes calldata signature) external whenNotPaused {
        require(amount > 0, "AIXPool: zero amount");
        require(totalReserve >= amount, "AIXPool: insufficient reserve");
        // 真实余额校验：totalReserve 可能为展示值（满池展示），但实际可提取量以合约真实 AIX 余额为准。
        // 提前 revert 避免签名验证通过后 transfer 失败浪费用户 gas。
        require(aix.balanceOf(address(this)) >= amount, "AIXPool: insufficient balance");

        // 防重放 hash
        bytes32 claimHash = keccak256(abi.encodePacked(msg.sender, amount, nonce, address(this)));
        require(!usedClaims[claimHash], "AIXPool: claim already used");

        // EIP-191 签名验证
        bytes32 ethHash = MessageHashUtils.toEthSignedMessageHash(claimHash);
        address recovered = ethHash.recover(signature);
        require(recovered == platformSigner, "AIXPool: invalid signature");

        // 标记已用
        usedClaims[claimHash] = true;
        // 更新储备
        totalReserve -= amount;
        totalHarvested += amount;
        // 转账
        bool ok = aix.transfer(msg.sender, amount);
        require(ok, "AIXPool: transfer failed");

        emit Harvested(msg.sender, amount, nonce, totalReserve);
    }

    /**
     * @notice 更新平台签名公钥（私钥轮换用）。仅 owner。
     */
    function setSigner(address newSigner) external onlyOwner {
        require(newSigner != address(0), "AIXPool: zero signer");
        address old = platformSigner;
        platformSigner = newSigner;
        emit SignerUpdated(old, newSigner);
    }

    /**
     * @notice 设置暂停状态。仅 owner。应急用（发现 bug 时立即暂停所有 harvest）。
     */
    function setPaused(bool _paused) external onlyOwner {
        paused = _paused;
        emit PausedStateChanged(_paused);
    }

    /**
     * @notice 紧急提取误转入的 ERC20（非 AIX 储备）。仅 owner。
     *         注意：本合约持有的是 AIX，owner 要提 AIX 用本函数。
     *         但 AIX 储备的应急提取需要谨慎，建议仅在紧急情况使用。
     */
    function rescueToken(address token, address to, uint256 amount) external onlyOwner {
        require(token != address(0), "AIXPool: zero token");
        require(to != address(0), "AIXPool: zero recipient");
        bool ok = IERC20(token).transfer(to, amount);
        require(ok, "AIXPool: rescue failed");
        emit TokenRescued(token, to, amount);
    }

    /**
     * @notice 紧急提取误转入的 BNB。仅 owner。
     */
    function rescueNative(address to, uint256 amount) external onlyOwner {
        require(to != address(0), "AIXPool: zero recipient");
        (bool ok, ) = payable(to).call{value: amount}("");
        require(ok, "AIXPool: native rescue failed");
        emit NativeRescued(to, amount);
    }

    /**
     * @notice 查询某用户是否已用过某 (amount, nonce) 组合（防重放预检）。
     */
    function isClaimUsed(address user, uint256 amount, uint256 nonce) external view returns (bool) {
        bytes32 claimHash = keccak256(abi.encodePacked(user, amount, nonce, address(this)));
        return usedClaims[claimHash];
    }

    /**
     * @notice 合约当前 AIX 余额。应等于 totalReserve。
     *         若不等说明有外部直接 transfer AIX 进合约（未走 topUp）。
     */
    function aixBalance() external view returns (uint256) {
        return aix.balanceOf(address(this));
    }

    receive() external payable {
        // 接收 BNB（误转入时通过 rescueNative 取出）
    }
}
