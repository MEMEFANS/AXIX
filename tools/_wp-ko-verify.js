// 抽查韩语白皮书翻译对齐：按 scan 索引检查关键节点
const fs = require('fs');
const path = require('path');
const LANG_DIR = path.join(__dirname, 'i18n-lang');
const scan = JSON.parse(fs.readFileSync(path.join(LANG_DIR, '_wp-scan.json'), 'utf8'));
const p2 = JSON.parse(fs.readFileSync(path.join(LANG_DIR, 'ko.p2.json'), 'utf8'));
const p3 = JSON.parse(fs.readFileSync(path.join(LANG_DIR, 'ko.p3.json'), 'utf8'));
const all = Object.assign({}, p2, p3);

let ok = 0, miss = 0;
scan.forEach((item, i) => {
  const v = all[item.zh];
  if (v === undefined) { miss++; console.log('MISSING idx', i, ':', item.zh.slice(0, 40)); }
  else if (!v) { miss++; console.log('EMPTY idx', i, ':', item.zh.slice(0, 40)); }
  else ok++;
});
console.log('coverage:', ok, '/', scan.length, 'missing/empty:', miss);

// 抽查关键索引（0、89、90、91、92、93、176）
[0, 89, 90, 91, 92, 93, 176].forEach(i => {
  console.log('--- idx', i);
  console.log('  zh:', scan[i].zh.slice(0, 50));
  console.log('  ko:', all[scan[i].zh] ? all[scan[i].zh].slice(0, 50) : '(none)');
});
