// AIX 商城 · 商户后台逻辑（2026-10-30；2026-10-31 担保交易 + 保证金 + 商品多图/规格/简介）
// 数据源：/api/mall/merchant/*（平台钱包 session）。开店需缴纳保证金（USDT 或 AIX 二选一），
// 上架商品（最多 6 张图 + 规格 + 简介）/ 编辑价格库存 / 上下架 / 按买家地址发货并登记物流单号。
// 货款担保：买家付款冻结在平台担保账户，买家确认收货后才结算到商户 AIX 余额。
import { WebsiteSession } from '/games/run-aix/session.js?v=20261028b';
import { signDeposit } from '/games/mall/wallet-sign.js?v=20261031e';

const $ = id => document.getElementById(id);
const fmtA = v => { try { const n = Number(v); return n.toLocaleString('zh-CN', { maximumFractionDigits: 6 }); } catch { return '0'; } };
const STATUS = { paid: '待发货', shipped: '已发货', completed: '已完成', cancelled: '已取消' };
const fmtTime = ts => { const d = new Date(Number(ts) || 0); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

let walletState = { status: 'guest' };
let state = null;
let view = 'products';
let orderFilter = 'paid';

let toastTimer = null;
function toast(message, kind = '') {
  const el = $('toast'); el.textContent = message; el.className = `toast show ${kind}`;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.className = 'toast'; }, 2600);
}
async function api(path, body) {
  const response = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    credentials: 'same-origin', cache: 'no-store',
    body: body === undefined ? undefined : JSON.stringify(body || {}),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `请求失败 (${response.status})`);
  return data;
}
function el(tag, className, text) { const node = document.createElement(tag); if (className) node.className = className; if (text != null) node.textContent = text; return node; }

// ── 会话 ──
const session = new WebsiteSession(next => { walletState = next; renderWallet(); });
session.start();
function renderWallet() {
  $('wallet-login').hidden = walletState.status !== 'guest';
  $('balance').textContent = walletState.status !== 'guest' && state?.balanceA != null ? fmtA(state.balanceA) : '—';
}
// 商户后台页直接连接钱包（不跳首页）：连接器 → BSC → 挑战签名 → 建立 session → 刷新
async function connectMerchantWallet() {
  const btn = $('wallet-login');
  if (btn) { btn.disabled = true; btn.textContent = '连接中…'; }
  try {
    if (!window.WGWalletConnector) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('钱包连接器加载失败，请刷新页面重试')), 8000);
        window.addEventListener('wg-wallet-connector-ready', () => { clearTimeout(timer); resolve(); }, { once: true });
        window.loadWalletConnector?.();
      });
    }
    const conn = await window.WGWalletConnector.connect();
    if (!conn?.address) throw new Error('未获取到钱包地址');
    const address = String(conn.address);
    const provider = conn.provider || window.ethereum;
    if (!provider) throw new Error('钱包 provider 不可用');
    // 平台仅支持 BNB Smart Chain（chainId 56）
    try { await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x38' }] }); } catch { /* 已是 BSC 或钱包拒绝切换不阻断 */ }
    const challenge = await api('/api/wallet/login-challenge', { address });
    const signature = await provider.request({ method: 'personal_sign', params: [challenge.message, address] });
    await api('/api/wallet/login-sign', { message: challenge.message, signature });
    await session.refresh();
    loadState();
  } catch (e) {
    if (Number(e?.code) === 4001 || /denied|rejected|cancel/i.test(e?.message || '')) return;  // 用户取消静默
    toast(e?.message || '连接钱包失败', 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '连接钱包'; }
  }
}
// 未登录时：在当前页直接连接钱包，不再跳首页
$('wallet-login').onclick = () => connectMerchantWallet();

// ── 数据与路由 ──
async function loadState() {
  try { state = await api('/api/mall/merchant/state'); } catch { state = null; }
  render();
}
function route() {
  const hash = location.hash.slice(1);
  view = hash === 'orders' ? 'orders' : 'products';
  render();
}
window.addEventListener('hashchange', route);

