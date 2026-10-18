import { formatUnits } from 'ethers';
import { A_TOKEN_DECIMALS, USDT_DECIMALS } from './a-token-service.js';

// A 币池报价服务：仅供交易页市价单的费用/到账预估（只读，不执行交易）。
// 实际买卖一律走挂单撮合（order-service），历史 AMM 即时买卖已移除。
const BPS = 10000n;

export function createATokenPoolService({ aTokenService, sellFeeProfile = null }) {
  // 报价（不执行）：side='buy' 传入 USDT 数量；side='sell' 传入 A 数量
  // wallet 传入时，卖方手续费按该钱包的直推阶梯费率（与挂单撮合一致）
  function quote(side, inputAmount, wallet = '') {
    if (side !== 'buy' && side !== 'sell') throw new Error('交易方向无效');
    const price = aTokenService.getPriceUsdtUnits();
    const meta = aTokenService.getPoolMeta();
    let feeRateBps = BigInt(meta.feeRateBps || 0);
    let directCount = null;
    if (wallet && typeof sellFeeProfile === 'function') {
      try {
        const p = sellFeeProfile(wallet);
        if (p?.feeRateBps != null) {
          feeRateBps = BigInt(p.feeRateBps);
          directCount = p.directCount ?? null;
        }
      } catch { /* 阶梯费率获取失败时退回 meta 费率 */ }
    }
    const priceStr = formatUnits(price, USDT_DECIMALS);
    if (side === 'buy') {
      const usdt = aTokenService.parseUsdt(inputAmount, 'USDT 数量');
      const aReceive = aTokenService.usdtToA(usdt, price); // 买方无手续费
      return {
        side, priceUsdt: priceStr,
        usdtIn: formatUnits(usdt, USDT_DECIMALS),
        aOut: formatUnits(aReceive, A_TOKEN_DECIMALS),
        feeA: '0', burnA: '0', dividendA: '0',
      };
    }
    const a = aTokenService.parseA(inputAmount, 'A 币数量');
    const feeA = a * feeRateBps / BPS;
    const netA = a - feeA;
    const usdtOut = aTokenService.aToUsdt(netA, price);
    return {
      side, priceUsdt: priceStr,
      aIn: formatUnits(a, A_TOKEN_DECIMALS),
      aNet: formatUnits(netA, A_TOKEN_DECIMALS),
      usdtOut: formatUnits(usdtOut, USDT_DECIMALS),
      feeA: formatUnits(feeA, A_TOKEN_DECIMALS),
      feeRateBps: Number(feeRateBps),
      feePct: (Number(feeRateBps) / 100).toFixed(0) + '%',
      directCount,
    };
  }

  return { quote, stats: () => aTokenService.poolStats() };
}
