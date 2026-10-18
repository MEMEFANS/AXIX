import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeDatabase, openDatabase } from '../src/database.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-database-test-'));
const address = '0x0000000000000000000000000000000000000001';
const walletState = {
  version:5,
  users:{ [address.toLowerCase()]:{ address, balances:{ USDT:'2500000' }, createdAt:'2026-01-01T00:00:00.000Z', updatedAt:'2026-01-01T00:00:00.000Z' } },
  sessions:{},
  deposits:[{ id:'dep_00000001', wallet:address, network:'bsc', txHash:`0x${'1'.repeat(64)}`, asset:'USDT', amountUnits:'2500000', status:'confirmed', createdAt:'2026-01-01T00:00:00.000Z' }],
  withdrawals:[{ id:'wd_00000001', wallet:address, address, requestId:'request_0001', network:'bsc', asset:'USDT', amountUnits:'500000', status:'pending_review', automaticApproved:false, createdAt:'2026-01-02T00:00:00.000Z' }],
  withdrawalAutomation:{ enabled:false, reviewThresholdUnits:'1000000000', dailyLimitUnits:'1000000000', updatedAt:'2026-01-01T00:00:00.000Z' },
};

try {
  const store = openDatabase(root);
  store.replaceWalletState(walletState);
  assert.equal(store.loadWalletState().users[address.toLowerCase()].balances.USDT, '2500000');

  const indexes = new Set(store.db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map(row => row.name));
  for (const required of [
    'deposits_network_tx_unique', 'deposits_wallet_created_idx',
    'withdrawals_wallet_request_unique', 'withdrawals_status_created_idx',
    'orders_wallet_status_created_idx', 'orders_match_idx', 'fills_wallet_created_idx',
    'ai_batches_wallet_status_idx', 'ai_batches_expiry_idx',
    'ai_rewards_wallet_created_idx', 'referral_links_referrer_idx',
    'referral_rewards_recipient_idx', 'referral_rewards_source_idx',
  ]) assert.ok(indexes.has(required), `missing index ${required}`);

  const queryPlan = store.db.prepare('EXPLAIN QUERY PLAN SELECT payload_json FROM withdrawals WHERE wallet=? ORDER BY created_at DESC LIMIT 50').all(address);
  assert.ok(queryPlan.some(row => String(row.detail).includes('withdrawals_wallet_created_idx')), 'wallet withdrawal query must use its index');

  assert.throws(() => store.db.prepare(`INSERT INTO deposits
    (id,wallet,network,tx_hash,asset,amount_units,status,created_at,payload_json)
    VALUES(?,?,?,?,?,?,?,?,?)`).run('dep_duplicate', address, 'bsc', `0x${'1'.repeat(64)}`, 'USDT', '1', 'pending', Date.now(), '{}'), /UNIQUE/);

  closeDatabase(root);
  const restarted = openDatabase(root);
  assert.equal(restarted.loadWalletState().withdrawals[0].requestId, 'request_0001');
  console.log('database tests passed');
} finally {
  closeDatabase(root);
  fs.rmSync(root, { recursive:true, force:true });
}