function render() {
  const merchant = state?.merchant;
  const active = merchant?.status === 'active';
  const applyView = $('view-apply');
  applyView.hidden = Boolean(active);
  $('view-products').hidden = !active || view !== 'products';
  $('view-orders').hidden = !active || view !== 'orders';
  // 审核状态提示：pending = 审核中（隐藏表单）；rejected = 已拒绝（显示表单可重新申请）
  const statusBox = $('apply-status');
  if (statusBox && merchant && !active) {
    statusBox.hidden = false;
    if (merchant.status === 'pending') {
      statusBox.innerHTML = '<b>入驻申请审核中</b><br>保证金已缴纳并冻结，平台审核通过后即可上架商品；若未通过保证金将全额退回。';
      $('apply-form').hidden = true;
    } else if (merchant.status === 'closing') {
      statusBox.innerHTML = '<b>关店申请审核中</b><br>平台审核通过后保证金将原路退回你的平台余额；审核期间店铺暂停经营。';
      $('apply-form').hidden = true;
    } else {
      statusBox.innerHTML = merchant.status === 'closed'
        ? '<b>店铺已关闭</b><br>保证金已退回你的平台余额，如需重新经营请重新提交入驻申请（需重新缴纳保证金）。'
        : '<b>入驻申请未通过</b><br>保证金已退回你的平台余额，可修改资料后重新提交申请（需重新缴纳保证金）。';
      $('apply-form').hidden = false;
    }
  } else if (statusBox) {
    statusBox.hidden = true;
    $('apply-form').hidden = false;
  }
  for (const link of document.querySelectorAll('[data-nav]')) {
    const navActive = link.dataset.nav === view;
    link.classList.toggle('active', active && navActive);
    if (active && navActive) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
  }
  $('breadcrumb-current').textContent = active ? (view === 'orders' ? '订单管理' : '商品管理') : '商户后台';
  if (active) {
    if (view === 'products') renderProducts();
    if (view === 'orders') renderOrders();
  }
  renderWallet();
  window.scrollTo({ top: 0, behavior: 'instant' });
}

