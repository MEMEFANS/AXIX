/**
 * AIX 链上提取（AIXPool harvest 模式）
 *
 * 用户在资产页 AIX 行点"提取到钱包"按钮：
 *   1. 弹出 modal，输入提取数量
 *   2. 用户点"提取"，前端调 /api/a-token/claim-signature 拿签名
 *   3. 前端用 ethers 弹钱包签名请求调用 AIXPool.harvest(amount, nonce, signature)
 *   4. 链上交易成功后调 /api/a-token/claim-confirm 通知平台
 *   5. 失败/取消签名时调 /api/a-token/claim-refund 退回账面余额
 */
(() => {
  const AIX_POOL_ABI = [
    'function harvest(uint256 amount, uint256 nonce, bytes signature) external',
    'function totalReserve() view returns (uint256)',
    'function totalHarvested() view returns (uint256)',
    'function platformSigner() view returns (address)',
    'function paused() view returns (bool)',
    'function aixBalance() view returns (uint256)',
    'function isClaimUsed(address user, uint256 amount, uint256 nonce) view returns (bool)',
    'event Harvested(address indexed user, uint256 amount, uint256 nonce, uint256 newReserve)',
  ];

  function $(id) { return document.getElementById(id); }
  function fmtA(units) {
    try { return (Number(BigInt(units || '0')) / 1e18).toLocaleString('en-US', { maximumFractionDigits: 4 }); }
    catch { return '0'; }
  }
  function fmtTime(t) {
    try { return new Date(Number(t)).toLocaleString('zh-CN', { hour12: false }); }
    catch { return ''; }
  }

  let ethersPromise = null;
  async function loadEthers() {
    if (ethersPromise) return ethersPromise;
    ethersPromise = (async () => {
      if (window.ethers) return window.ethers;
      // 兜底：动态加载 ethers（如果未在全局）
      await new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = 'https://cdn.jsdelivr.net/npm/ethers@6.13.2/dist/ethers.umd.min.js';
        s.onload = resolve;
        s.onerror = () => reject(new Error('加载 ethers 失败'));
        document.head.appendChild(s);
      });
      return window.ethers;
    })();
    return ethersPromise;
  }

  function getWallet() {
    if (window.currentWalletProfile?.address) return window.currentWalletProfile.address;
    if (window.ethereum?.selectedAddress) return window.ethereum.selectedAddress;
    return null;
  }

  async function ensureProvider() {
    if (!window.ethereum) throw new Error('请先安装 MetaMask 等钱包插件');
    await window.ethereum.request({ method: 'eth_requestAccounts' }).catch(() => {});
    return window.ethereum;
  }

  // ── Modal 生成 ──────────────────────────────────────────────
  function ensureModal() {
    let modal = $('aix-claim-modal');
    if (modal) return modal;
    modal = document.createElement('div');
    modal.id = 'aix-claim-modal';
    modal.className = 'awd-modal';
    modal.innerHTML = `
      <div class="awd-card">
        <header class="awd-head">
          <h3>提取 AIX 到钱包</h3>
          <button class="awd-close" type="button" data-close="1">×</button>
        </header>
        <div class="awd-body">
          <div class="awd-row"><span>账面余额</span><b id="aix-claim-balance">— AIX</b></div>
          <div class="awd-row"><span>合约储备</span><b id="aix-claim-reserve">— AIX</b></div>
          <div class="awd-row"><span>已累计提取</span><b id="aix-claim-harvested">— AIX</b></div>
          <label class="awd-label">提取数量（AIX）</label>
          <input id="aix-claim-amount" type="number" min="100" step="0.0001" placeholder="100" inputmode="decimal" />
          <div class="awd-pct" id="aix-claim-pct">
            <button type="button" data-pct="25">25%</button>
            <button type="button" data-pct="50">50%</button>
            <button type="button" data-pct="75">75%</button>
            <button type="button" data-pct="100">100%</button>
          </div>
          <div class="awd-hint">提取到当前连接钱包地址，链上交易需支付 BNB Gas</div>
          <div class="awd-status" id="aix-claim-status" hidden></div>
        </div>
        <footer class="awd-foot">
          <button type="button" class="awd-btn-ghost" data-close="1">取消</button>
          <button type="button" class="awd-btn-primary" id="aix-claim-submit">链上提取</button>
        </footer>
      </div>
    `;
    document.body.appendChild(modal);
    modal.addEventListener('click', (e) => {
      if (e.target === modal || e.target.dataset.close === '1') modal.hidden = true;
    });
    modal.querySelectorAll('#aix-claim-pct button').forEach(b => b.addEventListener('click', () => {
      const pct = Number(b.dataset.pct);
      const bal = Number($('aix-claim-balance').dataset.units || 0);
      const amount = (bal / 1e18) * pct / 100;
      $('aix-claim-amount').value = amount.toFixed(4);
    }));
    $('aix-claim-submit').addEventListener('click', onClaimSubmit);
    return modal;
  }

  function setStatus(text, isError = false) {
    const el = $('aix-claim-status');
    if (!el) return;
    el.hidden = !text;
    el.textContent = text || '';
    el.style.color = isError ? '#f26c78' : '#4fd1b5';
  }
  function setBusy(busy) {
    const btn = $('aix-claim-submit');
    if (!btn) return;
    btn.disabled = busy;
    btn.textContent = busy ? '提取中…' : '链上提取';
  }

  async function refreshStatus() {
    try {
      const res = await fetch('/api/a-token/claim/status', { credentials: 'include' });
      const data = await res.json();
      if (!data?.enabled) {
        setStatus('AIX 链上提取未启用（平台未部署 AIXPool 合约）', true);
        $('aix-claim-submit').disabled = true;
        return;
      }
      const balUnits = String(data.balanceA || '0');
      const balNum = Number(BigInt(balUnits)) / 1e18;
      $('aix-claim-balance').textContent = balNum.toLocaleString('en-US', { maximumFractionDigits: 4 }) + ' AIX';
      $('aix-claim-balance').dataset.units = balUnits;
      // 从链上读取储备量
      try {
        const ethers = await loadEthers();
        const provider = new ethers.BrowserProvider(window.ethereum);
        const pool = new ethers.Contract(data.contractAddress, AIX_POOL_ABI, provider);
        const [reserve, harvested, paused] = await Promise.all([
          pool.totalReserve(), pool.totalHarvested(), pool.paused(),
        ]);
        $('aix-claim-reserve').textContent = (Number(reserve) / 1e18).toLocaleString('en-US', { maximumFractionDigits: 0}) + ' AIX';
        $('aix-claim-harvested').textContent = (Number(harvested) / 1e18).toLocaleString('en-US', { maximumFractionDigits: 0}) + ' AIX';
        if (paused) {
          setStatus('合约已暂停提取（平台维护中）', true);
          $('aix-claim-submit').disabled = true;
        } else {
          $('aix-claim-submit').disabled = false;
        }
      } catch (e) {
        // 链上读取失败不影响主要流程
        $('aix-claim-reserve').textContent = '链上读取失败';
      }
    } catch (e) {
      setStatus('加载状态失败：' + (e?.message || e), true);
    }
  }

  async function onClaimSubmit() {
    const amount = Number($('aix-claim-amount').value || 0);
    if (!amount || amount <= 0) return setStatus('请输入提取数量', true);
    if (amount < 100) return setStatus('最小提取数量为 100 AIX', true);
    const wallet = getWallet();
    if (!wallet) return setStatus('请先连接钱包', true);
    setBusy(true);
    setStatus('正在生成平台签名授权…');
    let claimId = null;
    try {
      // Step 1: 拿签名
      const res = await fetch('/api/a-token/claim-signature', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'clm_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8) },
        body: JSON.stringify({ amount: String(amount) }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || '生成签名失败');
      claimId = data.claim.claimId;
      const amountUnits = BigInt(data.claim.amountUnits);
      const nonceBigInt = BigInt(data.claim.nonceBigInt);
      const signature = data.claim.signature;
      const contractAddress = data.claim.contractAddress;

      // Step 2: 调用合约
      setStatus('请确认钱包签名（链上交易，支付 BNB Gas）…');
      const ethers = await loadEthers();
      const provider = new ethers.BrowserProvider(window.ethereum);
      const signer = await provider.getSigner();
      const pool = new ethers.Contract(contractAddress, AIX_POOL_ABI, signer);

      // 预检：避免交易上链才发现已用
      const used = await pool.isClaimUsed(await signer.getAddress(), amountUnits, nonceBigInt);
      if (used) throw new Error('该提取已使用过，请重新申请');

      const tx = await pool.harvest(amountUnits, nonceBigInt, signature);
      setStatus(`交易已广播，等待确认… 交易哈希：${tx.hash.slice(0,10)}…`);
      const receipt = await tx.wait(3); // 等 3 个区块确认

      if (receipt.status !== 1) throw new Error('链上交易失败（reverted）');

      // Step 3: 通知平台确认
      await fetch('/api/a-token/claim-confirm', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ claimId, txHash: tx.hash }),
      });

      setStatus(`提取成功！${amount} AIX 已转入你的钱包`, false);
      // 刷新余额
      try { await refreshStatus(); } catch {}
      // 通知资产页刷新
      window.loadWalletProfile?.();
    } catch (e) {
      const msg = e?.message || String(e);
      setStatus('提取失败：' + msg, true);
      // 用户取消签名或链上失败 → 退款
      if (claimId) {
        try {
          await fetch('/api/a-token/claim-refund', {
            method: 'POST', credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ claimId, reason: 'user_cancelled_or_failed' }),
          });
          console.log('[AIX提取] 已自动退回账面余额，claimId:', claimId);
        } catch (refundErr) {
          console.error('[AIX提取] 退款失败', refundErr);
        }
      }
    } finally {
      setBusy(false);
    }
  }

  // ── 公开 API ──────────────────────────────────────────────
  window.AixClaim = {
    async open() {
      const modal = ensureModal();
      modal.hidden = false;
      await refreshStatus();
    },
    refreshStatus,
  };
})();
