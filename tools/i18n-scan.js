// i18n 覆盖检查脚本：扫描页面中文文案，对比 i18n.js 词典，输出缺失项
// 用法：node tools/i18n-scan.js [--lang en|tw|ja|ko|ru|es|all]（默认 en）
const fs = require('fs');
const path = require('path');

const PUB = path.join(__dirname, '..', 'resources', 'app', 'public');
const I18N_SRC = fs.readFileSync(path.join(PUB, 'js', 'i18n.js'), 'utf8');

// ── 从 i18n.js 源码按区间提取词典（行式 `'key': 'value',`）──
function sliceBetween(startMarker, endMarker) {
  const a = I18N_SRC.indexOf(startMarker);
  const b = I18N_SRC.indexOf(endMarker, a);
  if (a < 0 || b < 0) throw new Error('marker not found: ' + startMarker);
  return I18N_SRC.slice(a, b);
}

function extractPairs(text) {
  const map = {};
  // key/value 引号类型独立，且值允许包含另一种引号（如英语撇号 Today's）
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

// en 覆盖集合 = dict ∪ translateDynamicSpecial 的 exactMap/subMap/dynamicSel（全文 zh→en 键值对）
const dict = extractPairs(I18N_SRC);
// EXTRA 区间：const EXTRA = { ... }; 内部按语言分段
const extraSrc = sliceBetween('const EXTRA = {', 'const LANGS = [');
const extraLangs = {};
for (const lang of ['zh-TW', 'ja', 'ko', 'ru', 'es']) {
  const re = new RegExp(`['"]?${lang.replace('-', '\\-')}['"]?\\s*:\\s*\\{`);
  const m = re.exec(extraSrc);
  if (!m) { extraLangs[lang] = {}; continue; }
  const start = m.index + m[0].length;
  // 找配对大括号（简单计数）
  let depth = 1, i = start;
  while (i < extraSrc.length && depth > 0) {
    if (extraSrc[i] === '{') depth++;
    else if (extraSrc[i] === '}') depth--;
    i++;
  }
  extraLangs[lang] = extractPairs(extraSrc.slice(start, i - 1));
}

// ── 扫描页面文件 ──
function walk(dir, exts, out = []) {
  for (const name of fs.readdirSync(dir)) {
    if (name === 'node_modules' || name === 'vendor' || name === 'i18n.js') continue;
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) walk(full, exts, out);
    else if (exts.some(e => name.endsWith(e))) out.push(full);
  }
  return out;
}

const files = walk(PUB, ['.js', '.html']);

// 白皮书静态区按设计跳过翻译（inWhitepaper），扫描时剔除该区间
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

// 提取文件中的中文文本片段（模板/字符串/HTML 文本中的中文连续段）
function extractZhStrings(src) {
  // 去掉注释；模板插值 ${...} 替换为 §（视为动态值占位）
  const noComment = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
    .replace(/\$\{[^}]*\}/g, '§');
  const set = new Set();
  // 中文连续段（含夹心：中英文/数字/常用标点/§占位），保留完整段不剪头尾
  const re = /[\u4e00-\u9fff][\u4e00-\u9fff\u00b7\u2014\u2018\u2019\u201c\u201d\u2026\uff08\uff09\uff0c\uff1a\uff1b\uff01\uff1f\u3001\u3002\u300a\u300b a-zA-Z0-9,.%&~+:\-*/×·$§（）()「」→←]*/g;
  let m;
  while ((m = re.exec(noComment))) {
    const s = m[0].trim();
    if (s.length >= 2 && /[\u4e00-\u9fff]/.test(s)) set.add(s);
  }
  return [...set];
}

// 判断片段是否被词典覆盖：整段命中，或整段由若干词典 key + 无关字符拼成（贪心切分）
function normalizeKey(k) {
  // 去掉 key 首尾的非中文部分（如前缀 emoji/「AIX 」/尾随标点）
  const m = /[\u4e00-\u9fff]/.exec(k);
  if (!m) return '';
  const start = m.index;
  let end = k.length;
  while (end > start && !/[\u4e00-\u9fff）)」』%]/.test(k[end - 1])) end--;
  return k.slice(start, end);
}

