import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic } from './atomic-ledger.js';

const DEFAULT_TOKENS = [
  ['BTC', 'Bitcoin', 2],
  ['ETH', 'Ethereum', 2],
  ['BNB', 'BNB', 2],
  ['SOL', 'Solana', 2],
  ['XRP', 'XRP', 4],
  ['DOGE', 'Dogecoin', 5],
].map(([symbol, name, priceDecimals]) => ({
  symbol, name, priceDecimals, spot:true, perp:true, enabled:true,
}));

// 美股代币（Binance Stock Tokens）：现货交易对为 {B}B+USDT（如 NVDABUSDT），
// 永续合约为 {B}USDT（如 NVDAUSDT）。category='stock' 用于前端分组展示。
const DEFAULT_STOCK_TOKENS = [
  ['NVDA', 'NVIDIA', 2],
  ['MU', 'Micron Technology', 2],
  ['SNDK', 'Sandisk', 2],
  ['AMD', 'AMD', 2],
].map(([symbol, name, priceDecimals]) => ({
  symbol, name, priceDecimals, spot:true, perp:true, enabled:true,
  category:'stock',
}));

const SYMBOL_PATTERN = /^[A-Z0-9]{2,12}$/;

// 币安 CDN 图标：股票代币基础资产带 B 后缀（NVDAB/MUB/SNDKB/AMDB…）
function tokenLogo(item) {
  return `https://bin.bnbstatic.com/static/assets/logos/${item.symbol}${item.category === 'stock' ? 'B' : ''}.png`;
}

function normalizeToken(input = {}, existing = null) {
  const symbol = String(input.symbol || existing?.symbol || '').trim().toUpperCase();
  if (!SYMBOL_PATTERN.test(symbol) || symbol === 'USDT') throw new Error('代币代码必须是 2 到 12 位大写字母或数字，且不能是 USDT');
  const name = String(input.name ?? existing?.name ?? symbol).trim().slice(0, 40) || symbol;
  const priceDecimals = Number(input.priceDecimals ?? existing?.priceDecimals ?? 4);
  if (!Number.isInteger(priceDecimals) || priceDecimals < 0 || priceDecimals > 8) throw new Error('价格小数位必须是 0 到 8 的整数');
  const spot = input.spot === undefined ? (existing?.spot ?? true) : Boolean(input.spot);
  const perp = input.perp === undefined ? (existing?.perp ?? true) : Boolean(input.perp);
  if (!spot && !perp) throw new Error('现货和合约至少启用一个');
  const category = String(input.category ?? existing?.category ?? 'crypto').trim().toLowerCase() === 'stock' ? 'stock' : 'crypto';
  return {
    symbol, name, priceDecimals, spot, perp, category,
    enabled:input.enabled === undefined ? (existing?.enabled ?? true) : Boolean(input.enabled),
    createdAt:existing?.createdAt || new Date().toISOString(),
    updatedAt:new Date().toISOString(),
  };
}

export function createMarketCatalog({ dataRoot = '.' } = {}) {
  const file = path.join(path.resolve(dataRoot), 'market-tokens.json');
  let tokens = [];
  // 被管理员手动删除的内置股票代码：重启迁移时不再自动补回
  let removedDefaults = [];
  if (fs.existsSync(file)) {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || !Array.isArray(parsed.tokens)) throw new Error('代币目录文件格式无效');
    tokens = parsed.tokens.map(item => normalizeToken(item));
    removedDefaults = Array.isArray(parsed.removedDefaults)
      ? parsed.removedDefaults.map(s => String(s || '').trim().toUpperCase()).filter(Boolean)
      : [];
    // 迁移：存量 market-tokens.json 自动补齐内置美股代币（不覆盖已有同名单、跳过已删除名单）
    let migrated = false;
    for (const def of DEFAULT_STOCK_TOKENS) {
      if (!tokens.some(t => t.symbol === def.symbol) && !removedDefaults.includes(def.symbol)) {
        tokens.push(normalizeToken({ ...def }));
        migrated = true;
      }
    }
    if (migrated) writeJsonAtomic(file, { version:1, tokens, removedDefaults });
  } else {
    tokens = [...DEFAULT_TOKENS, ...DEFAULT_STOCK_TOKENS].map(item => normalizeToken(item));
    writeJsonAtomic(file, { version:1, tokens, removedDefaults });
  }

  function save() {
    writeJsonAtomic(file, { version:1, tokens, removedDefaults });
  }

  function list({ includeDisabled = false, product = '' } = {}) {
    return tokens
      .filter(item => includeDisabled || item.enabled)
      .filter(item => !product || Boolean(item[product === 'spot' ? 'spot' : 'perp']))
      .map(item => ({ ...item, logo:tokenLogo(item) }));
  }

  function symbols(product = '') {
    return list({ product }).map(item => item.symbol);
  }

  function upsert(input) {
    const symbol = String(input?.symbol || '').trim().toUpperCase();
    const index = tokens.findIndex(item => item.symbol === symbol);
    const token = normalizeToken(input, index >= 0 ? tokens[index] : null);
    if (index >= 0) tokens[index] = token;
    else tokens.push(token);
    // 重新添加曾被删除的内置股票 → 移出删除名单
    if (removedDefaults.includes(symbol)) removedDefaults = removedDefaults.filter(s => s !== symbol);
    save();
    return { ...token, logo:tokenLogo(token) };
  }

  function setEnabled(symbolInput, enabled) {
    const symbol = String(symbolInput || '').trim().toUpperCase();
    const token = tokens.find(item => item.symbol === symbol);
    if (!token) throw new Error('代币不存在');
    token.enabled = Boolean(enabled);
    token.updatedAt = new Date().toISOString();
    save();
    return { ...token, logo:tokenLogo(token) };
  }

  function remove(symbolInput) {
    const symbol = String(symbolInput || '').trim().toUpperCase();
    const index = tokens.findIndex(item => item.symbol === symbol);
    if (index < 0) throw new Error('代币不存在');
    const [token] = tokens.splice(index, 1);
    // 内置股票被删后记录名单，防止重启迁移复活
    if (DEFAULT_STOCK_TOKENS.some(d => d.symbol === symbol) && !removedDefaults.includes(symbol)) {
      removedDefaults.push(symbol);
    }
    save();
    return { ...token };
  }

  function get(symbolInput) {
    const symbol = String(symbolInput || '').trim().toUpperCase();
    const token = tokens.find(item => item.symbol === symbol);
    return token ? { ...token } : null;
  }

  return { list, setEnabled, symbols, upsert, remove, get };
}

// 美股代币在币安的真实交易对：现货 = {B}B+USDT（NVDABUSDT），合约 = {B}USDT（NVDAUSDT）
export function toBinanceMarketSymbol(symbol, product = 'spot') {
  const base = String(symbol || '').trim().toUpperCase();
  if (!base) return '';
  if (base.endsWith('USDT')) return base;
  return product === 'spot' ? `${base}BUSDT` : `${base}USDT`;
}

export { DEFAULT_TOKENS, DEFAULT_STOCK_TOKENS };
