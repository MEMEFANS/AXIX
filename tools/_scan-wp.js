// 扫描白皮书中文文本节点 + EXTRA 各语言覆盖情况
const fs = require('fs');
const path = require('path');

const PUB = path.join(__dirname, '..', 'resources', 'app', 'public');
const I18N_FILE = path.join(PUB, 'js', 'i18n.js');
const HTML_FILE = path.join(PUB, 'index.html');

const html = fs.readFileSync(HTML_FILE, 'utf8');
// 提取 #tab-whitepanel 区段
const startIdx = html.indexOf('id="tab-whitepaper"');
const endIdx = html.indexOf('</div>', html.lastIndexOf('id="tab-whitepaper"') + 100);
const wpStart = html.lastIndexOf('<div', startIdx);
let wpEnd = html.length;
// 找到白皮书闭合：用 <div 计数法
let depth = 0, i = wpStart;
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
console.log('白皮书文本节点总数:', m.length, ' 含中文:', cjk.length);
console.log('\n前15条中文样本:');
cjk.slice(0, 15).forEach((s, i) => console.log('  ' + (i + 1) + '. ' + s.slice(0, 90)));

// 解析 i18n.js 的 EXTRA
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

const dictSrc = i18nSrc.slice(i18nSrc.indexOf('const dict = {'), i18nSrc.indexOf('\n  };'));
const dict = extractPairs(dictSrc);
console.log('\ndict 条目数:', Object.keys(dict).length);

const extraSrc = i18nSrc.slice(i18nSrc.indexOf('const EXTRA = {'), i18nSrc.indexOf('const LANGS = ['));
for (const lang of ['zh-TW', 'ja', 'ko', 'ru', 'es']) {
  const re = new RegExp("['\"]?" + lang.replace('-', '\\-') + "['\"]?\\s*:\\s*\\{");
  const mm = re.exec(extraSrc);
  if (!mm) { console.log(lang, 'SECTION MISSING'); continue; }
  let d = 1, j = mm.index + mm[0].length;
  while (j < extraSrc.length && d > 0) {
    if (extraSrc[j] === '{') d++;
    else if (extraSrc[j] === '}') d--;
    j++;
  }
  const seg = extraSrc.slice(mm.index + mm[0].length, j - 1);
  const pairs = extractPairs(seg);
  console.log(lang, 'EXTRA 条目数:', Object.keys(pairs).length);
}

// 检查白皮书中文文本在 dict 里有英文翻译的比例
let inDict = 0, inExtraKo = 0;
const extraKoRe = /['"]?ko['"]?\s*:\s*\{/;
const kmm = extraKoRe.exec(extraSrc);
let kd = 1, kj = kmm.index + kmm[0].length;
while (kj < extraSrc.length && kd > 0) { if (extraSrc[kj] === '{') kd++; else if (extraSrc[kj] === '}') kd--; kj++; }
const koSeg = extraSrc.slice(kmm.index + kmm[0].length, kj - 1);
const koDict = extractPairs(koSeg);

for (const s of cjk) {
  if (dict[s] || dict[s.trim()]) inDict++;
  if (koDict[s] || koDict[s.trim()]) inExtraKo++;
}
console.log('\n白皮书中文文本在 dict 里有英文翻译的:', inDict, '/', cjk.length);
console.log('白皮书中文文本在 EXTRA[ko] 里有韩语翻译的:', inExtraKo, '/', cjk.length);
