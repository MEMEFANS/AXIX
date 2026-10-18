# On-chain verification of the user's BNB payment tx.
param([string]$TxHash = '0x5db568ccbad770040224ec7fffbfbcd25b991fa6233bdc10005545611d03296e')
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/_cred.ps1"

$ssh = New-SSHSession -ComputerName $IP -Credential $cred -AcceptKey -ConnectionTimeout 120
$sid = $ssh.SessionId

$nodeScript = @"
import { JsonRpcProvider, formatEther } from '/opt/wg-platform/node_modules/ethers/lib.esm/index.js';
import fs from 'node:fs';
// parse .env
const env = {};
for (const line of fs.readFileSync('/opt/wg-platform/.env', 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !line.trim().startsWith('#')) env[m[1]] = m[2];
}
const rpc = env.BSC_RPC_URL;
const collection = (env.A_TOKEN_COLLECTION_ADDRESS || '').toLowerCase();
console.log('RPC:', rpc.slice(0, 40) + '...');
console.log('COLLECTION ADDRESS:', collection);
const p = new JsonRpcProvider(rpc);
const txHash = '$TxHash';
const [tx, receipt, tip] = await Promise.all([
  p.getTransaction(txHash),
  p.getTransactionReceipt(txHash).catch(() => null),
  p.getBlockNumber(),
]);
if (!tx) { console.log('RESULT: TX_NOT_FOUND'); process.exit(0); }
const block = await p.getBlock(tx.blockNumber);
console.log(JSON.stringify({
  from: tx.from,
  to: tx.to,
  valueBNB: formatEther(tx.value),
  status: receipt ? receipt.status : 'no_receipt',
  blockNumber: tx.blockNumber,
  confirmations: tip - Number(tx.blockNumber),
  txTimeISO: block ? new Date(block.timestamp * 1000).toISOString() : null,
  txTimeBJ: block ? new Date(block.timestamp * 1000 + 8*3600*1000).toISOString().replace('Z','+08') : null,
  gasUsed: receipt ? receipt.gasUsed.toString() : null,
}, null, 2));
const from = String(tx.from || '').toLowerCase();
const to = String(tx.to || '').toLowerCase();
console.log('CHECK from == wallet 0x03e4...4f4 :', from === '0x03e4b9f93f300901191b0aeff7368021f3f254f4');
console.log('CHECK to == collection           :', to === collection);
console.log('CHECK value 0.002 or 0.05        :', formatEther(tx.value) === '0.002' || formatEther(tx.value) === '0.05');
// also confirm txHash never submitted in DB
const { DatabaseSync } = await import('node:sqlite');
const db = new DatabaseSync('/opt/wg-platform/wg-platform.sqlite', { readOnly: true });
const hit = db.prepare('SELECT payload_json FROM a_token_activations WHERE payload_json LIKE ? LIMIT 3').all('%' + txHash.toLowerCase() + '%');
console.log('DB activations containing this txHash:', hit.length);
for (const r of hit) console.log('  ', r.payload_json.slice(0, 300));
db.close();
"@

$encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($nodeScript))
$cmd = "echo `"$encoded`" | base64 -d > /tmp/chaincheck.mjs && cd /opt/wg-platform && node /tmp/chaincheck.mjs; rm -f /tmp/chaincheck.mjs"
$r = Invoke-SSHCommand -SessionId $sid -Command $cmd -TimeOut 90
Write-Output $r.Output
if ($r.Error) { Write-Output "STDERR: $($r.Error)" }
Remove-SSHSession -SessionId $sid | Out-Null
