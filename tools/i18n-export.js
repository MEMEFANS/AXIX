// 导出 i18n 词典键与现有 EXTRA 覆盖层，供全量翻译底稿使用
// 用法：node tools/i18n-export.js
// 输出：
//   tools/i18n-lang/_keys.txt        全部 dict 中文键（一行一个，按源码顺序）
//   tools/i18n-lang/_base-<lang>.json  现有 EXTRA[lang] 手工条目（翻译时作为基底保留）
const fs = require('fs');
const path = require('path');

const PUB = path.join(__dirname, '..', 'resources', 'app', 'public');
const I18N_SRC = fs.readFileSync(path.join(PUB, 'js', 'i18n.js'), 'utf8');
const OUT_DIR = path.join(__dirname, 'i18n-lang');
fs.mkdirSync(OUT_DIR, { recursive: true });

function sliceBetween(startMarker, endMarker) {
  const a = I18N_SRC.indexOf(startMarker);
  const b = I18N_SRC.indexOf(endMarker, a);
  if (a < 0 || b < 0) throw new Error('marker not found: ' + startMarker);
  return I18N_SRC.slice(a, b);
}

function extractPairs(text) {
  const map = {};
  const res = [
    /'((?:[^'\\]|\\.)*)'\s*:\s*'((?:[^'\\]|\\.)*)'/g,
    /'((?:[^'\\]|\\.)*)'\s*:\s*"((?:[^"\\]|\\.)*)"/g,
    /"((?:[^"\\]|\\.)*)"\s*:\s*'((?:[^'\\]|\\.)*)'/g,
    /"((?:[^"\\]|\\.)*)"\s*:\s*"((?:[^"\\]|\\.)*)"/g,
  ];
  for (const re of res) {
    let m;
    while ((m = re.exec(text))) {
      const key = m[1].replace(/\\'/g, "'").replace(/\\"/g, '"').replace(/\\n/g, '\n');
      if (/[\u4e00-\u9fff]/.test(key)) map[key] = m[2].replace(/\\'/g, "'").replace(/\\"/g, '"');
    }
  }
  return map;
}

// dict 区间：const dict = { ... };（排除 subMap/translateDynamicSpecial 等后段）
const dictSrc = sliceBetween('const dict = {', '\n  };');
const dict = extractPairs(dictSrc);

// EXTRA 区间按语言分段
const extraSrc = sliceBetween('const EXTRA = {', 'const LANGS = [');
const langs = ['zh-TW', 'ja', 'ko', 'ru', 'es'];
const extraLangs = {};
for (const lang of langs) {
  const re = new RegExp(`['"]?${lang.replace('-', '\\-')}['"]?\\s*:\\s*\\{`);
  const m = re.exec(extraSrc);
  if (!m) { extraLangs[lang] = {}; continue; }
  const start = m.index + m[0].length;
  let depth = 1, i = start;
  while (i < extraSrc.length && depth > 0) {
    if (extraSrc[i] === '{') depth++;
    else if (extraSrc[i] === '}') depth--;
    i++;
  }
  extraLangs[lang] = extractPairs(extraSrc.slice(start, i - 1));
}

// 1) 全部键（保持源码顺序）
const keys = Object.keys(dict);
fs.writeFileSync(path.join(OUT_DIR, '_keys.txt'), keys.join('\n'), 'utf8');

// 2) 现有 EXTRA 条目
for (const lang of langs) {
  const file = path.join(OUT_DIR, `_base-${lang}.json`);
  fs.writeFileSync(file, JSON.stringify(extraLangs[lang], null, 1), 'utf8');
}

console.log('dict keys:', keys.length);
for (const lang of langs) console.log(`EXTRA[${lang}]:`, Object.keys(extraLangs[lang]).length, '→', `_base-${lang}.json`);
