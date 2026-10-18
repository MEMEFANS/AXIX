// i18n 全量覆盖层合并脚本
// 用法：node tools/i18n-merge.js [--check]（--check 只校验不写入）
// 输入：tools/i18n-lang/<lang>.p*.json（分片翻译）+ i18n.js 内现有手工 EXTRA 条目（优先保留）
// 校验：
//   1) 覆盖完整性：dict 中"运行时可达"的 key（在非白皮书源码中出现，或 第 N 名 模式）必须被覆盖
//   2) 幂等安全：value 中若包含其他多字 key 且该 key 译文不等于自身，会在多轮 apply 中被二次替换 → 报警
// 输出：重写 i18n.js 的 EXTRA 区段（保持文件其余部分不动）
const fs = require('fs');
const path = require('path');

const PUB = path.join(__dirname, '..', 'resources', 'app', 'public');
const I18N_FILE = path.join(PUB, 'js', 'i18n.js');
const I18N_SRC = fs.readFileSync(I18N_FILE, 'utf8');
const LANG_DIR = path.join(__dirname, 'i18n-lang');
const CHECK_ONLY = process.argv.includes('--check');
const LANGS = ['zh-TW', 'ja', 'ko', 'ru', 'es'];

function sliceBetween(src, startMarker, endMarker) {
  const a = src.indexOf(startMarker);
  const b = src.indexOf(endMarker, a);
  if (a < 0 || b < 0) throw new Error('marker not found: ' + startMarker);
  return src.slice(a, b);
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

const dict = extractPairs(sliceBetween(I18N_SRC, 'const dict = {', '\n  };'));

function stripWhitepaper(src) {
  const m = /<div[^>]*id="tab-whitepaper"[^>]*>/.exec(src);
  if (!m) return src;
  let i = m.index, depth = 0;
  const tagRe = /<div\b[^>]*>|<\/div>/g;
  tagRe.lastIndex = i;
  let t;
  while ((t = tagRe.exec(src))) {
    if (t[0] === '</div>') depth--;
    else depth++;
    if (depth === 0) { i = tagRe.lastIndex; break; }
  }
  return src.slice(0, m.index) + src.slice(i);
}

// 运行时可达 key：出现在非白皮书源码中的（子串即可能被 subAll 命中），或动态排名模式
function collectRuntimeText() {
  const parts = [];
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      if (name === 'node_modules' || name === 'vendor' || name === 'i18n.js') continue;
      const full = path.join(dir, name);
      const st = fs.statSync(full);
      if (st.isDirectory()) walk(full);
      else if (/\.(js|html)$/.test(name)) {
        let src = fs.readFileSync(full, 'utf8');
        if (name.endsWith('.html')) src = stripWhitepaper(src);
        parts.push(src);
      }
    }
  };
  walk(PUB);
  return parts.join('\n');
}
const runtimeText = collectRuntimeText();
const neededKeys = Object.keys(dict).filter(k => runtimeText.includes(k) || /^第 \d+ 名$/.test(k));
const neededSet = new Set(neededKeys);

// 现有手工 EXTRA（优先保留）
const extraSrc = sliceBetween(I18N_SRC, 'const EXTRA = {', 'const LANGS = [');
const bases = {};
for (const lang of LANGS) {
  const re = new RegExp(`['"]?${lang.replace('-', '\\-')}['"]?\\s*:\\s*\\{`);
  const m = re.exec(extraSrc);
  bases[lang] = m ? extractPairs(extraSrc.slice(m.index + m[0].length, (() => {
    let depth = 1, i = m.index + m[0].length;
    while (i < extraSrc.length && depth > 0) {
      if (extraSrc[i] === '{') depth++;
      else if (extraSrc[i] === '}') depth--;
      i++;
    }
    return i - 1;
  })())) : {};
}

// 读取分片
function loadParts(lang) {
  const files = fs.readdirSync(LANG_DIR).filter(f => f.startsWith(`${lang}.p`) && f.endsWith('.json')).sort();
  return files.map(f => JSON.parse(fs.readFileSync(path.join(LANG_DIR, f), 'utf8')));
}

let hasError = false;
const finals = {};
for (const lang of LANGS) {
  const parts = loadParts(lang);
  const final = Object.assign({}, ...parts, bases[lang]);
  finals[lang] = final;
  const missing = neededKeys.filter(k => !(k in final));
  const missingFile = path.join(LANG_DIR, `_missing-${lang}.json`);
  fs.writeFileSync(missingFile, JSON.stringify(missing, null, 0), 'utf8');
  console.log(`[${lang}] parts=${parts.length} entries=${Object.keys(final).length} missing=${missing.length}`);
  if (missing.length) {
    hasError = true;
    console.log(`  → 详见 _missing-${lang}.json（前 10: ${JSON.stringify(missing.slice(0, 10))}）`);
  }
  // 幂等安全检查：value 包含其他多字 key 且该 key 非自映射 → 多轮 apply 会被二次替换
  const multiKeys = Object.keys(dict).filter(k => k.length > 1);
  const warns = [];
  for (const [k, v] of Object.entries(final)) {
    if (!v) continue;
    for (const k2 of multiKeys) {
      if (k2 !== k && final[k2] !== k2 && v.includes(k2)) warns.push(`${JSON.stringify(k)} → ${JSON.stringify(v)} 含 key ${JSON.stringify(k2)}`);
    }
  }
  // 注意：运行时 v41 引擎为单次正则替换（替换结果不二次扫描），值包含其他 key 不会连锁替换，
  // 此检查仅作参考信息，不阻断合并。
  if (warns.length) {
    console.log(`  幂等提示 ${warns.length} 条（单次替换引擎下安全，详见 _idem-${lang}.txt）`);
    fs.writeFileSync(path.join(LANG_DIR, `_idem-${lang}.txt`), warns.join('\n'), 'utf8');
  }
}
if (hasError) {
  console.log('存在缺失/警告，未写入 i18n.js（修复分片后重试；或加 --force 强制写入）');
  if (!process.argv.includes('--force')) process.exit(1);
}

if (CHECK_ONLY) { console.log('--check 完成，未写入'); process.exit(0); }

// ── 重建 EXTRA 区段 ──
const q = s => JSON.stringify(s);
function emitLang(lang, map) {
  const entries = Object.entries(map).map(([k, v]) => q(k) + ': ' + q(v));
  // 每行打包到 ~110 字符，紧凑可读
  const lines = [];
  let line = '      ';
  for (const e of entries) {
    if (line.length > 6 && line.length + e.length + 2 > 116) { lines.push(line); line = '      '; }
    if (line.length > 6) line += ', ';
    line += e;
  }
  if (line.trim()) lines.push(line);
  return `    '${lang}': {\n` + lines.join(',\n') + ',\n    },';
}

const blocks = LANGS.map(lang => emitLang(lang, finals[lang])).join('\n');
const rebuilt = `const EXTRA = {\n${blocks}\n  };\n\n  `;
const start = I18N_SRC.indexOf('const EXTRA = {');
const end = I18N_SRC.indexOf('const LANGS = [', start);
if (start < 0 || end < 0) throw new Error('EXTRA markers not found');
fs.writeFileSync(I18N_FILE, I18N_SRC.slice(0, start) + rebuilt + I18N_SRC.slice(end), 'utf8');
console.log('i18n.js EXTRA 区段已重建');