function coveredBy(seg, keys) {
  if (keys.has(seg)) return true;
  // 规则 b：插值截断/局部片段 —— 取 seg 的中文核心（去 § 后缀与尾部英文数字），与某 key 的中文核心互相包含（≥4 字）
  let core = seg.split('§')[0].replace(/[\sA-Za-z0-9.,%·×+\-*/$&:：()（）]+$/, '');
  if (core.length >= 4) {
    for (const k of keys) {
      const nk = normalizeKey(k);
      if (nk.length >= 4 && (nk.includes(core) || core.includes(nk))) return true;
    }
  }
  // 贪心：从头找最长 key 前缀，剩余部分若含中文继续递归
  const arr = [...keys].filter(k => k.length <= seg.length);
  const tryFrom = (i) => {
    if (i >= seg.length) return true;
    // 跳过非中文字符（数字/英文/标点/空格，动态值天然保留）
    while (i < seg.length && !/[\u4e00-\u9fff]/.test(seg[i])) i++;
    if (i >= seg.length) return true;
    for (const k of arr) {
      if (k.length && seg.startsWith(k, i)) {
        if (tryFrom(i + k.length)) return true;
      }
    }
    return false;
  };
  return tryFrom(0);
}

const argLang = (process.argv[2] || '--lang').replace('--', '');
const langNames = { en: null, 'zh-TW': 'zh-TW', ja: 'ja', ko: 'ko', ru: 'ru', es: 'es' };

// 已人工核实的扫描误差片段：运行时翻译实际覆盖（词典含完整短语或其组成部分），
// 只是扫描器把插值/标点拆开后无法整段匹配。逐条注明覆盖来源，勿随意添加。
// - "免）"      ← '$0.00（免）' / '（免）' 均在 dict（a-token-trade.js 买方手续费行）
// - "用户 § 人 · 每天 00:00 均分到账" ← 'A10 用户' + '人 · 每天 00:00 均分到账'（earn.js A10 池）
// - "第 § 名"   ← '第 1 名' ~ '第 100 名' 全量在 dict（leaderboard.js 我的排名，服务端 limit=100）
// - "赠送 § 台 §" ← '✓ 赠送' + '台 '（operator-admin.js 赠送矿机 toast）
// - "线管理"/"线写入" ← '🧰 K 线管理' / '✓ K 线写入'（"K " 前缀非中文被拆开）
// - "已§"       ← '已启用' / '已停用'（operator-admin.js 代币启停 toast）
// - "留空"      ← '留空=全部' / '留空默认转到平台钱包' 等（"=" 不在扫描字符集被截断）
// - "管理"      ← 'AxiX · Permit 管理'（permit-admin.html 标题，前缀英文被拆开）
const VERIFIED_FRAGMENTS = new Set([
  '免）', '用户 § 人 · 每天 00:00 均分到账', '第 § 名', '赠送 § 台 §',
  '线管理', '线写入', '已§', '留空', '管理',
]);

const dictKeys = new Set(Object.keys(dict));
const report = {};
for (const f of files) {
  let src = fs.readFileSync(f, 'utf8');
  if (f.endsWith('.html')) src = stripWhitepaper(src);
  const segs = extractZhStrings(src);
  const missing = segs.filter(s => !VERIFIED_FRAGMENTS.has(s) && !coveredBy(s, dictKeys));
  if (missing.length) report[path.relative(PUB, f).replace(/\\/g, '/')] = missing.sort((a, b) => b.length - a.length);
}

const lines = [];
const out = s => lines.push(s);
out('=== 词典规模 ===');
out('dict(en) keys: ' + Object.keys(dict).length);
for (const [lang, m] of Object.entries(extraLangs)) out(`EXTRA[${lang}] keys: ` + Object.keys(m).length);

out('\n=== 英文(dict) 未覆盖的中文文案（按文件） ===');
let total = 0;
for (const [f, miss] of Object.entries(report)) {
  total += miss.length;
  out(`\n# ${f} (${miss.length})`);
  for (const s of miss) out('  ' + JSON.stringify(s));
}
out(`\n总计缺失片段: ${total}`);

// 其他语言覆盖缺口（基于 dict 全集 vs EXTRA）
if (argLang !== 'en' && langNames[argLang] !== undefined) {
  const lang = langNames[argLang] || argLang;
  if (lang && extraLangs[lang]) {
    const missingLang = Object.keys(dict).filter(k => !extraLangs[lang][k]);
    out(`\n=== EXTRA[${lang}] 相对 dict 缺失 ${missingLang.length} 条（前 200） ===`);
    out(missingLang.slice(0, 200).map(k => JSON.stringify(k)).join('\n'));
  }
}

fs.writeFileSync(path.join(__dirname, 'i18n-report.txt'), lines.join('\n'), 'utf8');
console.log('report written: tools/i18n-report.txt, missing =', total);
