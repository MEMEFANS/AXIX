(function () {
  const pendingOrders = new Map();

  function randomId() {
    return globalThis.crypto?.randomUUID?.() || `order_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  }

  async function request(path, options = {}) {
    const walletRevision = window.getWalletStateRevision?.();
    let response;
    try {
      response = await fetch(path, { credentials:'same-origin', ...options });
    } catch (cause) {
      throw Object.assign(new Error('无法连接平台服务，请检查本地服务是否运行'), { code:'NETWORK_ERROR', cause });
    }
    const data = await response.json().catch(() => ({}));
    window.handlePlatformUnauthorized?.(response, walletRevision);
    if (!response.ok) {
      throw Object.assign(new Error(data.error || `平台请求失败 (${response.status})`), {
        code:data.code || 'PLATFORM_ERROR',
        status:response.status,
      });
    }
    return data;
  }

  function orderFingerprint(payload) {
    return JSON.stringify({
      product:payload.product,
      symbol:payload.symbol,
      type:payload.type,
      side:payload.side,
      size:String(payload.size),
      leverage:Number(payload.leverage) || 1,
      marginMode:payload.marginMode === 'cross' ? 'cross' : 'isolated',
      limitPrice:String(payload.limitPrice || ''),
      triggerPrice:String(payload.triggerPrice || ''),
      triggerDirection:payload.triggerDirection === 'below' ? 'below' : 'above',
      reduceOnly:Boolean(payload.reduceOnly),
    });
  }

  async function placeOrder(payload) {
    const fingerprint = orderFingerprint(payload);
    const clientOrderId = pendingOrders.get(fingerprint) || randomId();
    pendingOrders.set(fingerprint, clientOrderId);
    try {
      const result = await request('/api/platform/order', {
        method:'POST',
        headers:{ 'Content-Type':'application/json', 'Idempotency-Key':clientOrderId },
        body:JSON.stringify(payload),
      });
      pendingOrders.delete(fingerprint);
      return result;
    } catch (error) {
      if (error.status) pendingOrders.delete(fingerprint);
      throw error;
    }
  }

  window.PlatformClient = {
    profile:(symbol = 'BTC') => request(`/api/platform/profile?symbol=${encodeURIComponent(symbol)}`),
    placeOrder,
    cancelOrder:orderId => request(`/api/platform/orders/${encodeURIComponent(orderId)}`, { method:'DELETE' }),
    staking:(action, amount) => request(`/api/platform/${action}`, {
      method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ amount }),
    }),
  };
})();
