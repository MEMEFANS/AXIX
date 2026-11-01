// AIX 商城 API /api/mall/*（需钱包 session）。
// 2026-10-30 新增板块；2026-10-31 担保交易改版：
//   · 货款担保：下单扣买家 AIX → 平台担保账户（ESCROW_WALLET）冻结，
//     买家确认收货后才结算给商户（同时释放商户可卖额度）；待发货取消 = 担保账户原路退款；
//   · 开店保证金：申请开店需缴纳保证金，可选 USDT（100）或 AIX（5000），记录在商户档案；
//   · 商品资料：支持最多 6 张图片、规格尺寸（spec）、简介（summary），存于 payload_json；
//   · 买家评论：completed 订单可发表 1–5 星 + 文字评论，每单一条，商品详情页公开展示；
//   · 订单状态机：paid（已付款待发货）→ shipped（已发货）→ completed（已收货结算）；
//     仅 paid 可由买家取消：担保账户全额退款 + 回补库存。
import { randomUUID } from 'node:crypto';
import { parseUnits, formatUnits } from 'ethers';

const A_TOKEN_DECIMALS = 18;
const MIN_PRICE_A = '0.01';
const MAX_PRICE_A = '1000000';
const MAX_QTY = 99;
const ORDER_LIMIT = 100;
const PRODUCT_LIMIT = 200;
const MAX_IMAGES = 6;
// 货款担保账户：仅商城订单冻结资金进出，不属任何真实用户。
const ESCROW_WALLET = '0x000000000000000000000000000000000000e5c0';
// 开店保证金（二选一）：USDT 走平台 USDT 账本（6 位小数），AIX 走 A 账本（18 位小数）。
const DEPOSIT_USDT = '100';
const DEPOSIT_AIX = '5000';
// 超时自动确认收货：发货满 N 天买家未确认则系统自动确认并结算给商户
const AUTO_CONFIRM_DAYS = 15;

const fmtA = units => { try { return formatUnits(BigInt(units || '0'), A_TOKEN_DECIMALS); } catch { return '0'; } };
const newId = prefix => `${prefix}_${Date.now().toString(36)}_${randomUUID().slice(0, 12)}`;

function isBannedWallet(walletService, address) {
  try { return Boolean(walletService?.isAccountBlocked?.(address)); } catch { return false; }
}

