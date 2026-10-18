import fs from 'node:fs';
import path from 'node:path';
import { DATA_ROOT } from './config.js';

const EXCHANGES = ['de', 'ex', 'rs'];

function signature(record) {
  return [record.orderId, record.t, record.side, record.price, record.size, record.level, record.kind,
    record.fee, record.grossPnl, record.realizedPnl].map((v) => v ?? '').join('|');
}

function numeric(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export class TradeLedger {
  constructor(root = path.join(DATA_ROOT, 'ledger')) {
    this.root = root;
    this.records = new Map(EXCHANGES.map((key) => [key, []]));
    this.signatures = new Map(EXCHANGES.map((key) => [key, new Set()]));
    fs.mkdirSync(root, { recursive: true });
    for (const key of EXCHANGES) this._load(key);
  }

  _file(key) { return path.join(this.root, `${key}.jsonl`); }

  _load(key) {
    const file = this._file(key);
    if (!fs.existsSync(file)) return;
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line);
        if (!record || !Number.isFinite(Number(record.t))) continue;
        const sig = signature(record);
        if (this.signatures.get(key).has(sig)) continue;
        this.signatures.get(key).add(sig);
        this.records.get(key).push(record);
      } catch { /* tolerate a partially-written final line after a hard crash */ }
    }
  }

  append(key, fill, context = {}) {
    if (!EXCHANGES.includes(key)) throw new Error(`Unsupported exchange: ${key}`);
    const record = {
      id: `${key}-${Number(fill.t) || Date.now()}-${this.records.get(key).length + 1}`,
      exchange: key,
      market: context.market || fill.market || null,
      mode: context.mode || fill.mode || null,
      source: context.source || fill.source || 'live',
      orderId: fill.orderId == null ? null : String(fill.orderId),
      t: Number(fill.t) || Date.now(),
      side: fill.side === 'sell' ? 'sell' : 'buy',
      price: numeric(fill.price), size: numeric(fill.size), level: numeric(fill.level),
      kind: fill.kind || (fill.closing ? 'close' : 'open'),
      closing: Boolean(fill.closing), recovery: Boolean(fill.recovery),
      fee: numeric(fill.fee), grossPnl: numeric(fill.grossPnl), realizedPnl: numeric(fill.realizedPnl),
    };
    const sig = signature(record);
    if (this.signatures.get(key).has(sig)) return null;
    fs.appendFileSync(this._file(key), `${JSON.stringify(record)}\n`, 'utf8');
    this.signatures.get(key).add(sig);
    this.records.get(key).push(record);
    return record;
  }

  importSnapshot(key, fills = [], context = {}) {
    let imported = 0;
    for (const fill of [...fills].sort((a, b) => Number(a.t) - Number(b.t))) {
      if (this.append(key, fill, { ...context, source: 'legacy-import' })) imported++;
    }
    return imported;
  }

  list({ exchange = 'all', offset = 0, limit = 100 } = {}) {
    const keys = exchange === 'all' ? EXCHANGES : EXCHANGES.includes(exchange) ? [exchange] : [];
    if (!keys.length) throw new Error('无效的交易所筛选');
    const all = keys.flatMap((key) => this.records.get(key)).sort((a, b) => b.t - a.t);
    const safeOffset = Math.max(0, Math.floor(Number(offset) || 0));
    const safeLimit = Math.min(1_000_000, Math.max(1, Math.floor(Number(limit) || 100)));
    return { items: all.slice(safeOffset, safeOffset + safeLimit), total: all.length, offset: safeOffset, limit: safeLimit };
  }

  summary(exchange = 'all') {
    const { items } = this.list({ exchange, limit: 1000_000 });
    const closing = items.filter((record) => record.closing || record.kind === 'close' || record.kind === 'recovery');
    const wins = closing.filter((record) => Number(record.realizedPnl) > 0).length;
    const losses = closing.filter((record) => Number(record.realizedPnl) < 0).length;
    const decided = wins + losses;
    return {
      records: items.length, completed: closing.length, wins, losses,
      winRate: decided ? wins / decided * 100 : null,
      realizedPnl: items.reduce((sum, record) => sum + (Number(record.realizedPnl) || 0), 0),
      fees: items.reduce((sum, record) => sum + (Number(record.fee) || 0), 0),
      volume: items.reduce((sum, record) => sum + (Number(record.price) || 0) * (Number(record.size) || 0), 0),
      legacyImported: items.filter((record) => record.source === 'legacy-import').length,
      firstAt: items.length ? Math.min(...items.map((record) => record.t)) : null,
      lastAt: items.length ? Math.max(...items.map((record) => record.t)) : null,
    };
  }
}

export function createTradeLedger(root) { return new TradeLedger(root); }