// ── 商品管理 ──
function renderShopBanner() {
  const banner = $('shop-banner'); banner.replaceChildren();
  const merchant = state.merchant;
  const products = state.products || [];
  const orders = state.orders || [];
  const pending = orders.filter(o => o.status === 'paid').length;
  const revenue = orders.filter(o => o.status !== 'cancelled').reduce((sum, o) => sum + Number(o.totalA), 0);
  const box = el('div', 'shop-banner');
  const avatar = el('div', 'shop-avatar', merchant.shopName.slice(0, 1));
  const info = el('div');
  info.append(el('h2', '', `${merchant.shopName} `));
  info.append(el('p', '', merchant.intro || '欢迎光临本店'));
  const stats = el('div', 'shop-stats');
  const items = [
    [String(products.filter(p => p.status === 'active').length), '在售'],
    [String(pending), '待发货'],
    [fmtA(revenue), '累计销售 AIX'],
  ];
  for (const [value, label] of items) {
    const cell = el('div'); cell.append(el('b', '', value), el('span', '', label)); stats.append(cell);
  }
  box.append(avatar, info, stats);
  // 申请关店：需先下架全部商品且无进行中订单，平台审核通过后退回保证金
  const closeBtn = el('button', 'ghost-button', '申请关店退保证金');
  closeBtn.style.marginLeft = 'auto';
  closeBtn.onclick = async () => {
    if (!confirm('申请关闭店铺并退回保证金？\n\n前提：已下架全部商品、无进行中订单。\n提交后平台审核通过即退回保证金，期间店铺暂停经营。')) return;
    closeBtn.disabled = true;
    try {
      await api('/api/mall/merchant/close-apply', {});
      toast('关店申请已提交，等待平台审核', 'ok');
      await loadState();
    } catch (e) { toast(e.message, 'err'); closeBtn.disabled = false; }
  };
  box.append(closeBtn);
  banner.append(box);
}
function renderProducts() {
  renderShopBanner();
  const products = state.products || [];
  const rows = $('product-rows'); rows.replaceChildren();
  $('product-empty').hidden = products.length > 0;
  $('product-count').textContent = `共 ${products.length} 件`;
  for (const product of products) {
    const tr = el('tr');
    tr.append(el('td', '', product.title));
    const priceTd = el('td');
    const priceInput = el('input', 'inline-input'); priceInput.value = product.priceA; priceInput.inputMode = 'decimal';
    priceTd.append(priceInput); tr.append(priceTd);
    const stockTd = el('td');
    const stockInput = el('input', 'inline-input'); stockInput.type = 'number'; stockInput.min = '0'; stockInput.max = '999999'; stockInput.value = String(product.stock);
    stockTd.append(stockInput); tr.append(stockTd);
    tr.append(el('td', '', String(product.sold)));
    const statusTd = el('td');
    statusTd.append(el('span', `badge ${product.status}`, product.status === 'active' ? '在售' : '已下架'));
    tr.append(statusTd);
    const actionsTd = el('td');
    const actions = el('div', 'cell-actions');
    const save = el('button', 'ghost-button', '保存修改');
    save.onclick = async () => {
      save.disabled = true;
      try {
        await api('/api/mall/merchant/products/update', {
          id: product.id, priceA: priceInput.value.trim(), stock: Number(stockInput.value),
        });
        toast('商品已更新', 'ok'); await loadState();
      } catch (e) { toast(e.message, 'err'); save.disabled = false; }
    };
    const toggle = el('button', product.status === 'active' ? 'danger-button' : 'subtle-button',
      product.status === 'active' ? '下架' : '重新上架');
    toggle.onclick = async () => {
      try {
        await api('/api/mall/merchant/products/update', { id: product.id, status: product.status === 'active' ? 'off' : 'active' });
        toast(product.status === 'active' ? '商品已下架' : '商品已上架', 'ok'); await loadState();
      } catch (e) { toast(e.message, 'err'); }
    };
    actions.append(save, toggle);
    actionsTd.append(actions); tr.append(actionsTd);
    rows.append(tr);
  }
}
$('product-form').onsubmit = async event => {
  event.preventDefault();
  const message = $('product-message'); message.className = 'form-message'; message.textContent = '';
  const images = [...document.querySelectorAll('#p-images [data-image]')].map(i => i.value.trim()).filter(Boolean);
  try {
    await api('/api/mall/merchant/products', {
      title: $('p-title').value, priceA: $('p-price').value.trim(), stock: Number($('p-stock').value),
      summary: $('p-summary').value.trim(), spec: $('p-spec').value.trim(),
      images, description: $('p-desc').value,
    });
    toast('商品已上架', 'ok');
    $('product-form').reset();
    await loadState();
  } catch (e) { message.textContent = e.message; }
};

