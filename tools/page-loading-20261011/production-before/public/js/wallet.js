// Global polyfill for BigInt JSON serialization to prevent "Do not know how to serialize a BigInt" error
if (typeof BigInt !== 'undefined' && !BigInt.prototype.toJSON) {
  BigInt.prototype.toJSON = function() {
    return this.toString();
  };
}

let walletConfig = null;
let walletProfile = null;
let connectedWalletAddress = '';
let connectedProvider = null;
let walletConnectInProgress = false;
let platformLoginPromise = null;
let connectorRestoring = true;
let pendingWalletSwitch = null;   // 进站恢复期间用户切了钱包，记下来等恢复结束后补签名
let connectorReadyPromise = null;

function walletWithTimeout(operation, timeoutMs, message) {
  let timer;
  return Promise.race([
    Promise.resolve(operation),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs); }),
  ]).finally(() => clearTimeout(timer));
}

window.currentWalletConnection = null;
window.currentWalletProfile = null;
let emittedWalletState = ':false';
let walletStateRevision = 0;
window.getWalletStateRevision = () => walletStateRevision;

// 钱包地址和平台登录态是两层状态：钱包连接成功不等于平台签名登录完成。
// 用一个事件把两层状态变化即时通知矿机/资产等动态页面，避免顶部已显示地址而下方仍停留在旧游客视图。
function emitWalletStateChange() {
  const state = `${connectedWalletAddress.toLowerCase()}:${Boolean(walletProfile?.authenticated)}`;
  if (state === emittedWalletState) return;
  emittedWalletState = state;
  ++walletStateRevision;
  window.dispatchEvent(new CustomEvent('walletstatechange', {
    detail: {
      address: connectedWalletAddress || '',
      connected: Boolean(connectedWalletAddress),
      authenticated: Boolean(walletProfile?.authenticated),
    },
  }));
}

function shortWallet(address) {
  return address ? `${address.slice(0, 6)}...${address.slice(-4)}` : '连接钱包';
}

function setAccountStatus(id, message, type = '') {
  const node = $(id);
  if (!node) return;
  node.textContent = message || '';
  node.className = `account-status${type ? ` ${type}` : ''}`;
}

function setWalletButton(label) {
  const headerButton = $('wallet-connect-btn');
  if (headerButton) headerButton.textContent = label;
}

function closeWalletMenu() {
  const menu = $('wallet-account-menu');
  const button = $('wallet-connect-btn');
  if (menu) menu.hidden = true;
  if (button) button.setAttribute('aria-expanded', 'false');
}

function setWalletMenuAuthVisibility(show) {
  const authBtn = $('wallet-menu-auth');
  if (!authBtn) return;
  authBtn.hidden = !show;
}

function openWalletMenu(button) {
  const menu = $('wallet-account-menu');
  if (!menu) return;
  const willOpen = menu.hidden;
  menu.hidden = !willOpen;
  if (button) button.setAttribute('aria-expanded', String(willOpen));
  if (willOpen) {
    // header 带 overflow-x:hidden，绝对定位下拉会被裁掉（手机上需滚动才可见）；
    // 改用 fixed 定位，实时锚定钱包按钮，确保菜单直接弹出在按钮下方。
    const rect = button.getBoundingClientRect();
    const menuWidth = 180;
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - menuWidth - 8));
    menu.style.position = 'fixed';
    menu.style.top = `${Math.round(rect.bottom + 8)}px`;
    menu.style.left = `${Math.round(left)}px`;
    menu.style.right = 'auto';
    menu.style.zIndex = '1200';
    menu.style.width = `${menuWidth}px`;
  }
}

/**
 * 钱包按钮三态（页面加载时自动恢复连接 + 自动签名登录，无需手动点击）:
 *  ① 完全未连接 (!connectedWalletAddress)   → connectWallet() 弹连接请求，连接后自动签名
 *  ② 已连接但未登录 (有地址但未完成登录签名) → 打开菜单；菜单首项「🔐 身份验证」可在自动签名被取消后手动重试
 *  ③ 已登录 (walletProfile.authenticated)    → 打开菜单（资金 / 断开）
 */
