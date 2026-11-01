// AIX 商城 · 用户端逻辑（2026-10-30；2026-10-31 担保交易 + 保证金 + 多图/规格/简介 + 买家评论）
// 数据源：/api/mall/*（平台钱包 session，同游戏大厅 /api/a-token/profile 的登录态）。
// 货款担保：下单付款冻结在平台担保账户，买家确认收货后才结算给商户；待发货可取消全额退款。
import { WebsiteSession } from '/games/run-aix/session.js?v=20261028b';
import { signDeposit, signOrder } from '/games/mall/wallet-sign.js?v=20261031e';

const $ = id => document.getElementById(id);
const fmtA = v => { try { const n = Number(v); return n.toLocaleString('zh-CN', { maximumFractionDigits: 6 }); } catch { return '0'; } };
const STATUS = { paid: '待发货', shipped: '已发货', completed: '已完成', cancelled: '已取消' };
const fmtTime = ts => { const d = new Date(Number(ts) || 0); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

let walletState = { status: 'guest' };
let state = null;           // /api/mall/state 结果
let view = 'shop';
let productViewId = null;    // 当前详情页商品 id
let orderFilter = 'all';
let searchQuery = '';        // 顶栏搜索关键词
let sortMode = 'default';    // default / sold / priceAsc / priceDesc

// ── 工具 ──
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
  const login = $('wallet-login');
  const guest = walletState.status === 'guest';
  $('balance').textContent = !guest && state?.balanceA != null ? fmtA(state.balanceA) : '—';
  login.hidden = !guest;
}
// 商城为普通独立页面（非弹窗）：未登录时按钮直达站内首页登录
$('wallet-login').onclick = () => { location.href = '/'; };

// ── 数据加载 ──
async function loadState() {
  try { state = await api('/api/mall/state'); } catch { state = null; }
  render();
}

// ── 路由 ──
function route() {
  const hash = location.hash.slice(1);
  if (hash.startsWith('product/')) { productViewId = hash.slice(8); view = 'product'; }
  else if (['orders', 'address', 'merchant'].includes(hash)) view = hash;
  else view = 'shop';
  render();
}
window.addEventListener('hashchange', route);

function render() {
  const views = { shop: 'view-shop', product: 'view-product', orders: 'view-orders', address: 'view-address', merchant: 'view-merchant' };
  for (const key of Object.keys(views)) $(views[key]).hidden = key !== view;
  for (const link of document.querySelectorAll('[data-nav]')) {
    const active = link.dataset.nav === view;
    link.classList.toggle('active', active);
    if (active) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
  }
  if (view === 'shop') renderShop();
  if (view === 'product') renderProduct();
  if (view === 'orders') renderOrders();
  if (view === 'address') renderAddresses();
  if (view === 'merchant') renderMerchantEntry();
  renderWallet();
  window.scrollTo({ top: 0, behavior: 'instant' });
}

// ── 逛商城 ──
function starText(avg) { return '★'.repeat(Math.round(avg)) + '☆'.repeat(5 - Math.round(avg)); }
function productThumb(product, className = 'glyph') {
  const cover = product.images?.[0] || product.imageUrl;
  if (cover) {
    const img = el('img'); img.src = cover; img.alt = product.title; img.loading = 'lazy';
    img.onerror = () => { img.replaceWith(el('span', className, product.title.slice(0, 1))); };
    return img;
  }
  return el('span', className, product.title.slice(0, 1));
}
function visibleProducts() {
  let list = (state?.products || []).slice();
  const q = searchQuery.trim().toLowerCase();
  if (q) list = list.filter(p => p.title.toLowerCase().includes(q) || (p.shopName || '').toLowerCase().includes(q));
  if (sortMode === 'sold') list.sort((a, b) => Number(b.sold) - Number(a.sold));
  else if (sortMode === 'priceAsc') list.sort((a, b) => Number(a.priceA) - Number(b.priceA));
  else if (sortMode === 'priceDesc') list.sort((a, b) => Number(b.priceA) - Number(a.priceA));
  return list;
}
function renderShop() {
  const products = visibleProducts();
  const total = (state?.products || []).length;
  $('result-count').textContent = searchQuery.trim() ? `搜索到 ${products.length} / ${total} 件商品` : (total ? `共 ${total} 件商品` : '');
  $('shop-empty').hidden = products.length > 0;
  const grid = $('shop-grid'); grid.replaceChildren();
  for (const product of products) {
    const card = el('article', 'p-card');
    const thumb = el('div', 'p-thumb'); thumb.append(productThumb(product));
    thumb.append(el('span', 'p-sold', `已售 ${product.sold}`));
    const body = el('div', 'p-body');
    body.append(el('div', 'p-title', product.title));
    if (product.summary) body.append(el('div', 'p-summary', product.summary));
    const shopLine = el('div', 'p-shop', `${product.shopName} · 库存 ${product.stock}`);
    if (product.reviewCount > 0) {
      shopLine.append(el('span', 'p-rating', ` ${starText(product.ratingAvg)} ${product.ratingAvg}（${product.reviewCount}）`));
    }
    body.append(shopLine);
    const meta = el('div', 'p-meta');
    const price = el('span', 'p-price', fmtA(product.priceA));
    price.append(el('small', '', 'AIX'));
    meta.append(price);
    body.append(meta);
    card.append(thumb, body);
    card.onclick = () => { location.hash = `#product/${product.id}`; };
    grid.append(card);
  }
}
$('search-input').addEventListener('input', event => {
  searchQuery = event.target.value;
  if (view !== 'shop') { location.hash = '#shop'; return; }
  renderShop();
});
for (const button of $('sort-tabs').querySelectorAll('button')) {
  button.onclick = () => {
    sortMode = button.dataset.sort;
    for (const b of $('sort-tabs').querySelectorAll('button')) b.classList.toggle('active', b === button);
    renderShop();
  };
}
$('hero-cta').onclick = event => {
  event.preventDefault();
  $('shop-toolbar').scrollIntoView({ behavior: 'smooth', block: 'start' });
};

