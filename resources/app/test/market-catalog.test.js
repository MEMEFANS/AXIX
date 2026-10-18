import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMarketCatalog } from '../src/market-catalog.js';

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-market-catalog-test-'));
try {
  const catalog = createMarketCatalog({ dataRoot });
  assert.deepEqual(catalog.symbols(), ['BTC', 'ETH', 'BNB', 'SOL', 'XRP', 'DOGE', 'NVDA', 'MU', 'SNDK', 'AMD']);
  assert.deepEqual(catalog.list().filter(token => token.category === 'stock').map(token => token.symbol), ['NVDA', 'MU', 'SNDK', 'AMD']);
  const added = catalog.upsert({ symbol:'ada', name:'Cardano', priceDecimals:5, spot:true, perp:false });
  assert.equal(added.symbol, 'ADA');
  assert.equal(added.perp, false);
  assert.equal(catalog.symbols('spot').includes('ADA'), true);
  assert.equal(catalog.symbols('perp').includes('ADA'), false);
  catalog.setEnabled('ADA', false);
  assert.equal(catalog.symbols().includes('ADA'), false);
  assert.equal(catalog.list({ includeDisabled:true }).find(item => item.symbol === 'ADA').enabled, false);
  const restored = createMarketCatalog({ dataRoot });
  assert.equal(restored.list({ includeDisabled:true }).some(item => item.symbol === 'ADA'), true);
  assert.throws(() => restored.upsert({ symbol:'USDT', name:'Tether' }), /不能是 USDT/);
  console.log('market-catalog tests passed');
} finally {
  fs.rmSync(dataRoot, { recursive:true, force:true });
}
