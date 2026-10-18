// 查 reverseFor 定义 + dict 里 Grid/网格 相关条目
const fs = require('fs');
const src = fs.readFileSync('resources/app/public/js/i18n.js', 'utf8');

const i = src.indexOf('function reverseFor');
console.log('=== reverseFor ===');
console.log(src.slice(i, i + 700));

console.log('\n=== 网格 in dict area ===');
const d0 = src.indexOf('const dict = {');
const d1 = src.indexOf('\n  };');
const dictSeg = src.slice(d0, d1);
let p = -1;
while ((p = dictSeg.indexOf('网格', p + 1)) > -1) {
  const ls = dictSeg.lastIndexOf('\n', p) + 1;
  const le = dictSeg.indexOf('\n', p);
  console.log('  ', dictSeg.slice(ls, le).trim().slice(0, 100));
}

console.log('\n=== "Grid" as key or value in dict ===');
const re = /'([^']{0,40})'\s*:\s*'([^']{0,60})'/g;
let m;
while ((m = re.exec(dictSeg))) {
  if (m[1].includes('Grid') || m[2].includes('Grid') || m[1] === '网格') {
    console.log('  ', JSON.stringify(m[1]), '=>', JSON.stringify(m[2]));
  }
}