function handleWalletButton(button) {
  // 态 ①：完全未连接
  if (!connectedWalletAddress) return connectWallet(button);
  if (!walletProfile?.authenticated) return openPlatformAccount(button);
  // 态 ② / ③：统一开菜单，身份验证只在菜单按钮显式点击时触发
  openWalletMenu(button);
}

/**
 * 菜单「🔐 身份验证」按钮触发：用户显式点击才弹签名
 */
async function verifyWalletFromMenu(btn) {
  if (!connectedWalletAddress) {
    closeWalletMenu();
    return connectWallet(btn);
  }
  if (walletProfile?.authenticated) { closeWalletMenu(); return; }
  try {
    await ensurePlatformSession(btn);
  } catch (error) {
    if (Number(error?.code) === 4001 || /denied|rejected|cancel/i.test(error?.message || '')) {
      // 取消签名静默；取消「切换到 BSC 网络」时提示原因
      if (/BSC|BNB|网络/.test(String(error?.message || ''))) showToast(error.message, 'error');
      closeWalletMenu();
      return;
    }
    showToast(error?.message?.includes('请') ? error.message : '身份验证失败', 'error');
  }
  closeWalletMenu();
}

function openWalletAccount() {
  closeWalletMenu();
  switchTab('account');
}

async function walletApi(url, options = {}) {
  const revision = walletStateRevision;
  const { timeoutMs = 10000, ...fetchOptions } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...fetchOptions,
      signal: controller.signal,
      credentials:'same-origin',
      headers:options.body ? { 'Content-Type':'application/json', ...(options.headers || {}) } : options.headers,
    });
    const data = await response.json().catch(error => {
      if (controller.signal.aborted) throw error;
      return {};
    });
    if (response.status === 401 && revision === walletStateRevision) clearPlatformSession();
    if (!response.ok) throw Object.assign(new Error(data.error || '请求失败，请重试'), {
      retryable:response.status === 408 || response.status >= 500,
    });
    return data;
  } catch (error) {
    if (error?.name === 'AbortError') throw Object.assign(new Error('网络较慢，请求超时，请稍后重试'), { retryable:true });
    if (error instanceof TypeError) error.retryable = true;
    throw error;
  } finally { clearTimeout(timer); }
}

