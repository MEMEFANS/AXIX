import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createWalletService} from '../../resources/app/src/wallet-service.js';
import {closeDatabase} from '../../resources/app/src/database.js';
import {seedAdminSpeedFixture, USER_COUNT} from '../../resources/app/test/admin-speed-fixture.js';

const app = path.resolve(import.meta.dirname, '../../resources/app');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-admin-benchmark-'));
const baselineModule = path.join(app, 'src', '.admin-speed-baseline-' + process.pid + '.js');
try {
  seedAdminSpeedFixture(root);
  fs.copyFileSync(path.join(import.meta.dirname, 'before/src/wallet-service.js'), baselineModule);
  const previous = (await import(pathToFileURL(baselineModule).href)).createWalletService({dataRoot:root, networks:[]});
  const candidate = createWalletService({dataRoot:root, networks:[]});
  const measure = fn => {const start = performance.now(); const payload = fn(); return {milliseconds:Math.round((performance.now() - start) * 100) / 100, bytes:Buffer.byteLength(JSON.stringify(payload)), payload};};
  const old = measure(() => previous.adminDashboard());
  const overview = measure(() => candidate.adminDashboard({includeUsers:false}));
  const users = measure(() => candidate.adminDashboard({limit:50, offset:0}));
  assert.deepEqual(overview.payload.summary, old.payload.summary);
  assert.deepEqual(candidate.adminDashboard().users, old.payload.users);
  const result = {isolatedSyntheticData:true, userCount:USER_COUNT, baseline:{milliseconds:old.milliseconds, bytes:old.bytes}, overview:{milliseconds:overview.milliseconds, bytes:overview.bytes}, usersPage:{milliseconds:users.milliseconds, bytes:users.bytes, rows:users.payload.users.length}, summaryUnchanged:true};
  fs.writeFileSync(path.join(import.meta.dirname, 'backend-benchmark.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  closeDatabase(root);
  fs.rmSync(root, {recursive:true, force:true});
  fs.rmSync(baselineModule, {force:true});
}