// ── 订单管理 ──
function renderOrders() {
  const orders = state.orders || [];
  const filtered = orderFilter === 'all' ? orders : orders.filter(o => o.status === orderFilter);
  for (const button of $('order-filters').querySelectorAll('button')) {
    const active = button.dataset.filter === orderFilter;
    button.classList.toggle('active', active);
    const count = orderFilter === 'all' ? orders.length : orders.filter(o => o.status === button.dataset.filter).length;
    button.textContent = ''; button.append(document.createTextNode(`${STATUS[button.dataset.filter] || '全部'}`), el('span', 'count', String(count)));
    button.onclick = () => { orderFilter = button.dataset.filter; renderOrders(); };
  }
  const list = $('orders-list'); list.replaceChildren();
  $('orders-empty').hidden = orders.length > 0;
  for (const order of filtered) list.append(merchantOrderCard(order));
  if (orders.length && !filtered.length) {
    const empty = el('div', 'empty-state'); empty.append(el('h3', '', '该状态下暂无订单'));
    list.append(empty);
  }
}
function merchantOrderCard(order) {
  const card = el('article', 'order-card');
  const head = el('div', 'order-head');
  head.append(el('span', `badge ${order.status}`, STATUS[order.status] || order.status));
  head.append(el('span', 'order-id', order.id));
  head.append(el('span', 'order-date', fmtTime(order.createdAt)));
  const body = el('div', 'order-body');
  const info = el('div', 'order-info');
  info.append(el('h3', '', order.productTitle));
  const line = el('div', 'line');
  line.append(el('span', '', `买家 ${order.buyerMask}`), el('span', '', `× ${order.quantity}`),
    el('span', '', '合计'), el('b', '', `${fmtA(order.totalA)} AIX`));
  info.append(line);
  body.append(info);
  // 收货地址 + 电话（发货必读，可一键复制）
  const addrBlock = el('div', 'order-block');
  addrBlock.append(el('span', 'block-label', '收货地址'));
  addrBlock.append(el('div', '', `${order.address.receiver} ${order.address.phone}`));
  addrBlock.append(el('div', '', `${order.address.region} ${order.address.detail}`));
  const copy = el('span', 'copy', '复制');
  copy.onclick = () => {
    const text = `${order.address.receiver} ${order.address.phone} ${order.address.region} ${order.address.detail}`;
    navigator.clipboard?.writeText(text).then(() => toast('收货地址已复制', 'ok'), () => toast('复制失败，请手动选择', 'err'));
  };
  addrBlock.prepend(copy);
  body.append(addrBlock);
  if (order.status === 'shipped' || order.status === 'completed') {
    const shipBlock = el('div', 'order-block');
    shipBlock.append(el('span', 'block-label', '物流信息'));
    shipBlock.append(el('div', '', `${order.shipCompany} · ${order.shipTracking}`));
    shipBlock.append(el('div', '', `发货时间 ${fmtTime(order.shippedAt)}`));
    body.append(shipBlock);
  }
  card.append(head, body);

  if (order.status === 'paid') {
    const form = el('div', 'ship-form');
    const company = el('input', 'input'); company.placeholder = '物流公司，如顺丰速运'; company.maxLength = 40;
    const tracking = el('input', 'input'); tracking.placeholder = '物流单号'; tracking.maxLength = 64;
    const submit = el('button', 'primary-button', '确认发货');
    submit.onclick = async () => {
      if (!company.value.trim() || !tracking.value.trim()) { toast('请填写物流公司与单号', 'err'); return; }
      submit.disabled = true;
      try {
        await api('/api/mall/merchant/orders/ship', { orderId: order.id, company: company.value.trim(), tracking: tracking.value.trim() });
        toast('已发货并登记物流信息', 'ok'); await loadState();
      } catch (e) { toast(e.message, 'err'); submit.disabled = false; }
    };
    form.append(company, tracking, submit);
    const actions = el('div', 'order-actions');
    actions.append(el('span', 'p-stock', '买家已付款（平台担保中），请尽快按地址发货并登记单号；买家确认收货后货款结算到你的 AIX 余额'), form);
    card.append(actions);
  }
  return card;
}

// ── 开店 ──
$('apply-form').onsubmit = async event => {
  event.preventDefault();
  const message = $('apply-message'); message.className = 'form-message'; message.textContent = '';
  const depositCurrency = document.querySelector('input[name="deposit-currency"]:checked')?.value || 'USDT';
  const shopName = $('apply-shop-name').value.trim();
  try {
    if (walletState.status !== 'ready') { message.textContent = '请先登录钱包再申请开店'; return; }
    const amount = depositCurrency === 'USDT' ? (state?.depositInfo?.usdt || '100') : (state?.depositInfo?.aix || '5000');
    message.textContent = '请在钱包中签名确认缴纳保证金…';
    const { signature, timestamp } = await signDeposit({ address: walletState.address, shopName, currency: depositCurrency, amount });
    message.textContent = '保证金缴纳中…';
    await api('/api/mall/merchant/apply', { shopName, intro: $('apply-intro').value, depositCurrency, signature, timestamp });
    toast('入驻申请已提交，等待平台审核', 'ok');
    await loadState();
  } catch (e) { message.textContent = e.message; }
};

// ── 启动 ──
window.addEventListener('focus', () => loadState());
loadState();
route();