// Retry only network reads/challenge creation. A wallet prompt is never automatically repeated.
async function walletLoginRequest(url, options = {}, requireSameWallet = () => {}) {
  for (let attempt = 0; ; ++attempt) {
    requireSameWallet();
    try {
      const value = await walletApi(url, { ...options, cache:'no-store', timeoutMs:attempt ? 10000 : 5000 });
      requireSameWallet();
      return value;
    } catch (error) {
      requireSameWallet();
      if (attempt || !error.retryable) throw error;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  }
}

function refreshWalletDependents() {
  if (window.__tradeDeferredReady && typeof setTradeProduct === 'function') setTradeProduct(typeof tradeProduct === 'string' ? tradeProduct : 'perp');
  if (typeof renderTradeAccount === 'function') renderTradeAccount();
  if (window.__tradeDeferredReady && $('trade-order-btn') && typeof updateTradeOrderButton === 'function') updateTradeOrderButton();
  window.resetInternalStrategiesForWallet?.();
  window.AiManaged?.reset();
  if ($('tab-ai-managed')?.classList.contains('active') && window.currentWalletProfile?.authenticated) {
    window.AiManaged?.refresh();
  }
  Object.values(window.Portal?.pages || {}).forEach(page => { page.loaded = false; });
  const activePortal = document.querySelector('.portal-page.active')?.id?.replace('tab-', '');
  if (activePortal) window.Portal?.load(activePortal, true);
  if ($('tab-overview')?.classList.contains('active')) window.InternalStrategyOverview?.activate?.();
}

function renderWalletDisconnected() {
  const hadConnection = Boolean(connectedWalletAddress || walletProfile);
  closeWalletMenu();
  connectedWalletAddress = '';
  connectedProvider = null;
  walletProfile = null;
  window.currentWalletConnection = null;
  window.currentWalletProfile = null;
  emitWalletStateChange();
  $('account-locked').style.display = '';
  $('account-content').style.display = 'none';
  const lockedTitle = $('account-locked')?.querySelector('h2');
  const lockedText = $('account-locked')?.querySelector('p');
  if (lockedTitle) lockedTitle.textContent = '连接钱包进入个人中心';
  if (lockedText) lockedText.textContent = '连接钱包即可进入；首次资金操作时再核对一次钱包，无需邮箱或其他账号。';
  $('wallet-connect-btn').textContent = '连接钱包';
  $('wallet-connect-btn').classList.remove('connected');
  setWalletMenuAuthVisibility(false);   // 态 ①：完全未连接 → 隐藏「身份验证」
  if ($('account-connect-btn')) $('account-connect-btn').textContent = '连接钱包';
  if (hadConnection) refreshWalletDependents();
}

function renderWalletConnection(connection) {
  if (!connection?.address) return renderWalletDisconnected();
  const addressChanged = connectedWalletAddress.toLowerCase() !== connection.address.toLowerCase();
  const changed = addressChanged
    || connectedProvider !== connection.provider;
  if (addressChanged) {
    walletProfile = null;
    window.currentWalletProfile = null;
  }
  connectedWalletAddress = connection.address;
  connectedProvider = connection.provider;
  window.currentWalletConnection = { address:connection.address, label:connection.label || '钱包' };
  emitWalletStateChange();
  const button = $('wallet-connect-btn');
  button.textContent = shortWallet(connection.address);
  button.title = `${connection.label || '钱包'} 已连接`;
  button.classList.add('connected');
  setWalletMenuAuthVisibility(!walletProfile?.authenticated);  // 态 ②：已连接未登录 → 显示「身份验证」
  if ($('account-address')) $('account-address').textContent = connection.address;
  if (!walletProfile?.authenticated) {
    $('account-locked').style.display = 'none';
    $('account-content').style.display = '';
    if (typeof renderWalletFunds === 'function') {
      renderWalletFunds({ balances:{ USDT:'0' }, deposits:[], withdrawals:[] });
    }
    if ($('account-connect-btn')) $('account-connect-btn').textContent = '钱包已连接';
  }
  if (changed) refreshWalletDependents();
}

function clearPlatformSession() {
  walletProfile = null;
  window.currentWalletProfile = null;
  // 态 ②：清 session 后回到「已连接未登录」→ 重新显示「身份验证」菜单
  setWalletMenuAuthVisibility(Boolean(connectedWalletAddress));
  if (window.currentWalletConnection) renderWalletConnection({
    ...window.currentWalletConnection,
    provider:connectedProvider,
  });
  else renderWalletDisconnected();
}

// 推荐绑定：通过 ?ref= 链接进站 → 存入 localStorage（防切页丢参数）→ 登录成功后立即绑定。
// 接口幂等：已有推荐人则不覆盖；绑定失败保留 code，下次登录自动重试。
async function bindPendingReferral() {
  try {
    const urlCode = new URLSearchParams(location.search).get('ref');
    if (urlCode) localStorage.setItem('wg_referral_code', urlCode.trim().toUpperCase());
    const code = localStorage.getItem('wg_referral_code');
    if (!code) return;
    await walletApi('/api/referrals/bind', { method:'POST', body:JSON.stringify({ code }) });
    localStorage.removeItem('wg_referral_code');
  } catch { /* 静默：失败保留 code 下次重试 */ }
}

function renderWalletProfile(profile) {
  walletProfile = profile;
  window.currentWalletProfile = profile;
  connectedWalletAddress = profile.address;
  emitWalletStateChange();
  $('account-locked').style.display = 'none';
  $('account-content').style.display = '';
  $('account-address').textContent = profile.address;
  $('wallet-connect-btn').textContent = shortWallet(profile.address);
  $('wallet-connect-btn').classList.add('connected');
  setWalletMenuAuthVisibility(false);   // 态 ③：已登录 → 隐藏「身份验证」菜单
  if ($('account-connect-btn')) $('account-connect-btn').textContent = '钱包已连接';
  if (profile.balances && typeof renderWalletFunds === 'function') renderWalletFunds(profile);
  if (typeof loadPlatformProfile === 'function') loadPlatformProfile().catch(() => {});
  refreshWalletDependents();
  bindPendingReferral();
  if ($('tab-account')?.classList.contains('active')) {
    if (profile.balances) loadAccountUid();
    else loadWalletProfile().catch(() => {});
  }
  // 授权已合并到登录流程中，不再需要单独触发
}

// 加载并显示用户ID（8位平台用户ID，用于互转/推荐）
async function loadAccountUid() {
  try {
    const prof = await walletApi('/api/a-token/profile');
    const uid = prof?.userId || '';
    const row = $('account-uid-row');
    const el = $('account-uid');
    if (row && el && uid) {
      el.textContent = uid;
      row.hidden = false;
    }
  } catch { /* 用户ID获取失败不阻塞页面 */ }
}

// 复制用户ID（按钮文案短暂反馈，不弹 toast）
async function copyAccountUid() {
  const uid = $('account-uid')?.textContent?.trim() || '';
  if (!uid) return;
  const btn = $('account-uid-btn');
  try {
    await navigator.clipboard.writeText(uid);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = uid; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); } catch {}
    document.body.removeChild(ta);
  }
  if (btn) {
    const icon = btn.querySelector('.assets-uid-icon');
    if (icon) {
      const old = icon.textContent;
      icon.textContent = '✓';
      setTimeout(() => { icon.textContent = old; }, 1200);
    }
  }
}

