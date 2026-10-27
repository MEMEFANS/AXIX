const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

(async () => {
  const sha = value => createHash('sha256').update(value).digest('hex');
  const version = '20261020-pro-rotation-1';
  const nonce = Date.now();
  const endpoints = ['/api/a-token/plans', '/admin.html', '/js/operator-admin.js'];
  const responses = process.argv.includes('--downloaded')
    ? ['public-plans.json', 'public-admin.html', 'public-operator-admin.js'].map(name => fs.readFileSync(path.join(__dirname, name)))
    : await Promise.all(endpoints.map(async endpoint => {
    const response = await fetch(`https://axix.cc${endpoint}?v=${version}&verify=${nonce}`, {
      signal: AbortSignal.timeout(20000), headers: { 'Cache-Control': 'no-cache' },
    });
    assert.equal(response.status, 200, endpoint);
    return Buffer.from(await response.arrayBuffer());
  }));
  const plans = JSON.parse(responses[0].toString('utf8'));
  assert.deepEqual(Object.fromEntries(plans.activation.map(item => [item.plan, item.bnb])), { '1': '0.002', '2': '0.05' });
  assert.equal(plans.collectionAddress.toLowerCase(), '0xa71e0cfb92643ccf1fadcd45fcfb29b7b39c56e6');
  assert.equal(plans.collectionAddressByPlan['1'].toLowerCase(), plans.collectionAddress.toLowerCase());
  assert.ok([plans.collectionAddress.toLowerCase(), '0x1266d38865460cf7d0c06985ac5587a5e85de2c0']
    .includes(plans.collectionAddressByPlan['2'].toLowerCase()));
  assert.ok(responses[1].toString('utf8').includes(`operator-admin.js?v=${version}`));
  assert.equal(sha(responses[2]), sha(fs.readFileSync(path.join(__dirname, 'candidate/public/js/operator-admin.js'))));
  const result = { ok: true, checkedAt: new Date().toISOString(), origin: 'https://axix.cc',
    bnbActivationPreserved: true, mainCollectionAddress: plans.collectionAddress,
    nextProCollectionAddress: plans.collectionAddressByPlan['2'], adminVersion: version,
    adminScriptMatchesCandidate: true };
  fs.writeFileSync(path.join(__dirname, 'public-verification.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result));
})().catch(error => { console.error(error); process.exitCode = 1; });
