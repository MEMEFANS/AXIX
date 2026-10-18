// 验证 i18n.js EXTRA[ko] 是否含白皮书长句 key，并模拟 DOM 实体差异
const fs = require('fs');
const path = require('path');
const LANG_DIR = path.join(__dirname, 'i18n-lang');
const scan = JSON.parse(fs.readFileSync(path.join(LANG_DIR, '_wp-scan.json'), 'utf8'));
const src = fs.readFileSync(path.join(__dirname, '..', 'resources', 'app', 'public', 'js', 'i18n.js'), 'utf8');

let ok = 0, miss = [];
scan.forEach((item, i) => {
  // i18n.js EXTRA 用 JSON.stringify 序列化 key，直接搜序列化形式
  const ser = JSON.stringify(item.zh);
  if (src.includes(ser)) ok++;
  else miss.push({ i, zh: item.zh.slice(0, 60) });
});
console.log('i18n.js contains key:', ok, '/', scan.length);
if (miss.length) {
  console.log('missing (first 10):');
  miss.slice(0, 10).forEach(m => console.log(' ', m.i, JSON.stringify(m.zh)));
}
