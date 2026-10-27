import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const taskRoot = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(taskRoot, '../../resources/app');
const checkLocal = process.argv.includes('--local');
const sourceRoot = checkLocal ? appRoot : path.join(taskRoot, 'candidate');
const require = createRequire(path.join(appRoot, 'package.json'));
const { Wallet } = require('ethers');
// Resolve installed dependencies beneath appRoot while leaving its real src untouched.
const sandbox = fs.mkdtempSync(path.join(appRoot, '.silent-block-check-'));
const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aix-silent-account-check-'));
const hash = token => crypto.createHash('sha256').update(token).digest('hex');
let closeDatabase;
let server;
const checks = [];

try {
  fs.copyFileSync(path.join(sourceRoot, 'src/wallet-service.js'), path.join(sandbox, 'wallet-service.js'));
  for (const name of ['database.js', 'atomic-ledger.js']) {
    fs.copyFileSync(path.join(appRoot, 'src', name), path.join(sandbox, name));
  }
  const { createWalletService } = await import(pathToFileURL(path.join(sandbox, 'wallet-service.js')));
  ({ closeDatabase } = await import(pathToFileURL(path.join(sandbox, 'database.js'))));
  let service = createWalletService({ dataRoot });
  const target = Wallet.createRandom(), normal = Wallet.createRandom(), ordinary = Wallet.createRandom();
  async function login(wallet) {
    const { message } = service.buildLoginChallenge(wallet.address);
    return service.handleLoginSignature({ message, signature:await wallet.signMessage(message) });
  }
  const oldTargetLogin = await login(target);
  const normalLogin = await login(normal);
  const ordinaryLogin = await login(ordinary);
  service.creditBalance(normal.address, 'USDT', 123_000_000n);
  const pending = service.buildLoginChallenge(target.address);
  const pendingSignature = await target.signMessage(pending.message);
  const expiresAt = Date.now() + 60_000;
  const blocks = { wallets:{
    [target.address.toLowerCase()]:{ silent:true, reason:'operator', revokedSessions:[] },
    [ordinary.address.toLowerCase()]:{ reason:'existing ordinary ban', revokedSessions:[{ tokenHash:hash('ordinary-tombstone'), expiresAt }] },
  } };
  service.database.saveSetting('wallet_account_blocks', JSON.stringify(blocks));
  closeDatabase(dataRoot);
  service = createWalletService({ dataRoot });
  assert.equal(service.isSilentSessionBlocked(oldTargetLogin.token), true);
  assert.equal(service.getSession(oldTargetLogin.token), null);
  assert.equal(service.isSilentAccountBlocked(target.address), true);
  assert.equal(service.isSilentAccountBlocked(target.address.toLowerCase()), true);
  assert.equal(service.isSilentSessionBlocked(normalLogin.token), false);
  assert.equal(service.getSession(normalLogin.token).address, normal.address);
  assert.equal(service.balanceUnits(normal.address), 123_000_000n);
  checks.push('live restricted session rejected; normal login and balance preserved');

  blocks.wallets[target.address.toLowerCase()].revokedSessions = [
    { tokenHash:hash(oldTargetLogin.token), expiresAt },
    { tokenHash:hash('expired-token'), expiresAt:Date.now() - 1 },
    { tokenHash:'not-a-session-hash', expiresAt },
    { tokenHash:hash('invalid-expiry'), expiresAt:'invalid' },
  ];
  service.database.saveSetting('wallet_account_blocks', JSON.stringify(blocks));
  service.database.db.prepare('DELETE FROM wallet_sessions WHERE address=? COLLATE NOCASE').run(target.address);
  closeDatabase(dataRoot);
  service = createWalletService({ dataRoot });
  assert.equal(service.database.db.prepare('SELECT COUNT(*) AS n FROM wallet_sessions WHERE address=? COLLATE NOCASE').get(target.address).n, 0);
  assert.equal(service.getSession(oldTargetLogin.token), null);
  assert.equal(service.isSilentSessionBlocked(oldTargetLogin.token), true);
  for (const token of ['', 'unknown-token', 'expired-token', 'invalid-expiry', 'ordinary-tombstone']) {
    assert.equal(service.isSilentSessionBlocked(token), false, token);
  }
  assert.equal(service.getSession(ordinaryLogin.token), null);
  assert.equal(service.isSilentSessionBlocked(ordinaryLogin.token), false);
  assert.throws(() => service.buildLoginChallenge(ordinary.address), /账户已被封禁/);
  assert.throws(() => service.buildLoginChallenge(target.address), { code:'ACCOUNT_ACTION_DISABLED' });
  assert.throws(() => service.handleLoginSignature({ message:pending.message, signature:pendingSignature }), { code:'ACCOUNT_ACTION_DISABLED' });
  assert.throws(() => service.ensureUser(target.address), { code:'ACCOUNT_ACTION_DISABLED' });
  const operationMessage = `操作确认，时间：${Date.now()}`;
  const targetOperationSignature = await target.signMessage(operationMessage);
  assert.throws(() => service.verifyOperationSignature({ address:target.address, message:operationMessage, signature:targetOperationSignature }), { code:'ACCOUNT_ACTION_DISABLED' });
  assert.equal(service.verifyOperationSignature({ address:normal.address, message:operationMessage, signature:await normal.signMessage(operationMessage) }), true);
  checks.push('persisted revoked-session tombstone survives restart and expires correctly');
  checks.push('new and already signed login challenges blocked; ordinary ban unchanged');

  const source = fs.readFileSync(path.join(sourceRoot, 'src/server.js'), 'utf8');
  function sourceFunction(name) {
    const start = source.indexOf(`function ${name}(`);
    assert.ok(start >= 0, name);
    const end = source.indexOf('\nfunction ', start + 1);
    assert.ok(end > start, name);
    return source.slice(start, end);
  }
  const handlerStart = source.indexOf("  const url = new URL(request.url, 'http://localhost');", source.indexOf('export const server = http.createServer'));
  const firstBusiness = source.indexOf("    if (p.startsWith('/api/wallet/admin/'))", handlerStart);
  const guardPrefix = source.slice(handlerStart, firstBusiness);
  assert.ok(guardPrefix.includes('walletService.isSilentSessionBlocked'));
  const loginStart = source.indexOf("    if (p === '/api/wallet/login-challenge'", firstBusiness);
  const loginEnd = source.indexOf("    if (p === '/api/wallet/logout'", loginStart);
  const loginRoutes = source.slice(loginStart, loginEnd);
  const cfg = { trustProxy:false };
  const downstream = [];
  function send(res, status, payload) {
    res.writeHead(status, { 'Content-Type':'application/json' });
    res.end(JSON.stringify(payload));
    return true;
  }
  async function readBody(request) {
    let body = '';
    for await (const chunk of request) body += chunk;
    return JSON.parse(body || '{}');
  }
  // Execute the candidate's exact HTTP security prefix, guard, helpers, and login branches.
  // Unrelated downstream handlers are replaced by a sentinel to prove blocked routes never reach them.
  const factory = new Function('walletService', 'send', 'readBody', 'cfg', 'downstream',
    sourceFunction('readCookie') + sourceFunction('isSameOrigin') + sourceFunction('setSessionCookie')
    + sourceFunction('sendIdleAccountResponse')
    + 'const adminPageKind = () => null;\n'
    + 'return async function(request, res) {\n' + guardPrefix + loginRoutes
    + "downstream.push({ path:p, method:request.method }); return send(res, 200, { downstream:true });\n"
    + '} catch (error) { return send(res, 500, { error:error.message }); }\n};');
  server = http.createServer(factory(service, send, readBody, cfg, downstream));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  async function request(route, { token, method='GET', body, crossSite=false } = {}) {
    return fetch(origin + route, { method, headers:{
      ...(token ? { Cookie:`wg_session=${encodeURIComponent(token)}` } : {}),
      ...(body ? { 'Content-Type':'application/json' } : {}),
      ...(crossSite ? { Origin:'https://example.invalid', 'Sec-Fetch-Site':'cross-site' } : {}),
    }, ...(body ? { body:JSON.stringify(body) } : {}) });
  }
  const blockedRoutes = [
    ['POST', '/api/wallet/withdrawals'], ['POST', '/api/wallet/deposits/submit'],
    ['POST', '/api/wallet/bridge/deposit-quote'], ['GET', '/api/wallet/session'],
    ['GET', '/api/wallet/profile'], ['POST', '/api/wallet/logout'],
    ['POST', '/api/a-token/activate'], ['POST', '/api/a-token/stake'],
    ['POST', '/api/a-token/unstake'], ['POST', '/api/a-token/transfer'],
    ['POST', '/api/a-token/withdraw'], ['POST', '/api/a-token/claim-signature'],
    ['POST', '/api/a-token/claim-confirm'], ['POST', '/api/a-token/claim-refund'],
    ['POST', '/api/a-token/orders'], ['DELETE', '/api/a-token/orders/existing'],
    ['GET', '/api/a-token/profile'], ['GET', '/api/a-token/pool'],
    ['POST', '/api/platform/order'], ['DELETE', '/api/platform/orders/existing'],
    ['POST', '/api/platform/stake'], ['POST', '/api/platform/unstake'],
    ['POST', '/api/internal-strategy/grid/start'], ['POST', '/api/ai-managed/start'],
    ['POST', '/api/referrals/bind'], ['POST', '/api/referrals/claim'],
    ['POST', '/api/support/messages'], ['POST', '/api/lottery/draw'],
    ['GET', '/api/airdrop/points'], ['GET', '/api/prices/stream'],
    ['GET', '/api/market/stream'], ['POST', '/api/wallet/login-challenge'],
    ['POST', '/api/wallet/login-sign'],
  ];
  for (const [method, route] of blockedRoutes) {
    const response = await request(route, { method, token:oldTargetLogin.token });
    assert.equal(response.status, 204, route);
    assert.equal(response.headers.get('x-axix-action'), 'idle', route);
    assert.equal(response.headers.get('cache-control'), 'no-store', route);
    assert.equal(await response.text(), '', route);
  }
  assert.equal(downstream.length, 0);
  checks.push(`${blockedRoutes.length} restricted HTTP routes return empty 204 idle before downstream handlers`);

  for (const route of ['/api/admin/session', '/api/wallet/admin/dashboard', '/api/operator/status']) {
    const response = await request(route, { token:oldTargetLogin.token });
    assert.equal(response.status, 200, route);
    assert.equal(response.headers.get('x-axix-action'), null, route);
    assert.equal((await response.json()).downstream, true);
  }
  const normalRequest = await request('/api/a-token/profile', { token:normalLogin.token });
  assert.equal(normalRequest.status, 200);
  assert.equal(normalRequest.headers.get('x-axix-action'), null);
  const crossSite = await request('/api/a-token/transfer', { method:'POST', token:oldTargetLogin.token, crossSite:true });
  assert.equal(crossSite.status, 403);
  assert.equal(crossSite.headers.get('x-axix-action'), null);
  checks.push('admin routes and normal wallet pass through; same-origin enforcement remains first');

  for (const [route, body] of [
    ['/api/wallet/login-challenge', { address:target.address }],
    ['/api/wallet/login-sign', { message:pending.message, signature:pendingSignature }],
  ]) {
    const response = await request(route, { method:'POST', body });
    assert.equal(response.status, 204, route);
    assert.equal(response.headers.get('x-axix-action'), 'idle', route);
    assert.equal(await response.text(), '', route);
    assert.equal(response.headers.get('set-cookie'), null);
  }
  const ordinaryChallenge = await request('/api/wallet/login-challenge', { method:'POST', body:{ address:ordinary.address } });
  assert.equal(ordinaryChallenge.status, 400);
  assert.match((await ordinaryChallenge.json()).error, /账户已被封禁/);
  const normalChallenge = await request('/api/wallet/login-challenge', { method:'POST', body:{ address:normal.address } });
  assert.equal(normalChallenge.status, 200);
  const { message } = await normalChallenge.json();
  const normalSigned = await request('/api/wallet/login-sign', { method:'POST', body:{ message, signature:await normal.signMessage(message) } });
  assert.equal(normalSigned.status, 200);
  assert.match(normalSigned.headers.get('set-cookie'), /^wg_session=/);
  assert.equal((await normalSigned.json()).address, normal.address);
  assert.equal(service.balanceUnits(normal.address), 123_000_000n);
  checks.push('HTTP login guards work without a cookie; normal signing and session cookie unaffected');

  for (const name of ['deleted-account.test.js', 'wallet-session.test.js']) {
    const regression = fs.readFileSync(path.join(appRoot, 'test', name), 'utf8')
      .replaceAll("'../src/wallet-service.js'", "'./wallet-service.js'")
      .replaceAll("'../src/database.js'", "'./database.js'");
    const regressionFile = path.join(sandbox, name);
    fs.writeFileSync(regressionFile, regression);
    await import(pathToFileURL(regressionFile));
  }
  checks.push('existing deleted-account and wallet-session regressions pass against candidate service');

  const report = { ok:true, target:checkLocal ? 'local' : 'candidate', checks, httpRestrictedRoutes:blockedRoutes.length, timestamp:new Date().toISOString() };
  fs.writeFileSync(path.join(taskRoot, checkLocal ? 'local-backend-check-results.json' : 'backend-check-results.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally {
  if (server) await new Promise(resolve => server.close(resolve));
  if (closeDatabase) closeDatabase(dataRoot);
  fs.rmSync(sandbox, { recursive:true, force:true });
  fs.rmSync(dataRoot, { recursive:true, force:true });
}
