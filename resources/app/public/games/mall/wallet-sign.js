// AIX 商城 · 敏感操作钱包签名（personal_sign 纯文本，签名含时间戳防重放，后端 verifyOperationSignature 校验）
// 复用平台钱包连接器（/vendor/wallet/connector.js）：优先静默恢复已授权连接，未授权才拉起连接弹窗。
async function signMessage(address, message) {
  const connector = window.WGWalletConnector;
  if (!connector) throw new Error('钱包组件未加载，请刷新页面重试');
  let conn = connector.getConnection() || await connector.restore().catch(() => null);
  if (!conn || String(conn.address).toLowerCase() !== String(address).toLowerCase()) {
    conn = await connector.connect();
  }
  if (!conn) throw new Error('未检测到可用钱包，请先在钱包中授权连接');
  if (String(conn.address).toLowerCase() !== String(address).toLowerCase()) {
    throw new Error('当前连接钱包与登录账户不一致，请切换钱包账户后重试');
  }
  try {
    return await conn.provider.request({ method: 'personal_sign', params: [message, conn.address] });
  } catch (e) {
    if (Number(e?.code) === 4001 || /denied|rejected|cancel/i.test(e?.message || '')) throw new Error('已取消签名');
    throw e;
  }
}

// 开店保证金签名（首次开店缴纳保证金时）
export async function signDeposit({ address, shopName, currency, amount }) {
  const timestamp = String(Date.now());
  const message = `AxiX 商城开店保证金：缴纳 ${amount} ${currency}，店铺「${shopName}」，时间：${timestamp}`;
  return { signature: await signMessage(address, message), timestamp };
}

// 下单付款签名（买家支付 AIX 时；消息只含客户端可控字段，与后端拼接保持一致）
export async function signOrder({ address, productId, quantity }) {
  const timestamp = String(Date.now());
  const message = `AxiX 商城下单确认：商品 ${productId}，数量 ${quantity} 件，时间：${timestamp}`;
  return { signature: await signMessage(address, message), timestamp };
}
