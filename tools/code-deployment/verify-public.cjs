const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '../../resources/app');
const files = ['public/index.html', 'public/js/core.js', 'public/js/wallet.js', 'public/js/page-loader.js', 'public/js/earn.js', 'public/vendor/wallet/connector.js'];
const stamp = Date.now();
async function checkFile(file) {
  const url = 'https://axix.cc/' + (file === 'public/index.html' ? '' : file.slice('public/'.length)) + '?code-release=' + stamp;
  const response = await fetch(url, {signal:AbortSignal.timeout(20000), headers:{'Cache-Control':'no-cache'}});
  const body = Buffer.from(await response.arrayBuffer());
  const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
  const match = response.ok && hash(body) === hash(fs.readFileSync(path.join(root, file)));
  return {file, status:response.status, bytes:body.length, match};
}
async function checkApi(endpoint) {
  const response = await fetch('https://axix.cc' + endpoint + '?code-release=' + stamp, {signal:AbortSignal.timeout(20000)});
  const data = await response.json();
  const valid = response.ok && !data.error && (endpoint.endsWith('/plans') ? Array.isArray(data.activation) && data.activation.length > 0 : Object.keys(data).length > 0);
  return {endpoint, status:response.status, valid};
}
(async () => {
  const [assets, apis] = await Promise.all([
    Promise.all(files.map(checkFile)),
    Promise.all(['/api/wallet/config', '/api/a-token/plans'].map(checkApi)),
  ]);
  const verified = assets.every(row => row.match) && apis.every(row => row.valid);
  fs.writeFileSync(path.join(__dirname, 'public-verification.json'), JSON.stringify({checkedAt:new Date().toISOString(), verified, assets, apis}, null, 2));
  for (const row of assets) console.log(`${row.match ? 'PASS' : 'FAIL'} HTTP ${row.status} ${row.file}`);
  for (const row of apis) console.log(`${row.valid ? 'PASS' : 'FAIL'} HTTP ${row.status} ${row.endpoint}`);
  if (!verified) throw new Error('Public verification failed');
})().catch(error => {console.error(error.message); process.exitCode = 1;});