// ── 商品详情 + 购买 ──
async function loadReviews(productId, box) {
  try {
    const { reviews } = await api(`/api/mall/reviews?productId=${encodeURIComponent(productId)}`);
    box.replaceChildren();
    if (!reviews.length) { box.append(el('p', 'p-stock', '还没有买家评价，购买后可发表第一条评价。')); return; }
    for (const review of reviews) {
      const item = el('div', 'review-item');
      const head = el('div', 'review-head');
      head.append(el('span', 'review-stars', starText(review.rating)),
        el('span', 'review-buyer', review.buyerMask),
        el('span', 'review-date', fmtTime(review.createdAt)));
      item.append(head);
      if (review.content) item.append(el('p', 'review-content', review.content));
      box.append(item);
    }
  } catch { /* 评论加载失败不影响购买 */ }
}
function renderProduct() {
  const product = (state?.products || []).find(p => p.id === productViewId);
  const box = $('view-product'); box.replaceChildren();
  if (!product) {
    const empty = el('div', 'empty-state'); empty.append(el('span', '', '⌁'), el('h3', '', '商品不存在或已下架'));
    const back = el('a', 'subtle-button', '返回商城 ↗'); back.href = '#shop'; empty.append(back);
    box.append(empty); return;
  }
  let quantity = 1;
  const heading = el('div', 'page-heading');
  heading.append(el('span', 'eyebrow', 'PRODUCT'), el('h1', '', product.title));
  const layout = el('div', 'product-layout');

  // 左侧：图集（主图 + 缩略图条）+ 规格/简介 + 详情 + 评论
  const left = el('div');
  const images = product.images?.length ? product.images : (product.imageUrl ? [product.imageUrl] : []);
  const hero = el('div', 'product-hero');
  const setHero = url => {
    hero.replaceChildren();
    if (!url) { hero.append(el('span', 'glyph', product.title.slice(0, 1))); return; }
    const img = el('img'); img.src = url; img.alt = product.title;
    img.onerror = () => { hero.replaceChildren(el('span', 'glyph', product.title.slice(0, 1))); };
    hero.append(img);
  };
  setHero(images[0] || '');
  left.append(hero);
  if (images.length > 1) {
    const strip = el('div', 'thumb-strip');
    for (const url of images) {
      const thumb = el('button', 'thumb-item'); thumb.type = 'button';
      const img = el('img'); img.src = url; img.alt = product.title; img.loading = 'lazy';
      thumb.append(img);
      thumb.onclick = () => {
        setHero(url);
        for (const t of strip.children) t.classList.toggle('active', t === thumb);
      };
      if (url === images[0]) thumb.classList.add('active');
      strip.append(thumb);
    }
    left.append(strip);
  }
  if (product.summary) {
    const summaryPanel = el('section', 'panel'); summaryPanel.style.marginTop = '18px';
    const t = el('div', 'panel-title'); t.append(el('h2', '', '商品简介'));
    summaryPanel.append(t, el('p', 'product-desc', product.summary));
    left.append(summaryPanel);
  }
  const descPanel = el('section', 'panel'); descPanel.style.marginTop = '18px';
  const descTitle = el('div', 'panel-title'); descTitle.append(el('h2', '', '商品详情'));
  descPanel.append(descTitle);
  if (product.spec) {
    const specRow = el('div', 'spec-row');
    specRow.append(el('span', 'spec-label', '规格尺寸'), el('span', 'spec-value', product.spec));
    descPanel.append(specRow);
  }
  descPanel.append(el('p', 'product-desc', product.description || '该商品暂无描述。'));
  const shopLine = el('p', 'p-shop', `商家：${product.shopName}（${product.merchantMask}）`); shopLine.style.marginTop = '10px';
  descPanel.append(shopLine);
  left.append(descPanel);
  // 买家评论区
  const reviewPanel = el('section', 'panel'); reviewPanel.style.marginTop = '18px';
  const reviewTitle = el('div', 'panel-title');
  reviewTitle.append(el('h2', '', `买家评价${product.reviewCount ? `（${product.reviewCount}）` : ''}`));
  if (product.reviewCount > 0) reviewTitle.append(el('span', 'p-rating', `${starText(product.ratingAvg)} ${product.ratingAvg}`));
  const reviewList = el('div', 'review-list');
  reviewList.append(el('p', 'p-stock', '评价加载中…'));
  reviewPanel.append(reviewTitle, reviewList);
  left.append(reviewPanel);
  loadReviews(product.id, reviewList);

  const right = el('section', 'panel buy-panel');
  const priceRow = el('div', 'p-meta'); priceRow.style.padding = '0 0 12px';
  const priceText = el('span', 'p-price', `${fmtA(product.priceA)} `);
  priceText.append(el('small', '', 'AIX / 件'));
  priceRow.append(priceText);
  const stockLine = el('p', `p-stock${product.stock <= 5 ? ' low' : ''}`,
    product.stock <= 5 ? `仅剩 ${product.stock} 件` : `库存 ${product.stock} 件`);
  right.append(priceRow, stockLine);

  const qtyLabel = el('label', 'field-label', '购买数量');
  const qtyRow = el('div', 'qty-row');
  const minus = el('button', 'qty-button', '−'); const plus = el('button', 'qty-button', '+');
  const qtyValue = el('span', 'qty-value', '1');
  const clampQty = () => { quantity = Math.min(Math.max(quantity, 1), Math.min(product.stock, 99)); qtyValue.textContent = quantity; refreshTotal(); };
  minus.onclick = () => { quantity -= 1; clampQty(); };
  plus.onclick = () => { quantity += 1; clampQty(); };
  qtyRow.append(minus, qtyValue, plus);

  const addrLabel = el('label', 'field-label', '收货地址');
  const addrSelect = el('select', 'input');
  const addresses = state?.addresses || [];
  for (const address of addresses) {
    const option = el('option', '', `${address.isDefault ? '★ ' : ''}${address.receiver} · ${address.region} ${address.detail}`);
    option.value = address.id; addrSelect.append(option);
  }
  if (!addresses.length) addrSelect.append(Object.assign(el('option', '', '请先添加收货地址'), { disabled: true, selected: true }));
  const manageAddr = el('a', 'ghost-button', '管理地址 ↗'); manageAddr.href = '#address';
  manageAddr.style.marginTop = '8px';

  const total = el('div', 'total-row');
  const totalLabel = el('span', '', '应付合计'); const totalValue = el('b', '', '— AIX');
  total.append(totalLabel, totalValue);
  function refreshTotal() { totalValue.textContent = ''; totalValue.append(el('span', '', fmtA(String(Number(product.priceA) * quantity))), el('small', '', ' AIX')); }
  refreshTotal();

  const buy = el('button', 'primary-button', '确认支付');
  buy.style.width = '100%';
  const message = el('p', 'form-message');
  buy.onclick = async () => {
    if (walletState.status === 'guest') { toast('请先登录钱包再下单', 'err'); return; }
    if (!addresses.length) { message.textContent = '请先添加收货地址'; return; }
    if (!addrSelect.value) { message.textContent = '请选择收货地址'; return; }
    buy.disabled = true; message.textContent = '';
    try {
      message.textContent = '请在钱包中签名确认支付…';
      const { signature, timestamp } = await signOrder({ address: walletState.address, productId: product.id, quantity });
      message.textContent = '支付中…';
      const result = await api('/api/mall/orders', { productId: product.id, quantity, addressId: addrSelect.value, signature, timestamp });
      toast(`下单成功，${result.order.totalA} AIX 已由平台担保`, 'ok');
      await loadState();
      location.hash = '#orders';
    } catch (e) { message.textContent = e.message; toast(e.message, 'err'); }
    finally { buy.disabled = false; }
  };

  right.append(qtyLabel, qtyRow, addrLabel, addrSelect, manageAddr, total, buy, message,
    el('p', 'p-stock', '货款由平台担保：确认收货后才结算给商户；商家发货前可随时取消并全额退款。'));
  layout.append(left, right);
  box.append(heading, layout);
}

