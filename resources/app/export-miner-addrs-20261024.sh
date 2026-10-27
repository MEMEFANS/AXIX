#!/bin/bash
node --input-type=module -e "
import { DatabaseSync } from 'node:sqlite';
import { writeFileSync } from 'node:fs';
const db = new DatabaseSync('/var/lib/wg-platform/wg-platform.sqlite', { readOnly: true });
const tables = db.prepare(\"SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%miner%'\").all().map(r=>r.name);
console.log('tables:', tables.join(','));
const t = tables.find(n => n.includes('miner'));
const cols = db.prepare('PRAGMA table_info(' + t + ')').all().map(c => c.name);
console.log('cols:', cols.join(','));
const wcol = cols.find(c => /wallet|address/i.test(c));
const total = db.prepare('SELECT COUNT(DISTINCT LOWER(' + wcol + ')) c FROM ' + t).get().c;
console.log('distinct_wallets=' + total);
const rows = db.prepare('SELECT DISTINCT LOWER(' + wcol + ') w FROM ' + t + ' ORDER BY RANDOM() LIMIT 3000').all();
writeFileSync('/tmp/miner_addrs_3000.txt', rows.map(r => r.w).join('\n') + '\n');
console.log('exported=' + rows.length);
db.close();
"
wc -l /tmp/miner_addrs_3000.txt
head -3 /tmp/miner_addrs_3000.txt
