import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWalletService } from '../src/wallet-service.js';
import { closeDatabase } from '../src/database.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-admin-credit-test-'));
const wallet = '0x0000000000000000000000000000000000000025';

try {
  const service = createWalletService({ dataRoot:root, networks:[] });
  const payload = { wallet, amount:'125.50', reason:'后台测试资金', requestId:'test_credit_0001' };
  const first = service.adminCreditTestBalance(payload, 'admin');
  assert.equal(first.amount, '125.5');
  assert.equal(service.balanceUnits(wallet), 125_500000n);

  const repeated = service.adminCreditTestBalance(payload, 'admin');
  assert.equal(repeated.id, first.id);
  assert.equal(service.balanceUnits(wallet), 125_500000n, '重复请求不能重复入账');
  assert.throws(() => service.adminCreditTestBalance({ ...payload, amount:'126' }, 'admin'), /请求编号已用于/);

  const dashboard = service.adminDashboard();
  assert.equal(dashboard.summary.realUsers, 0, '后台测试入账不能计为真实链上充值用户');
  assert.equal(service.adminListBalanceAdjustments()[0].reason, '后台测试资金');

  closeDatabase(root);
  const restarted = createWalletService({ dataRoot:root, networks:[] });
  assert.equal(restarted.balanceUnits(wallet), 125_500000n);
  assert.equal(restarted.adminListBalanceAdjustments().length, 1);
  console.log('admin test credit tests passed');
} finally {
  closeDatabase(root);
  fs.rmSync(root, { recursive:true, force:true });
}