// ── 我的订单 ──
function orderCard(order, { merchantView = false } = {}) {
  const card = el('article', 'order-card');
  const head = el('div', 'order-head');
  head.append(el('span', `badge ${order.status}`, STATUS[order.status] || order.status));
  head.append(el('span', 'order-id', order.id));
  head.append(el('span', 'order-date', fmtTime(order.createdAt)));
  const body = el('div', 'order-body');
  const info = el('div', 'order-info');
  info.append(el('h3', '', order.productTitle));
  const line = el('div', 'line');
  line.append(el('span', '', `× ${order.quantity}`), el('span', '', '单价'), el('b', '', `${fmtA(order.priceA)} AIX`),
    el('span', '', '合计'), el('b', '', `${fmtA(order.totalA)} AIX`));
  info.append(line);
  body.append(info);

  const addrBlock = el('div', 'order-block');
  addrBlock.append(el('span', 'block-label', '收货地址'));
  addrBlock.append(el('div', '', `${order.address.receiver} ${order.address.phone}`));
  addrBlock.append(el('div', '', `${order.address.region} ${order.address.detail}`));
  body.append(addrBlock);

  if (merchantView) {
    const buyerBlock = el('div', 'order-block');
    buyerBlock.append(el('span', 'block-label', '买家'));
    buyerBlock.append(el('div', '', order.buyerMask));
    body.append(buyerBlock);
  }

  if (order.status === 'shipped' || order.status === 'completed') {
    const shipBlock = el('div', 'order-block');
    shipBlock.append(el('span', 'block-label', '物流信息'));
    shipBlock.append(el('div', '', `${order.shipCompany} · ${order.shipTracking}`));
    shipBlock.append(el('div', '', `发货时间 ${fmtTime(order.shippedAt)}`));
    body.append(shipBlock);
  }
  card.append(head, body);

  const actions = el('div', 'order-actions');
  if (!merchantView) {
    if (order.status === 'shipped') {
      const days = state?.depositInfo?.autoConfirmDays || 15;
      const tip = el('span', 'p-stock', `已发货：收货后请及时确认；发货满 ${days} 天未确认将自动确认并结算给商户`); tip.style.alignSelf = 'center';
      actions.append(tip);
      const confirm = el('button', 'primary-button', '确认收货');
      confirm.onclick = async () => {
        confirm.disabled = true;
        try { await api('/api/mall/orders/confirm', { orderId: order.id }); toast('已确认收货，货款已结算给商户', 'ok'); await loadState(); }
        catch (e) { toast(e.message, 'err'); confirm.disabled = false; }
      };
      actions.append(confirm);
    }
    if (order.status === 'completed') {
      if (order.reviewed) {
        actions.append(el('span', 'p-stock', '已评价，感谢反馈'));
      } else {
        const reviewBtn = el('button', 'ghost-button', '评价晒单');
        reviewBtn.onclick = () => {
          reviewBtn.remove();
          const form = el('div', 'review-form');
          const stars = el('div', 'star-picker');
          let rating = 5;
          const paint = () => { [...stars.children].forEach((s, i) => s.classList.toggle('on', i < rating)); };
          for (let i = 1; i <= 5; i++) {
            const star = el('button', 'star', '★'); star.type = 'button';
            star.onclick = () => { rating = i; paint(); };
            stars.append(star);
          }
          paint();
          const input = el('textarea', 'input'); input.rows = 3; input.maxLength = 300; input.placeholder = '分享商品质量、物流速度等感受（选填，300 字内）';
          const submit = el('button', 'primary-button', '发表评价');
          submit.onclick = async () => {
            submit.disabled = true;
            try {
              await api('/api/mall/orders/review', { orderId: order.id, rating, content: input.value.trim() });
              toast('评价已发表', 'ok'); await loadState();
            } catch (e) { toast(e.message, 'err'); submit.disabled = false; }
          };
          form.append(stars, input, submit);
          card.append(form);
        };
        actions.append(reviewBtn);
      }
    }
    if (order.status === 'paid') {
      const tip = el('span', 'p-stock', '货款平台担保中：商家还未发货，可随时取消并全额退款'); tip.style.alignSelf = 'center';
      actions.append(tip);
      const cancel = el('button', 'danger-button', '取消订单');
      cancel.onclick = async () => {
        if (!window.confirm(`确认取消该订单？将全额退款 ${fmtA(order.totalA)} AIX 至你的账户。`)) return;
        cancel.disabled = true;
        try { const r = await api('/api/mall/orders/cancel', { orderId: order.id }); toast(`已取消，退款 ${r.refundA} AIX 已到账`, 'ok'); await loadState(); }
        catch (e) { toast(e.message, 'err'); cancel.disabled = false; }
      };
      actions.append(cancel);
    }
  }
  if (actions.childNodes.length) card.append(actions);
  return card;
}
function renderOrders() {
  const orders = state?.orders || [];
  const filtered = orderFilter === 'all' ? orders : orders.filter(o => o.status === orderFilter);
  for (const button of $('order-filters').querySelectorAll('button')) {
    const active = button.dataset.filter === orderFilter;
    button.classList.toggle('active', active);
    button.onclick = () => { orderFilter = button.dataset.filter; renderOrders(); };
  }
  const list = $('orders-list'); list.replaceChildren();
  for (const order of filtered) list.append(orderCard(order));
  $('orders-empty').hidden = orders.length > 0;
  if (orders.length && !filtered.length) {
    const empty = el('div', 'empty-state'); empty.append(el('h3', '', '该状态下暂无订单'));
    list.append(empty);
  }
}

