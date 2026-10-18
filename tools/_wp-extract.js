// 提取白皮书的中文文本 + dict 里的英文翻译，输出为 JSON 供翻译用
const fs = require('fs');
const path = require('path');

const PUB = path.join(__dirname, '..', 'resources', 'app', 'public');
const I18N_FILE = path.join(PUB, 'js', 'i18n.js');
const HTML_FILE = path.join(PUB, 'index.html');

const html = fs.readFileSync(HTML_FILE, 'utf8');
const startIdx = html.indexOf('id="tab-whitepaper"');
const wpStart = html.lastIndexOf('<div', startIdx);
let depth = 0, i = wpStart, wpEnd = html.length;
while (i < html.length) {
  const ot = html.indexOf('<div', i);
  const ct = html.indexOf('</div>', i);
  if (ot === -1 && ct === -1) break;
  if (ct === -1 || (ot !== -1 && ot < ct)) { depth++; i = ot + 4; }
  else { depth--; i = ct + 6; if (depth === 0) { wpEnd = i; break; } }
}
const wp = html.slice(wpStart, wpEnd);

// 提取文本节点
const re = />[^<>]{8,}</g;
const m = wp.match(re) || [];
const cjk = m.filter(s => /[\u4e00-\u9fff]/.test(s)).map(s => s.replace(/^>|<$/g, '').trim()).filter(Boolean);

// 解析 dict
const i18nSrc = fs.readFileSync(I18N_FILE, 'utf8');
function extractPairs(text) {
  const map = {};
  const res = [
    /'((?:[^'\\]|\\.)*)'\s*:\s*'((?:[^'\\]|\\.)*)'/g,
    /'((?:[^'\\]|\\.)*)'\s*:\s*"((?:[^"\\]|\\.)*)"/g,
    /"((?:[^"\\]|\\.)*)"\s*:\s*'((?:[^'\\]|\\.)*)'/g,
    /"((?:[^"\\]|\\.)*)"\s*:\s*"((?:[^"\\]|\\.)*)"/g,
  ];
  for (const re of res) {
    let mm;
    while ((mm = re.exec(text))) {
      const key = mm[1].replace(/\\'/g, "'").replace(/\\"/g, '"').replace(/\\n/g, '\n');
      map[key] = mm[2].replace(/\\'/g, "'").replace(/\\"/g, '"');
    }
  }
  return map;
}
const dict = extractPairs(i18nSrc.slice(i18nSrc.indexOf('const dict = {'), i18nSrc.indexOf('\n  };')));

// 输出中文文本 + 英文翻译
const out = [];
const seen = new Set();
for (const s of cjk) {
  if (seen.has(s)) continue;
  seen.add(s);
  const en = dict[s] || dict[s.trim()] || '';
  out.push({ zh: s, en: en });
}

console.log('去重后白皮书中文文本:', out.length, '条');
console.log('有英文翻译:', out.filter(x => x.en).length, '条');
console.log('无英文翻译:', out.filter(x => !x.en).length, '条');

// 输出到文件
fs.writeFileSync(path.join(__dirname, 'i18n-lang', '_wp-scan.json'), JSON.stringify(out, null, 2), 'utf8');
console.log('\n已输出到 tools/i18n-lang/_wp-scan.json');

// 打印无英文翻译的（供补充）
const missing = out.filter(x => !x.en);
if (missing.length) {
  console.log('\n=== 无英文翻译的文本（需补充 dict）===');
  missing.forEach((x, i) => console.log('  ' + (i + 1) + '. ' + x.zh.slice(0, 80)));
}