export function createMallApi({ aTokenService, database, walletService = null, send, readBody, getSession, withAccountLock = (addr, op) => op() }) {
  const db = database;

  function apiError(message, code = 'MALL_ERROR', statusCode = 400) {
    return Object.assign(new Error(message), { code, statusCode });
  }
  function requireSession(request) {
    const session = getSession(request);
    if (!session) throw apiError('请先登录钱包', 'SESSION_REQUIRED', 401);
    if (isBannedWallet(walletService, session.address)) throw apiError('账户操作不可用', 'ACCOUNT_ACTION_DISABLED', 403);
    return session;
  }
  function sendError(res, error) {
    send(res, Number(error?.statusCode) || 400, { error: error?.message || String(error), code: error?.code || 'MALL_ERROR' });
  }
  // 钱包地址脱敏（商户端看买家、用户端看商户时展示用）
  function maskWallet(address) {
    const s = String(address || '');
    return s.length > 12 ? `${s.slice(0, 6)}…${s.slice(-4)}` : s;
  }
  function parsePriceA(text) {
    if (!/^\d+(\.\d{1,6})?$/.test(String(text || '').trim())) throw apiError('价格需为不超过 6 位小数的正数');
    const priceA = String(text).trim();
    if (parseUnits(priceA, A_TOKEN_DECIMALS) <= 0n) throw apiError('价格必须大于 0');
    if (parseUnits(priceA, A_TOKEN_DECIMALS) > parseUnits(MAX_PRICE_A, A_TOKEN_DECIMALS)) throw apiError(`价格最高 ${MAX_PRICE_A} AIX`);
    return priceA;
  }

  // ── 展示层 ──
  function shopNameOf(merchantWallet) {
    return db.getMallMerchant(merchantWallet)?.shopName || maskWallet(merchantWallet);
  }
  function presentProduct(product, stats = null) {
    if (!product) return null;
    const rating = stats?.[product.id] || null;
    return { ...product, priceA: fmtA(product.priceUnits), shopName: shopNameOf(product.merchantWallet), merchantMask: maskWallet(product.merchantWallet),
      reviewCount: rating?.count || 0, ratingAvg: rating?.avg || 0 };
  }
  function presentProducts(products) {
    let stats = null;
    try { stats = db.listMallReviewStats(); } catch { stats = null; }
    return products.map(p => presentProduct(p, stats));
  }
  function presentOrder(order, { viewer } = {}, reviewedIds = null) {
    if (!order) return null;
    return { ...order, priceA: fmtA(order.priceUnits), totalA: fmtA(order.totalUnits),
      shopName: shopNameOf(order.merchantWallet),
      buyerMask: maskWallet(order.buyerWallet),
      reviewed: reviewedIds ? reviewedIds.has(order.id) : Boolean(db.getMallReviewByOrder(order.id)),
      counterparty: viewer === 'merchant' ? maskWallet(order.buyerWallet) : shopNameOf(order.merchantWallet) };
  }
  function validateImages(body) {
    const raw = Array.isArray(body?.images) ? body.images : (body?.imageUrl ? [body.imageUrl] : []);
    const images = raw.map(u => String(u ?? '').trim()).filter(Boolean);
    if (images.length > MAX_IMAGES) throw apiError(`商品图片最多 ${MAX_IMAGES} 张`);
    for (const url of images) {
      if (!/^https?:\/\/\S+$/i.test(url)) throw apiError('图片链接需为 http(s) 地址');
      if (url.length > 500) throw apiError('图片链接过长');
    }
    return images;
  }

  // ── 用户端：地址 ──
  function validateAddressFields(body) {
    const receiver = String(body?.receiver ?? '').trim();
    const phone = String(body?.phone ?? '').trim();
    const region = String(body?.region ?? '').trim();
    const detail = String(body?.detail ?? '').trim();
    if (!receiver || receiver.length > 30) throw apiError('收货人需为 1–30 个字符');
    if (!/^[\d+\-() ]{5,20}$/.test(phone)) throw apiError('联系电话格式不正确');
    if (!region || region.length > 60) throw apiError('所在地区需为 1–60 个字符');
    if (!detail || detail.length > 200) throw apiError('详细地址需为 1–200 个字符');
    return { receiver, phone, region, detail };
  }

  async function saveAddress(wallet, body) {
    const fields = validateAddressFields(body);
    const isDefault = Boolean(body?.isDefault);
    // 每人最多 10 个地址，防滥用
    if (db.listMallAddresses(wallet).length >= 10 && !body?.id) throw apiError('最多保存 10 个收货地址');
    let address = db.insertMallAddress({ id: newId('mma'), wallet, ...fields, isDefault });
    // 首个地址自动设为默认（此前无任何默认地址时）
    if (!isDefault && !db.listMallAddresses(wallet).some(a => a.isDefault)) {
      db.setMallDefaultAddress(address.id, wallet);
      address = db.getMallAddress(address.id);
    }
    return { address };
  }

  // ── 用户端：下单（买家账户锁内：扣款→扣库存→担保账户冻结→落单，失败回滚）──
  async function placeOrder(wallet, body) {
    const productId = String(body?.productId ?? '').trim();
    const quantity = Number(body?.quantity);
    const addressId = String(body?.addressId ?? '').trim();
    if (!productId) throw apiError('请选择商品');
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QTY) throw apiError(`购买数量需为 1–${MAX_QTY}`);
    const address = db.getMallAddress(addressId);
    if (!address || String(address.wallet).toLowerCase() !== String(wallet).toLowerCase()) throw apiError('请选择自己的收货地址');
    // 钱包签名确认：下单付款必须由买家本人钱包 personal_sign 授权（签名绑定商品+数量+时间戳防重放）
    try {
      walletService?.verifyOperationSignature({
        address: wallet,
        message: `AxiX 商城下单确认：商品 ${productId}，数量 ${quantity} 件，时间：${String(body?.timestamp ?? '')}`,
        signature: String(body?.signature ?? ''),
      });
    } catch (e) { throw apiError(e.message || '钱包签名验证失败', 'SIGNATURE_INVALID', 401); }
    return withAccountLock(wallet, () => {
      const product = db.getMallProduct(productId);
      if (!product || product.status !== 'active') throw apiError('商品已下架或不存在');
      if (String(product.merchantWallet).toLowerCase() === String(wallet).toLowerCase()) throw apiError('不能购买自己上架的商品');
      const merchant = db.getMallMerchant(product.merchantWallet);
      if (!merchant || merchant.status !== 'active') throw apiError('商户店铺不可用');
      if (product.stock < quantity) throw apiError('商品库存不足');
      const totalUnits = BigInt(product.priceUnits) * BigInt(quantity);
      const orderId = newId('mo');
      // 先扣押款（余额不足直接失败），货款进入平台担保账户冻结，确认收货后才结算给商户
      aTokenService.debitA(wallet, totalUnits);
      try {
        if (!db.consumeMallStock(productId, quantity)) throw apiError('商品库存不足');
        try {
          aTokenService.creditA(ESCROW_WALLET, totalUnits);
        } catch (e) {
          db.restoreMallStock(productId, quantity);
          throw apiError(`货款担保失败，已退款：${e?.message || e}`);
        }
        const order = db.insertMallOrder({
          id: orderId, buyerWallet: wallet, merchantWallet: product.merchantWallet,
          productId, productTitle: product.title, quantity, priceUnits: product.priceUnits,
          totalUnits: totalUnits.toString(), address: {
            receiver: address.receiver, phone: address.phone, region: address.region, detail: address.detail,
          }, status: 'paid', createdAt: Date.now(),
        });
        db.insertMallOrderEvent({ id: newId('moe'), orderId, actor: 'buyer', type: 'created',
          note: `下单 ${quantity} 件，付款 ${fmtA(totalUnits)} AIX（平台担保中）`, createdAt: Date.now() });
        return { order: presentOrder(order), balanceA: fmtA(aTokenService.balanceA(wallet)) };
      } catch (error) {
        // 结算链路失败：已扣押款原路退还（库存若已扣由各分支自行回补）
        try { aTokenService.creditA(wallet, totalUnits); } catch (e) { console.error(`[AIX商城] ${wallet} 下单失败且退款失败，需人工处理:`, e?.message || e); }
        throw error;
      }
    });
  }

  // ── 用户端：确认收货（担保账户 → 商户结算 + 释放商户可卖额度）──
  // 已发货订单结算：担保账户 → 商户（同时释放可卖额度）。买家确认与超时自动确认共用。
  // 资金链全程同步执行（无 await），任一失败资金原路退回担保账户，订单保持已发货。
  function settleShippedOrder(order, actor) {
    const totalUnits = BigInt(order.totalUnits);
    aTokenService.debitA(ESCROW_WALLET, totalUnits);
    try {
      aTokenService.creditA(order.merchantWallet, totalUnits);
    } catch (e) {
      try { aTokenService.creditA(ESCROW_WALLET, totalUnits); } catch (e2) { console.error(`[AIX商城] ${order.id} 结算回滚担保资金失败，需人工处理:`, e2?.message || e2); }
      throw apiError(`商户结算失败，请稍后重试：${e?.message || e}`);
    }
    try { db.addATokenSellQuota(order.merchantWallet, totalUnits); }
    catch (e) { console.error(`[AIX商城] ${order.merchantWallet} 货款额度释放失败（金额已到账，需人工补发）:`, e?.message || e); }
    const updated = db.completeMallOrder(order.id);
    if (!updated) {
      try { aTokenService.debitA(order.merchantWallet, totalUnits); aTokenService.creditA(ESCROW_WALLET, totalUnits); }
      catch (e) { console.error(`[AIX商城] ${order.id} 状态变更失败且资金回滚失败，需人工处理:`, e?.message || e); }
      throw apiError('订单状态已变化，请刷新');
    }
    db.insertMallOrderEvent({ id: newId('moe'), orderId: order.id, actor, type: 'completed',
      note: `${actor === 'system' ? `发货满 ${AUTO_CONFIRM_DAYS} 天自动确认收货` : '买家确认收货'}，货款 ${fmtA(totalUnits)} AIX 已结算给商户`, createdAt: Date.now() });
    return updated;
  }

  async function confirmOrder(wallet, body) {
    const orderId = String(body?.orderId ?? '').trim();
    const order = db.getMallOrder(orderId);
    if (!order || String(order.buyerWallet).toLowerCase() !== String(wallet).toLowerCase()) throw apiError('订单不存在');
    if (order.status !== 'shipped') throw apiError('仅已发货的订单可确认收货');
    return withAccountLock(wallet, () => ({ order: presentOrder(settleShippedOrder(order, 'buyer')) }));
  }

  // 超时自动确认收货（服务定时任务调用）：发货满 AUTO_CONFIRM_DAYS 天买家未操作则自动结算给商户
  async function autoConfirmStaleOrders() {
    const cutoff = Date.now() - AUTO_CONFIRM_DAYS * 86400000;
    let done = 0;
    for (const stale of db.listMallShippedBefore(cutoff, 200)) {
      try {
        await withAccountLock(stale.buyerWallet, () => { // withAccountLock 返回 Promise，必须 await 才算完成
          const order = db.getMallOrder(stale.id); // 锁内复查状态，避免与手动确认并发重复结算
          if (order?.status !== 'shipped') return;
          settleShippedOrder(order, 'system');
          done += 1;
          console.log(`[AIX商城] 订单 ${stale.id} 超时自动确认收货，货款已结算给商户`);
        });
      } catch (e) { console.error(`[AIX商城] 订单 ${stale.id} 自动确认失败（下轮重试）:`, e?.message || e); }
    }
    return done;
  }

  // ── 用户端：取消订单（仅 paid：担保账户原路全额退款买家 → 回补库存）──
  async function cancelOrder(wallet, body) {
    const orderId = String(body?.orderId ?? '').trim();
    return withAccountLock(wallet, () => {
      const order = db.getMallOrder(orderId);
      if (!order || String(order.buyerWallet).toLowerCase() !== String(wallet).toLowerCase()) throw apiError('订单不存在');
      if (order.status !== 'paid') throw apiError('仅待发货的订单可取消');
      const refundUnits = BigInt(order.totalUnits);
      // 货款仍在担保账户（未结算给商户）：担保账户扣出 → 退款买家 → 改状态 → 回补库存；
      // 资金链全程同步执行（无 await），中途异常则担保资金退回担保账户。
      aTokenService.debitA(ESCROW_WALLET, refundUnits);
      try {
        aTokenService.creditA(wallet, refundUnits);
        const updated = db.cancelMallOrder(orderId);
        if (!updated) throw apiError('订单状态已变化，请刷新');
        db.restoreMallStock(order.productId, order.quantity);
        db.insertMallOrderEvent({ id: newId('moe'), orderId, actor: 'buyer', type: 'cancelled',
          note: `买家取消，担保货款 ${fmtA(refundUnits)} AIX 已退回`, createdAt: Date.now() });
        return { order: presentOrder(updated), refundA: fmtA(refundUnits), balanceA: fmtA(aTokenService.balanceA(wallet)) };
      } catch (error) {
        try { aTokenService.creditA(ESCROW_WALLET, refundUnits); } catch (e) { console.error(`[AIX商城] ${orderId} 取消回滚担保资金失败，需人工处理:`, e?.message || e); }
        console.error(`[AIX商城] ${wallet} 取消 ${orderId} 异常（已回滚）:`, error?.message || error);
        throw error instanceof Error && error.code === 'MALL_ERROR' ? error : apiError('取消出现异常，请稍后重试');
      }
    });
  }

  // ── 用户端：买家评论（completed 订单，每单一条）──
  async function reviewOrder(wallet, body) {
    const orderId = String(body?.orderId ?? '').trim();
    const rating = Number(body?.rating);
    const content = String(body?.content ?? '').trim();
    const order = db.getMallOrder(orderId);
    if (!order || String(order.buyerWallet).toLowerCase() !== String(wallet).toLowerCase()) throw apiError('订单不存在');
    if (order.status !== 'completed') throw apiError('确认收货后才能评价');
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) throw apiError('评分需为 1–5 星');
    if (content.length > 300) throw apiError('评论不超过 300 个字符');
    if (db.getMallReviewByOrder(orderId)) throw apiError('该订单已评价过');
    const review = db.insertMallReview({
      id: newId('mrv'), orderId, productId: order.productId,
      buyerWallet: wallet, merchantWallet: order.merchantWallet,
      rating, content, createdAt: Date.now(),
    });
    db.insertMallOrderEvent({ id: newId('moe'), orderId, actor: 'buyer', type: 'reviewed',
      note: `买家评价 ${rating} 星`, createdAt: Date.now() });
    return { review: { ...review, buyerMask: maskWallet(wallet) } };
  }

  // ── 商户端 ──
  function requireMerchant(wallet) {
    const merchant = db.getMallMerchant(wallet);
    if (!merchant) throw apiError('请先申请开店', 'MERCHANT_REQUIRED', 403);
    if (merchant.status === 'pending') throw apiError('入驻申请审核中，通过后即可操作', 'MERCHANT_PENDING', 403);
    if (merchant.status === 'closing') throw apiError('关店申请审核中，暂不能操作', 'MERCHANT_CLOSING', 403);
    if (merchant.status !== 'active') throw apiError('店铺状态不可用', 'MERCHANT_DISABLED', 403);
    return merchant;
  }

  async function applyMerchant(wallet, body) {
    const shopName = String(body?.shopName ?? '').trim();
    const intro = String(body?.intro ?? '').trim();
    if (shopName.length < 1 || shopName.length > 40) throw apiError('店铺名称需为 1–40 个字符');
    if (intro.length > 200) throw apiError('店铺简介不超过 200 个字符');
    const existing = db.getMallMerchant(wallet);
    // 已开店：仅更新店铺资料，不重复收保证金
    if (existing && existing.status === 'active') return { merchant: db.upsertMallMerchant({ ...existing, wallet, shopName, intro, status: 'active' }) };
    // 入驻/关店审核中：仅允许更新店铺资料，不重复收保证金
    if (existing && (existing.status === 'pending' || existing.status === 'closing')) return { merchant: db.upsertMallMerchant({ ...existing, wallet, shopName, intro, status: existing.status }), pending: true };
    // 首次申请或曾被拒（保证金已退，需重新缴纳）：缴纳保证金 + 钱包签名 → 进入待审核
    const currency = String(body?.depositCurrency ?? '').trim().toUpperCase();
    if (!['USDT', 'AIX'].includes(currency)) throw apiError('请选择保证金支付方式（USDT 或 AIX）');
    const deposit = { currency, amount: currency === 'USDT' ? DEPOSIT_USDT : DEPOSIT_AIX, paidAt: Date.now() };
    // 钱包签名确认：开店保证金必须由本人钱包 personal_sign 授权（签名含时间戳防重放）
    try {
      walletService?.verifyOperationSignature({
        address: wallet,
        message: `AxiX 商城开店保证金：缴纳 ${deposit.amount} ${currency}，店铺「${shopName}」，时间：${String(body?.timestamp ?? '')}`,
        signature: String(body?.signature ?? ''),
      });
    } catch (e) { throw apiError(e.message || '钱包签名验证失败', 'SIGNATURE_INVALID', 401); }
    if (currency === 'USDT') {
      try { walletService.debitBalance(wallet, 'USDT', parseUnits(DEPOSIT_USDT, 6).toString()); }
      catch (e) { throw apiError(`USDT 余额不足，开店保证金需 ${DEPOSIT_USDT} USDT`); }
    } else {
      try { aTokenService.debitA(wallet, parseUnits(DEPOSIT_AIX, A_TOKEN_DECIMALS).toString()); }
      catch (e) { throw apiError(`AIX 余额不足，开店保证金需 ${DEPOSIT_AIX} AIX`); }
    }
    try {
      const merchant = db.upsertMallMerchant({ wallet, shopName, intro, status: 'pending', deposit });
      return { merchant, deposit, pending: true };
    } catch (error) {
      // 申请落库失败：保证金原路退回
      try {
        if (currency === 'USDT') walletService.creditBalance(wallet, 'USDT', parseUnits(DEPOSIT_USDT, 6).toString());
        else aTokenService.creditA(wallet, parseUnits(DEPOSIT_AIX, A_TOKEN_DECIMALS).toString());
      } catch (e) { console.error(`[AIX商城] ${wallet} 开店申请失败且保证金退款失败，需人工处理:`, e?.message || e); }
      throw error;
    }
  }

  // 申请关店退保证金：需先下架全部商品且无进行中订单（paid/shipped）；平台审核通过后保证金原路退回
  function closeShopApply(wallet) {
    requireMerchant(wallet);
    const selling = db.listMallProductsByMerchant(wallet, PRODUCT_LIMIT).filter(p => p.status === 'active');
    if (selling.length) throw apiError(`请先下架全部商品（还有 ${selling.length} 件在售）`);
    const ongoing = db.listMallOrdersByMerchant(wallet, 300).filter(o => ['paid', 'shipped'].includes(o.status));
    if (ongoing.length) throw apiError(`还有 ${ongoing.length} 笔进行中的订单，请完成后再申请关店`);
    db.setMallMerchantStatus(wallet, 'closing', { closeApplyAt: Date.now() });
    return { merchant: db.getMallMerchant(wallet) };
  }

  async function createProduct(wallet, body) {
    requireMerchant(wallet);
    const title = String(body?.title ?? '').trim();
    const description = String(body?.description ?? '').trim();
    const summary = String(body?.summary ?? '').trim();
    const spec = String(body?.spec ?? '').trim();
    const stock = Number(body?.stock);
    if (!title || title.length > 60) throw apiError('商品标题需为 1–60 个字符');
    if (summary.length > 200) throw apiError('商品简介不超过 200 个字符');
    if (spec.length > 120) throw apiError('规格尺寸不超过 120 个字符');
    if (description.length > 1000) throw apiError('商品描述不超过 1000 个字符');
    if (!Number.isInteger(stock) || stock < 1 || stock > 999999) throw apiError('库存需为 1–999999 的整数');
    const images = validateImages(body);
    const priceA = parsePriceA(body?.priceA);
    const product = db.insertMallProduct({
      id: newId('mmp'), merchantWallet: wallet, title, description, summary, spec, images,
      priceUnits: parseUnits(priceA, A_TOKEN_DECIMALS).toString(), stock, imageUrl: images[0] || '',
      status: 'active', createdAt: Date.now(),
    });
    return { product: presentProduct(product) };
  }

  async function updateProduct(wallet, body) {
    requireMerchant(wallet);
    const id = String(body?.id ?? '').trim();
    if (!id) throw apiError('缺少商品 ID');
    const fields = {};
    if (body?.title !== undefined) {
      const title = String(body.title).trim();
      if (!title || title.length > 60) throw apiError('商品标题需为 1–60 个字符');
      fields.title = title;
    }
    if (body?.description !== undefined) {
      const description = String(body.description).trim();
      if (description.length > 1000) throw apiError('商品描述不超过 1000 个字符');
      fields.description = description;
    }
    if (body?.summary !== undefined) {
      const summary = String(body.summary).trim();
      if (summary.length > 200) throw apiError('商品简介不超过 200 个字符');
      fields.summary = summary;
    }
    if (body?.spec !== undefined) {
      const spec = String(body.spec).trim();
      if (spec.length > 120) throw apiError('规格尺寸不超过 120 个字符');
      fields.spec = spec;
    }
    if (body?.priceA !== undefined) {
      const priceA = parsePriceA(body.priceA);
      fields.priceUnits = parseUnits(priceA, A_TOKEN_DECIMALS).toString();
    }
    if (body?.stock !== undefined) {
      const stock = Number(body.stock);
      if (!Number.isInteger(stock) || stock < 0 || stock > 999999) throw apiError('库存需为 0–999999 的整数');
      fields.stock = stock;
    }
    if (body?.images !== undefined || body?.imageUrl !== undefined) {
      const images = validateImages(body);
      fields.images = images;
      fields.imageUrl = images[0] || '';
    }
    if (body?.status !== undefined) {
      const status = String(body.status);
      if (!['active', 'off'].includes(status)) throw apiError('状态仅支持上架 / 下架');
      fields.status = status;
    }
    const product = db.updateMallProduct(wallet, { id, ...fields });
    if (!product) throw apiError('商品不存在或不属于你的店铺');
    return { product: presentProduct(product) };
  }

  async function shipOrder(wallet, body) {
    requireMerchant(wallet);
    const orderId = String(body?.orderId ?? '').trim();
    const company = String(body?.company ?? '').trim();
    const tracking = String(body?.tracking ?? '').trim();
    if (!orderId) throw apiError('缺少订单 ID');
    if (!company || company.length > 40) throw apiError('物流公司需为 1–40 个字符');
    if (!tracking || tracking.length > 64) throw apiError('物流单号需为 1–64 个字符');
    const order = db.getMallOrder(orderId);
    if (!order || String(order.merchantWallet).toLowerCase() !== String(wallet).toLowerCase()) throw apiError('订单不存在');
    if (order.status !== 'paid') throw apiError('仅待发货订单可发货');
    const updated = db.shipMallOrder(orderId, company, tracking);
    if (!updated) throw apiError('订单状态已变化，请刷新');
    db.insertMallOrderEvent({ id: newId('moe'), orderId, actor: 'merchant', type: 'shipped',
      note: `已发货 · ${company} · 单号 ${tracking}`, createdAt: Date.now() });
    return { order: presentOrder(updated, { viewer: 'merchant' }) };
  }

  // ── 路由 ──
  async function handle(request, res, pathname) {
    if (!pathname.startsWith('/api/mall/')) return false;
    const isGet = request.method === 'GET';
    try {
      // 用户端
      if (isGet && pathname === '/api/mall/state') {
        const session = getSession(request);
        const wallet = session?.address;
        const depositInfo = { usdt: DEPOSIT_USDT, aix: DEPOSIT_AIX, autoConfirmDays: AUTO_CONFIRM_DAYS };
        // 游客可逛商城：未登录只返回在售商品，个人数据（余额/地址/订单/商户）为空；
        // 下单、地址等写操作仍要求登录（requireSession）。
        if (!wallet) {
          return send(res, 200, {
            wallet: '', balanceA: null, depositInfo,
            products: presentProducts(db.listMallProducts(PRODUCT_LIMIT)),
            addresses: [], merchant: null, orders: [],
          });
        }
        if (isBannedWallet(walletService, wallet)) throw apiError('账户操作不可用', 'ACCOUNT_ACTION_DISABLED', 403);
        const reviewedIds = db.listMallReviewedOrderIds(wallet);
        return send(res, 200, {
          wallet, balanceA: fmtA(aTokenService.balanceA(wallet)), depositInfo,
          products: presentProducts(db.listMallProducts(PRODUCT_LIMIT)),
          addresses: db.listMallAddresses(wallet),
          merchant: db.getMallMerchant(wallet),
          orders: db.listMallOrdersByBuyer(wallet, ORDER_LIMIT).map(o => presentOrder(o, {}, reviewedIds)),
        });
      }
      // 商品评论（公开读取）
      if (isGet && pathname === '/api/mall/reviews') {
        const productId = String(new URL(request.url, 'http://x').searchParams.get('productId') || '').trim();
        if (!productId) throw apiError('缺少商品 ID');
        const reviews = db.listMallReviewsByProduct(productId, 100)
          .map(r => ({ id: r.id, rating: r.rating, content: r.content, buyerMask: maskWallet(r.buyerWallet), createdAt: r.createdAt }));
        return send(res, 200, { reviews });
      }
      if (pathname === '/api/mall/orders' && request.method === 'POST') {
        const session = requireSession(request);
        return send(res, 200, await placeOrder(session.address, await readBody(request)));
      }
      if (pathname === '/api/mall/orders/confirm' && request.method === 'POST') {
        const session = requireSession(request);
        return send(res, 200, await confirmOrder(session.address, await readBody(request)));
      }
      if (pathname === '/api/mall/orders/cancel' && request.method === 'POST') {
        const session = requireSession(request);
        return send(res, 200, await cancelOrder(session.address, await readBody(request)));
      }
      if (pathname === '/api/mall/orders/review' && request.method === 'POST') {
        const session = requireSession(request);
        return send(res, 200, await reviewOrder(session.address, await readBody(request)));
      }
      if (isGet && pathname === '/api/mall/addresses') {
        const session = requireSession(request);
        return send(res, 200, { addresses: db.listMallAddresses(session.address) });
      }
      if (pathname === '/api/mall/addresses' && request.method === 'POST') {
        const session = requireSession(request);
        return send(res, 200, await saveAddress(session.address, await readBody(request)));
      }
      if (pathname === '/api/mall/addresses/delete' && request.method === 'POST') {
        const session = requireSession(request);
        const body = await readBody(request);
        const ok = db.deleteMallAddress(String(body?.id ?? ''), session.address);
        if (!ok) throw apiError('地址不存在');
        return send(res, 200, { ok: true });
      }
      if (pathname === '/api/mall/addresses/default' && request.method === 'POST') {
        const session = requireSession(request);
        const body = await readBody(request);
        if (!db.setMallDefaultAddress(String(body?.id ?? ''), session.address)) throw apiError('地址不存在');
        return send(res, 200, { ok: true });
      }
      // 商户端
      if (isGet && pathname === '/api/mall/merchant/state') {
        const session = requireSession(request);
        const wallet = session.address;
        const merchant = db.getMallMerchant(wallet);
        if (!merchant) return send(res, 200, { merchant: null, products: [], orders: [], depositInfo: { usdt: DEPOSIT_USDT, aix: DEPOSIT_AIX, autoConfirmDays: AUTO_CONFIRM_DAYS } });
        return send(res, 200, {
          merchant,
          balanceA: fmtA(aTokenService.balanceA(wallet)),
          products: presentProducts(db.listMallProductsByMerchant(wallet, PRODUCT_LIMIT)),
          orders: db.listMallOrdersByMerchant(wallet, 300).map(o => presentOrder(o, { viewer: 'merchant' })),
        });
      }
      if (pathname === '/api/mall/merchant/apply' && request.method === 'POST') {
        const session = requireSession(request);
        return send(res, 200, await applyMerchant(session.address, await readBody(request)));
      }
      if (pathname === '/api/mall/merchant/close-apply' && request.method === 'POST') {
        const session = requireSession(request);
        return send(res, 200, closeShopApply(session.address));
      }
      if (pathname === '/api/mall/merchant/products' && request.method === 'POST') {
        const session = requireSession(request);
        return send(res, 200, await createProduct(session.address, await readBody(request)));
      }
      if (pathname === '/api/mall/merchant/products/update' && request.method === 'POST') {
        const session = requireSession(request);
        return send(res, 200, await updateProduct(session.address, await readBody(request)));
      }
      if (pathname === '/api/mall/merchant/orders/ship' && request.method === 'POST') {
        const session = requireSession(request);
        return send(res, 200, await shipOrder(session.address, await readBody(request)));
      }
      return send(res, 404, { error: '接口不存在', code: 'NOT_FOUND' });
    } catch (error) {
      console.warn(`[AIX商城] ${pathname} 失败:`, error?.message || error);
      return sendError(res, error);
    }
  }

  // ── 平台后台审核 /api/admin/mall/*（由 server.js 在 admin 鉴权块内调用，无需重复鉴权）──
  async function handleAdmin(request, res, pathname) {
    if (!pathname.startsWith('/api/admin/mall/')) return false;
    try {
      if (pathname === '/api/admin/mall/merchants' && request.method === 'GET') {
        const status = new URL(request.url, 'http://localhost').searchParams.get('status') || '';
        const merchants = db.listMallMerchants(status).map(m => ({ ...m, walletMask: maskWallet(m.wallet) }));
        return send(res, 200, { merchants });
      }
      if (pathname === '/api/admin/mall/orders' && request.method === 'GET') {
        const q = new URL(request.url, 'http://localhost').searchParams;
        const status = q.get('status') || '';
        const limit = Math.min(Number(q.get('limit')) || 100, 500);
        // 订单总览 + 担保账户在冻资金（paid/shipped 货款合计），用于对账与纠纷处理
        const orders = status
          ? db.listMallOrdersByStatus(status, limit)
          : ['paid', 'shipped', 'completed', 'cancelled'].flatMap(s => db.listMallOrdersByStatus(s, limit))
              .sort((a, b) => Number(b.createdAt) - Number(a.createdAt)).slice(0, limit);
        let frozen = 0n;
        for (const s of ['paid', 'shipped']) for (const o of db.listMallOrdersByStatus(s, 1000)) frozen += BigInt(o.totalUnits);
        return send(res, 200, {
          escrowFrozenA: fmtA(frozen),
          orders: orders.map(o => ({ ...o, priceA: fmtA(o.priceUnits), totalA: fmtA(o.totalUnits),
            buyerMask: maskWallet(o.buyerWallet), merchantMask: maskWallet(o.merchantWallet), shopName: shopNameOf(o.merchantWallet) })),
        });
      }
      if (pathname === '/api/admin/mall/orders/auto-confirm-run' && request.method === 'POST') {
        // 手动触发一轮超时自动确认（平时由服务定时任务每 10 分钟执行）
        const done = await autoConfirmStaleOrders();
        return send(res, 200, { ok: true, completed: done });
      }
      if (pathname === '/api/admin/mall/merchants/approve' && request.method === 'POST') {
        const wallet = String((await readBody(request))?.wallet || '').toLowerCase();
        const merchant = db.getMallMerchant(wallet);
        if (!merchant) throw apiError('商户不存在');
        if (merchant.status !== 'pending') throw apiError('该商户不在待审核状态');
        db.setMallMerchantStatus(wallet, 'active');
        console.log(`[AIX商城] 商户审核通过 ${wallet} 「${merchant.shopName}」`);
        return send(res, 200, { ok: true, merchant: db.getMallMerchant(wallet) });
      }
      if (pathname === '/api/admin/mall/merchants/reject' && request.method === 'POST') {
        const wallet = String((await readBody(request))?.wallet || '').toLowerCase();
        const merchant = db.getMallMerchant(wallet);
        if (!merchant) throw apiError('商户不存在');
        if (merchant.status !== 'pending') throw apiError('该商户不在待审核状态');
        // 拒绝入驻：保证金原路退回申请人
        const dep = merchant.deposit;
        if (dep?.currency === 'USDT') walletService.creditBalance(wallet, 'USDT', parseUnits(String(dep.amount), 6).toString());
        else if (dep?.currency === 'AIX') aTokenService.creditA(wallet, parseUnits(String(dep.amount), A_TOKEN_DECIMALS).toString());
        db.setMallMerchantStatus(wallet, 'rejected', { deposit: { ...(dep || {}), refundedAt: Date.now() } });
        console.log(`[AIX商城] 商户审核拒绝 ${wallet} 「${merchant.shopName}」，保证金已退`);
        return send(res, 200, { ok: true, merchant: db.getMallMerchant(wallet) });
      }
      if (pathname === '/api/admin/mall/merchants/close-approve' && request.method === 'POST') {
        const wallet = String((await readBody(request))?.wallet || '').toLowerCase();
        const merchant = db.getMallMerchant(wallet);
        if (!merchant) throw apiError('商户不存在');
        if (merchant.status !== 'closing') throw apiError('该商户不在关店审核状态');
        // 关店通过：保证金原路退回商户平台余额
        const dep = merchant.deposit;
        if (dep?.currency === 'USDT') walletService.creditBalance(wallet, 'USDT', parseUnits(String(dep.amount), 6).toString());
        else if (dep?.currency === 'AIX') aTokenService.creditA(wallet, parseUnits(String(dep.amount), A_TOKEN_DECIMALS).toString());
        db.setMallMerchantStatus(wallet, 'closed', { deposit: { ...(dep || {}), refundedAt: Date.now() } });
        console.log(`[AIX商城] 关店审核通过 ${wallet} 「${merchant.shopName}」，保证金已退`);
        return send(res, 200, { ok: true, merchant: db.getMallMerchant(wallet) });
      }
      if (pathname === '/api/admin/mall/merchants/close-reject' && request.method === 'POST') {
        const wallet = String((await readBody(request))?.wallet || '').toLowerCase();
        const merchant = db.getMallMerchant(wallet);
        if (!merchant) throw apiError('商户不存在');
        if (merchant.status !== 'closing') throw apiError('该商户不在关店审核状态');
        db.setMallMerchantStatus(wallet, 'active');
        console.log(`[AIX商城] 关店申请驳回 ${wallet} 「${merchant.shopName}」，恢复正常经营`);
        return send(res, 200, { ok: true, merchant: db.getMallMerchant(wallet) });
      }
      return send(res, 404, { error: '接口不存在', code: 'NOT_FOUND' });
    } catch (error) {
      console.warn(`[AIX商城·后台] ${pathname} 失败:`, error?.message || error);
      return sendError(res, error);
    }
  }

  return { handle, handleAdmin, autoConfirmStaleOrders };
}