// ── 收货地址 ──
function renderAddresses() {
  const addresses = state?.addresses || [];
  const grid = $('address-grid'); grid.replaceChildren();
  $('address-empty').hidden = addresses.length > 0;
  for (const address of addresses) {
    const card = el('article', `addr-card${address.isDefault ? ' default' : ''}`);
    const h3 = el('h3', '', address.receiver);
    if (address.isDefault) h3.append(el('span', 'default-chip', '默认'));
    card.append(h3, el('div', 'phone', address.phone), el('div', 'region', address.region), el('div', 'detail', address.detail));
    const actions = el('div', 'addr-actions');
    if (!address.isDefault) {
      const setDefault = el('button', 'ghost-button', '设为默认');
      setDefault.onclick = async () => {
        try { await api('/api/mall/addresses/default', { id: address.id }); toast('已设为默认地址', 'ok'); await loadState(); }
        catch (e) { toast(e.message, 'err'); }
      };
      actions.append(setDefault);
    }
    const remove = el('button', 'danger-button', '删除');
    remove.onclick = async () => {
      if (!window.confirm('确认删除该地址？')) return;
      try { await api('/api/mall/addresses/delete', { id: address.id }); toast('地址已删除', 'ok'); await loadState(); }
      catch (e) { toast(e.message, 'err'); }
    };
    actions.append(remove);
    card.append(actions);
    grid.append(card);
  }
}
$('address-form').onsubmit = async event => {
  event.preventDefault();
  const message = $('address-message'); message.className = 'form-message'; message.textContent = '';
  try {
    await api('/api/mall/addresses', {
      receiver: $('addr-receiver').value, phone: $('addr-phone').value,
      region: $('addr-region').value, detail: $('addr-detail').value,
      isDefault: $('addr-default').checked,
    });
    toast('地址已保存', 'ok'); message.className = 'form-message ok'; message.textContent = '地址已保存';
    $('address-form').reset(); $('addr-default').checked = true;
    await loadState();
  } catch (e) { message.textContent = e.message; }
};

// ── 商户入驻 ──
function renderMerchantEntry() {
  const merchant = state?.merchant;
  const active = merchant?.status === 'active';
  const pending = merchant?.status === 'pending' || merchant?.status === 'closing';
  $('merchant-existing').hidden = !active;
  $('merchant-apply').hidden = Boolean(active || pending);
  $('merchant-pending').hidden = !pending;
  if (active) {
    $('my-shop-name').textContent = merchant.shopName;
    $('my-shop-intro').textContent = merchant.intro || '欢迎光临本店';
    $('my-shop-avatar').textContent = merchant.shopName.slice(0, 1);
  } else if (!pending && state?.depositInfo) {
    $('deposit-usdt-amount').textContent = `${state.depositInfo.usdt} USDT`;
    $('deposit-aix-amount').textContent = `${state.depositInfo.aix} AIX`;
  }
}
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
    toast('入驻申请已提交，保证金已冻结，等待平台审核', 'ok');
    await loadState(); renderMerchantEntry();
  } catch (e) { message.textContent = e.message; }
};

// ── 启动 ──
window.addEventListener('focus', () => loadState());
loadState();
route();
