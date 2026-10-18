// 临时质量检查：EXTRA 各语言区段的空值/语言混淆检查
const fs = require('fs');
const src = fs.readFileSync('resources/app/public/js/i18n.js', 'utf8');
const a = src.indexOf('const EXTRA = {');
const b = src.indexOf('const LANGS = [');
const ex = src.slice(a, b);
const langs = ['zh-TW', 'ja', 'ko', 'ru', 'es'];
// 各语言的"错误字符"模式：出现即视为混入了别的语言
const wrongRe = {
  'zh-TW': /[\u3040-\u30ff\uac00-\ud7af\u0400-\u04ff]/,
  'ja': /[\uac00-\ud7af\u0400-\u04ff]/,
  'ko': /[\u3040-\u30ff\u4e00-\u9fff\u0400-\u04ff]/,
  'ru': /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/,
  'es': /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af\u0400-\u04ff]/,
};
function pairs(t) {
  const m = {};
  const re = /"((?:[^"\\]|\\.)*)"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
  let r;
  while ((r = re.exec(t))) m[r[1]] = r[2];
  return m;
}
let issues = 0;
for (const lang of langs) {
  const re = new RegExp('["\']?' + lang.replace('-', '\\-') + '["\']?\\s*:\\s*\\{');
  const mm = re.exec(ex);
  if (!mm) { console.log(lang, 'SECTION MISSING'); issues++; continue; }
  let i = mm.index + mm[0].length, d = 1, j = i;
  while (j < ex.length && d > 0) {
    if (ex[j] === '{') d++;
    else if (ex[j] === '}') d--;
    j++;
  }
  const seg = ex.slice(i, j - 1);
  const p = pairs(seg);
  const n = Object.keys(p).length;
  let empty = 0, wrong = 0;
  for (const [k, v] of Object.entries(p)) {
    if (!v.trim()) { empty++; console.log('  EMPTY [' + lang + ']:', k); }
    if (wrongRe[lang].test(v)) {
      wrong++;
      if (wrong <= 5) console.log('  WRONG-LANG [' + lang + ']:', k, '=>', v);
    }
  }
  console.log(lang, 'entries=' + n, 'empty=' + empty, 'wrongLang=' + wrong);
  if (empty || wrong) issues++;
}
console.log(issues === 0 ? 'ALL EXTRA SECTIONS CLEAN' : 'ISSUES FOUND: ' + issues);
process.exit(issues === 0 ? 0 : 1);
