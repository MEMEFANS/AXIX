import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWalletService } from '../src/wallet-service.js';
import { closeDatabase } from '../src/database.js';
import { USER_COUNT, fixtureWallet, seedAdminSpeedFixture } from './admin-speed-fixture.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-admin-speed-'));
try {
  seedAdminSpeedFixture(root);
  const service = createWalletService({dataRoot:root, networks:[]});
  const beforeState = service.database.loadWalletState();
  const full = service.adminDashboard();
  const overview = service.adminDashboard({includeUsers:false});
  assert.deepEqual(overview.summary, full.summary);
  assert.equal(Object.hasOwn(overview, 'users'), false);
  assert.equal(full.users.length, USER_COUNT);
  assert.equal(full.summary.realUsers, USER_COUNT - 2);
  assert.equal(full.users.filter(user => user.isRealUser).length, USER_COUNT - 1, 'AIX-only list semantics are preserved');
  assert.equal(full.summary.totalDepositedUsdt, '171.000171');
  assert.equal(full.summary.totalPlatformBalanceUsdt, '26089502.089476');
  assert.equal(full.summary.pendingDeposits, 1);
  assert.equal(full.summary.pendingWithdrawals, 1);
  assert.equal(full.summary.automaticWithdrawals, 1);
  const addresses = [];
  for (let offset = 0; offset < USER_COUNT; offset += 100) {
    const page = service.adminDashboard({limit:100, offset});
    assert.equal(page.usersTotal, USER_COUNT);
    assert.deepEqual(page.users, full.users.slice(offset, offset + 100));
    addresses.push(...page.users.map(user => user.address));
  }
  assert.equal(new Set(addresses).size, USER_COUNT, 'pagination must not omit or duplicate users');
  const query = fixtureWallet(42).slice(-5).toUpperCase();
  const matches = full.users.filter(user => user.address.toLowerCase().includes(query.toLowerCase()));
  const searched = service.adminDashboard({userQuery:query, limit:50});
  assert.deepEqual(searched.users, matches);
  assert.equal(searched.usersTotal, matches.length);
  const real = service.adminDashboard({realOnly:true, limit:50});
  assert.equal(real.usersTotal, USER_COUNT - 1);
  assert(real.users.every(user => user.isRealUser));
  assert.equal(service.adminDashboard({limit:999999}).users.length, 100);
  assert.equal(service.adminDashboard({limit:50, offset:'Infinity'}).usersOffset, 0);
  assert.equal(service.adminDashboard({limit:50, offset:-10}).usersOffset, 0);
  assert.equal(service.adminDashboard({limit:50, offset:99999}).users.length, 0);
  assert.equal(service.adminDashboard({limit:50, userQuery:'no-match'}).usersTotal, 0);
  assert.deepEqual(service.adminListDeposits('', {limit:8}), service.adminListDeposits().slice(0, 8));
  assert.deepEqual(service.adminListWithdrawals('', {limit:8}), service.adminListWithdrawals().slice(0, 8));
  assert.deepEqual(service.database.loadWalletState(), beforeState, 'reads must not modify balances or withdrawal automation');
  console.log('admin speed backend: summary, precision, pagination, filters, read-only behavior passed');
} finally {
  closeDatabase(root);
  fs.rmSync(root, {recursive:true, force:true});
}
