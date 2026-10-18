// Block scanner: find BNB payments to A-token collection addresses not recorded in-app.
// Usage: node scanpay.mjs <fromBlock> <toBlock> [rpcUrl]
const RPC = process.argv[4] || 'https://bsc-rpc.publicnode.com';
const FROM = parseInt(process.argv[2]);
const TO = parseInt(process.argv[3]);
const ADDRS = new Set([
  '0xa71e0cfb92643ccf1fadcd45fcfb29b7b39c56e6', // main collection
  '0xf9767c67a7f82f5b488f73b69e73017f635d333c', // rotation (disabled 2026-10-14)
]);
const VALS = new Set(['2000000000000000', '50000000000000000']); // 0.002 / 0.05 BNB
const CONC = 6;
const BATCH = 25;

let done = 0, hits = [], errors = 0;
const t0 = Date.now();

async function fetchBatch(start) {
  const reqs = [];
  for (let i = 0; i < BATCH; i++) {
    const n = start + i;
    if (n > TO) break;
    reqs.push({ jsonrpc: '2.0', id: n, method: 'eth_getBlockByNumber', params: ['0x' + n.toString(16), true] });
  }
  if (!reqs.length) return;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(reqs) });
      const data = await res.json();
      const arr = Array.isArray(data) ? data : [data];
      for (const item of arr) {
        if (item.error) { errors++; continue; }
        const blk = item.result;
        if (!blk || !blk.transactions) continue;
        for (const tx of blk.transactions) {
          const to = String(tx.to || '').toLowerCase();
          if (ADDRS.has(to) && VALS.has(String(BigInt(tx.value).toString()))) {
            hits.push({ block: parseInt(blk.number, 16), ts: parseInt(blk.timestamp, 16), tx: tx.hash, from: tx.from, to, value: tx.value });
          }
        }
      }
      done += reqs.length;
      return;
    } catch (e) {
      if (attempt === 2) { errors += reqs.length; return; }
      await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
    }
  }
}

async function main() {
  let cursor = FROM;
  const workers = [];
  const total = TO - FROM + 1;
  async function worker() {
    while (cursor <= TO) {
      const start = cursor; cursor += BATCH;
      await fetchBatch(start);
      const elapsed = (Date.now() - t0) / 1000;
      process.stderr.write(`\rscanned ${done}/${total} blocks (${(done / elapsed).toFixed(1)} blk/s) hits=${hits.length} err=${errors}   `);
    }
  }
  for (let i = 0; i < CONC; i++) workers.push(worker());
  await Promise.all(workers);
  process.stderr.write('\n');
  console.log(JSON.stringify(hits, null, 0));
  console.log('SUMMARY blocks=' + total + ' scanned=' + done + ' errors=' + errors + ' hits=' + hits.length + ' secs=' + ((Date.now() - t0) / 1000).toFixed(1));
}
main();
