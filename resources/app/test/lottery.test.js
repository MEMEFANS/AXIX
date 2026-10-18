import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeDatabase } from '../src/database.js';
import { createWalletService } from '../src/wallet-service.js';
import { createLotteryService, PRIZES } from '../src/lottery-service.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-lottery-test-'));
try {
  const walletService = createWalletService({ dataRoot: root, depositAddress: `0x${'d'.repeat(40)}`, networks: [] });
  const database = walletService.database;
  database.saveSetting('lottery_probabilities', JSON.stringify({ rtx5080: 40, none: 60 }));
  const lottery = createLotteryService({ database, walletService, clock: () => Date.parse('2026-09-14T00:00:00Z') });
  const ids = PRIZES.map(prize => prize.id);
  assert.deepEqual(ids, ['btc', 'eth', 'bnb', 'usdt', 'iphone_fold', 'iphone18', 'huawei_fold', 'huawei_pc', 'huawei_phone', 'aix', 'mystery', 'none']);
  assert.equal(PRIZES.find(prize => prize.id === 'aix').name, '空投');
  assert.equal(PRIZES.find(prize => prize.id === 'huawei_phone').name, '华为手机');
  assert.equal(lottery.getConfig().prizes.length, 12);
  assert.equal(lottery.getConfig().prizes.reduce((sum, prize) => sum + prize.probability, 0), 1);
  const wallet = `0x${'1'.repeat(40)}`;
  walletService.ensureUser(wallet);
  lottery.addPoints(wallet, 10, 'admin_topup');
  const win = lottery.draw(wallet);
  assert.ok(ids.includes(win.prizeId));
  assert.equal(lottery.getPoints(wallet), win.prizeType === 'points' ? win.amount : 0);
  assert.equal(lottery.listFlows(wallet).some(flow => flow.type === 'draw_consume'), true);
  console.log('lottery tests passed: exact prize catalog, stale probability reset, draw flow');
} finally {
  closeDatabase(root);
  fs.rmSync(root, { recursive: true, force: true });
}