async function loadWalletProfile() {
  const revision = walletStateRevision;
  const profile = await walletApi('/api/wallet/profile').catch(() => null);
  // A slow pre-login/account request must not undo a newer login or account switch.
  if (revision !== walletStateRevision) return walletProfile;
  // A temporary network failure does not mean the server session has expired.
  if (!profile) return walletProfile;
  if (profile.authenticated && connectedWalletAddress
    && profile.address?.toLowerCase() === connectedWalletAddress.toLowerCase()) {
    renderWalletProfile(profile);
    return profile;
  }
  // An unauthenticated profile response can race the first login request.
  // Do not POST logout here: that could clear the session just created by
  // the signature flow running in parallel.
  clearPlatformSession();
  return null;
}

async function ensurePlatformSession(triggerButton = null, options = {}) {
  const force = Boolean(options?.force);
  console.log('[wallet] ensurePlatformSession called', { force, hasProfile: !!walletProfile?.authenticated, hasPromise: !!platformLoginPromise, hasAddr: !!connectedWalletAddress });
  if (!force && walletProfile?.authenticated) return walletProfile;
  if (platformLoginPromise) return platformLoginPromise;
  // Connect before creating the login promise: connectWallet starts its own login after connecting.
  if (!connectedWalletAddress || !connectedProvider) {
    await connectWallet(triggerButton);
    if (walletProfile?.authenticated) return walletProfile;
    throw new Error('请先连接并验证钱包');
  }
  platformLoginPromise = (async () => {
    // 非强制签名时先静默查服务器会话：刷新/重进后 Cookie 仍有效则直接恢复登录态，不再重复签名。
    // 必须在 platformLoginPromise 互斥区内查，否则并发触发（多组件同时要登录态）会各自发起签名、连续弹多次。
    if (!force) {
      try {
        const revision = walletStateRevision;
        const existing = await walletApi('/api/wallet/session', { timeoutMs:2500, cache:'no-store' });
        if (revision === walletStateRevision && existing?.authenticated
          && (!connectedWalletAddress || existing.address?.toLowerCase() === connectedWalletAddress.toLowerCase())) {
          renderWalletProfile(existing);
          return existing;
        }
      } catch { /* 会话无效 → 走正常签名流程 */ }
    }
    if (!connectedWalletAddress || !connectedProvider) {
      await connectWallet(triggerButton);
      if (!connectedWalletAddress || !connectedProvider) throw new Error('请先连接钱包');
    }
    setWalletButton('确认钱包...');
    const loginAddress = connectedWalletAddress;
    const loginProvider = connectedProvider;
    const requireSameWallet = () => {
      if (connectedWalletAddress.toLowerCase() !== loginAddress.toLowerCase()
        || connectedProvider !== loginProvider) throw new Error('钱包账户已切换，请重新验证');
    };
    try {
      // 4. 第一步：登录签名（personal_sign 纯文本，钱包弹窗显示人类可读消息）
      console.log('[wallet] Step 1: login challenge + sign');
      // 平台仅支持 BNB Smart Chain：签名前强制切到 chainId 56，
      // 钱包签名弹窗即显示 BSC 网络，不会再显示 Ethereum。
      const requestId = globalThis.crypto?.randomUUID?.() || `login_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      // Fetch the challenge while checking BSC, so network latency does not add to wallet latency.
      const [loginChallenge] = await Promise.all([walletLoginRequest('/api/wallet/login-challenge', {
        method:'POST',
        body:JSON.stringify({ address:loginAddress, requestId }),
      }, requireSameWallet), walletWithTimeout(ensureBscChain(), 45000, '钱包确认超时，请检查钱包扩展后重试')]);
      requireSameWallet();
      const loginMessage = loginChallenge.message;
      const loginSig = await walletWithTimeout(
        loginProvider.request({ method:'personal_sign', params:[loginMessage, loginAddress] }),
        60000, '钱包确认超时，请检查钱包扩展后重试');
      requireSameWallet();
      console.log('[wallet] Step 1: login signed, submitting...');
      try {
        await walletApi('/api/wallet/login-sign', {
          method:'POST',
          body:JSON.stringify({ message:loginMessage, signature:loginSig }),
        });
      } catch (error) {
        // A lost response may have already set the session cookie. Check it without resubmitting the signature.
        if (!error.retryable) throw error;
      }
      console.log('[wallet] Step 1: login DONE');

      // 5. 更新 UI
      const profile = await walletLoginRequest('/api/wallet/session', {}, requireSameWallet);
      requireSameWallet();
      if (!profile.authenticated || profile.address?.toLowerCase() !== loginAddress.toLowerCase()) {
        throw new Error('身份验证失败');
      }
      renderWalletProfile(profile);
      return profile;
    } catch (err) {
      throw err;
    }
  })();
  try {
    return await platformLoginPromise;
  } finally {
    platformLoginPromise = null;
    setWalletButton(connectedWalletAddress ? shortWallet(connectedWalletAddress) : '连接钱包');
    if (window.__tradeDeferredReady && typeof updateTradeOrderButton === 'function') updateTradeOrderButton();
  }
}

async function openPlatformAccount(button = null) {
  try { return await ensurePlatformSession(button); }
  catch (error) {
    if (Number(error?.code) === 4001 || /denied|rejected|cancel/i.test(error?.message || '')) return null;
    showToast(error?.message?.includes('请') ? error.message : '操作失败，请重试', 'error');
    return null;
  }
}

function requirePlatformSession() {
  if (!walletProfile?.authenticated) throw new Error('请先连接并验证钱包');
}

function handlePlatformUnauthorized(response, requestRevision = walletStateRevision) {
  if (response?.status !== 401) return false;
  // Trading requests share the same session: an old 401 must not undo a newer wallet login.
  if (requestRevision === walletStateRevision) clearPlatformSession();
  return true;
}
window.handlePlatformUnauthorized = handlePlatformUnauthorized;

/**
 * 平台仅运行在 BNB Smart Chain（chainId 56），不提供其他网络。
 * 签名/连接前强制把钱包切到 BSC；钱包未添加 BSC 时连接器会自动添加。
 */
async function ensureBscChain() {
  const BSC_CHAIN_ID = 56;
  try {
    await window.WGWalletConnector.switchChain(BSC_CHAIN_ID);
  } catch (error) {
    const code = Number(error?.code) || 0;
    const msg = String(error?.message || '');
    const userRejected = code === 4001 || /denied|rejected|cancel|拒绝|取消/i.test(msg);
    if (userRejected) {
      const e = new Error('已取消网络切换：平台使用 BNB Smart Chain (BSC)，请在钱包中确认切换到 BSC 后重试');
      e.code = 4001;
      throw e;
    }
    // 连接器返回的其他错误本身已是中文（如"钱包未添加…""已添加但仍未切换…"）
    throw error;
  }
}

async function connectWallet(triggerButton = null) {
  console.log('[wallet] connectWallet called', { hasAddr: !!connectedWalletAddress, inProgress: walletConnectInProgress });
  if (connectedWalletAddress) {
    if (!walletProfile?.authenticated) await ensurePlatformSession(triggerButton);
    return window.currentWalletConnection;
  }
  if (walletConnectInProgress) return null;
  walletConnectInProgress = true;
  const headerButton = $('wallet-connect-btn');
  headerButton.disabled = true;
  if (triggerButton && triggerButton !== headerButton) triggerButton.disabled = true;
  setWalletButton('选择钱包...');
  try {
    await prepareWalletConnector();
    const connection = await window.WGWalletConnector.connect();
    if (!connection) return null;
    renderWalletConnection(connection);
    // ensurePlatformSession 签名前会强制切换到 BNB Smart Chain（chainId 56），
    // 保证钱包签名弹窗显示 BSC 网络；平台不提供其他网络。
    await ensurePlatformSession(triggerButton);
    return connection;
  } catch (error) {
    if (Number(error?.code) === 4001 || /denied|rejected|cancel/i.test(error?.message || '')) {
      // 取消签名时静默；取消「切换到 BSC 网络」时给出中文提示
      if (/BSC|BNB|网络/.test(String(error?.message || ''))) showToast(error.message, 'error');
      return null;
    }
    showToast(error?.message || '连接失败', 'error');
    return null;
  } finally {
    walletConnectInProgress = false;
    headerButton.disabled = false;
    if (triggerButton && triggerButton !== headerButton) triggerButton.disabled = false;
    setWalletButton(connectedWalletAddress ? shortWallet(connectedWalletAddress) : '连接钱包');
  }
}

async function disconnectWallet() {
  closeWalletMenu();
  await walletApi('/api/wallet/logout', { method:'POST', body:'{}' }).catch(() => {});
  await window.WGWalletConnector.disconnect().catch(() => {});
  renderWalletDisconnected();
}

document.addEventListener('click', (event) => {
  if (!event.target.closest('.wallet-control')) closeWalletMenu();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeWalletMenu();
});
// fixed 定位的菜单在页面滚动/转屏后会与按钮错位，直接收起
window.addEventListener('scroll', () => closeWalletMenu(), true);
window.addEventListener('resize', () => closeWalletMenu());

async function waitForWalletConnector() {
  if (window.WGWalletConnector) return;
  await new Promise((resolve, reject) => {
    const ready = () => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => {
      window.removeEventListener('wg-wallet-connector-ready', ready);
      reject(new Error('钱包连接器初始化失败'));
    }, 8000);
    window.addEventListener('wg-wallet-connector-ready', ready, { once:true });
    // A failed script download can be retried by clicking the wallet button.
    window.loadWalletConnector?.();
  });
}

// 等待手机钱包延迟注入 provider：钱包内置浏览器切换账户后冷启动时，
// window.ethereum 常晚于页面脚本就绪（MetaMask 系约定注入完成会派发 ethereum#initialized）。
function waitForInjectedProvider(timeoutMs) {
  return new Promise(resolve => {
    let done = false;
    let timer, deadlineTimer;
    const finish = () => {
      if (done) return;
      done = true;
      clearInterval(timer);
      clearTimeout(deadlineTimer);
      window.removeEventListener('ethereum#initialized', finish);
      resolve();
    };
    if (window.ethereum) return finish();
    timer = setInterval(() => { if (window.ethereum) finish(); }, 150);
    window.addEventListener('ethereum#initialized', finish, { once:true });
    deadlineTimer = setTimeout(finish, timeoutMs);
  });
}

// 静默恢复并在冷启动窗口内重试：provider 晚注入 / eth_accounts 冷启动返回空均覆盖。
// restore() 一旦拿到 provider 就会挂好 accountsChanged 监听，故窗口结束后账户更晚就绪也能被 onChange 接住。
async function restoreWithRetry() {
  const deadline = Date.now() + 3500;
  for (;;) {
    const conn = await window.WGWalletConnector.restore().catch(() => null);
    if (conn) return conn;
    await waitForInjectedProvider(800);   // provider 未注入则等注入；已注入则立即返回
    if (Date.now() >= deadline) return window.WGWalletConnector.restore().catch(() => null);
    await new Promise(r => setTimeout(r, 250));   // 等冷启动账户就绪
  }
}

async function prepareWalletConnector() {
  if (connectorReadyPromise) return connectorReadyPromise;
  connectorReadyPromise = (async () => {
  await waitForWalletConnector();
  await window.WGWalletConnector.initialize(walletConfig || {});

  window.WGWalletConnector.onChange(async (connection) => {
    if (connectorRestoring) {
      if (connectedWalletAddress && connection?.address?.toLowerCase() !== connectedWalletAddress.toLowerCase()) pendingWalletSwitch = connection;
      return;
    }
    const previous = connectedWalletAddress;
    if (!connection) return renderWalletDisconnected();
    if (previous && previous.toLowerCase() !== connection.address.toLowerCase()) {
      walletProfile = null;
      window.currentWalletProfile = null;
    }
    renderWalletConnection(connection);
    // connect() is still completing its login flow; the profile request here
    // would otherwise race it and make the first signature appear twice.
    if (walletConnectInProgress || platformLoginPromise) {
      // 进站恢复期间用户切了钱包：记下来，等恢复流程结束后补触发签名+刷新
      pendingWalletSwitch = connection;
      return;
    }
    const profile = await walletApi('/api/wallet/session', { timeoutMs:2500, cache:'no-store' }).catch(() => null);
    if (profile?.authenticated && profile.address?.toLowerCase() === connectedWalletAddress.toLowerCase()) renderWalletProfile(profile);
    // 切换/新连接钱包后旧会话已登出：未登录则自动发起签名（与首次进站的恢复流程同口径），
    // 否则页面停留在「已连接未登录」，矿机等页面不会自动进入已登录视图。
    if (!profile?.authenticated && connectedWalletAddress) {
      await ensurePlatformSession().catch(reportWalletLoginError);
    }
  });
  })().catch(error => { connectorReadyPromise = null; throw error; });
  return connectorReadyPromise;
}

function reportWalletLoginError(error) {
  if (Number(error?.code) === 4001 || /denied|rejected|cancel/i.test(error?.message || '')) return;
  showToast(error?.message || '身份验证失败', 'error');
}

async function initializeWallet() {
  // Deposit/withdrawal configuration is loaded when the account page is opened.
  await prepareWalletConnector();

  // 自动恢复连接：进入/刷新页面时用 eth_accounts 静默恢复账户（不弹授权窗口），
  // 随后无论会话 Cookie 是否有效，都强制发起一次登录签名，钱包里确认后才进入登录态。
  try {
    walletConnectInProgress = true;
    const restored = await restoreWithRetry();
    if (restored) {
      renderWalletConnection(restored);
      // 每次进站都强制重新签名确认：即使 Cookie 会话仍有效也不沿用旧会话。
      // 用户取消签名则停留在已连接未登录态，可从菜单「身份验证」手动重试。
      await ensurePlatformSession(null, { force:true }).catch(reportWalletLoginError);
    } else {
      renderWalletDisconnected();
      // 静默恢复拿不到账户时，主动发起「连接授权 + 登录签名」：
      // 手机钱包重进站常要求重新 eth_requestAccounts 授权，不主动发起就会停在「未连接」且没有任何签名动作，
      // 用户会误以为钱包连不上。无 provider 的普通浏览器不触发，保持静默。
      await waitForInjectedProvider(2000);
      if (window.ethereum?.request) {
        let conn = await window.WGWalletConnector.connect().catch((err) => {
          // -32002：钱包内已有一个待处理的连接请求，稍后重试一次
          if (Number(err?.code) === -32002) return 'retry';
          return null;
        });
        if (conn === 'retry') {
          await new Promise(r => setTimeout(r, 1200));
          conn = await window.WGWalletConnector.connect().catch(() => null);
        }
        if (conn) {
          renderWalletConnection(conn);
          // 每次进站强制签名确认，不沿用上一次的会话
          await ensurePlatformSession(null, { force:true }).catch(reportWalletLoginError);
        } else {
          renderWalletDisconnected();
        }
      }
    }
  } catch {
    renderWalletDisconnected();
  } finally {
    walletConnectInProgress = false;
    connectorRestoring = false;
    // 进站恢复期间用户切了钱包：恢复流程结束后补触发签名+刷新
    if (pendingWalletSwitch) {
      const conn = pendingWalletSwitch;
      pendingWalletSwitch = null;
      if (conn?.address && conn.address.toLowerCase() !== connectedWalletAddress?.toLowerCase()) {
        renderWalletConnection(conn);
      }
      if (connectedWalletAddress && !walletProfile?.authenticated) {
        await ensurePlatformSession(null, { force:true }).catch(reportWalletLoginError);
      }
    }
  }
}

initializeWallet().catch((error) => {
  connectorRestoring = false;
  renderWalletDisconnected();
  showToast(error?.message?.includes('请') ? error.message : '钱包连接器初始化失败', 'error');
});
