// v2：模拟运行时翻译，找出 en 路径下仍会残留中文的真实缺口
// dict（行14–2058）= en 动态内容唯一词典；dict+subMap = 首屏全页 pass
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const CJK = /[\u4e00-\u9fff]/;
const i18nLines = fs.readFileSync(path.join(root, 'js', 'i18n.js'), 'utf8').split('\n');

const extractKeys = (from, to) => {
  const seg = i18nLines.slice(from - 1, to).join('\n');
  const keys = new Set();
  for (const m of seg.matchAll(/'((?:[^'\\\n]|\\.)*)'\s*:/g)) if (CJK.test(m[1])) keys.add(m[1].replace(/\\'/g, "'"));
  for (const m of seg.matchAll(/"((?:[^"\\\n]|\\.)*)"\s*:/g)) if (CJK.test(m[1])) keys.add(m[1]);
  return keys;
};
const dictKeys = extractKeys(14, 2058);
const subMapKeys = extractKeys(5777, 6460);
console.error(`dict键: ${dictKeys.size}  subMap键: ${subMapKeys.size}`);

// 近似 subAll：迭代做最长键替换（单遍正则的效果足够接近，用于找残留中文）
const simulate = (text, keys) => {
  const arr = [...keys].sort((a, b) => b.length - a.length).filter(k => k.length >= 2);
  let t = text;
  for (const k of arr) {
    if (t.includes(k)) t = t.split(k).join('☐'); // 用占位符模拟"已被英文替换"
  }
  return t;
};
const residualCJK = (t) => (t.match(/[\u4e00-\u9fff]+/g) || []);

// ---- 提取源码文案（同 v1 逻辑）----
const found = new Map();
const add = (t, file) => {
  const s = t.trim().replace(/\s+/g, ' ');
  if (!s || !CJK.test(s)) return;
  if (!found.has(s)) found.set(s, new Set());
  found.get(s).add(file);
};
for (const f of fs.readdirSync(path.join(root, 'js')).filter(f => f.endsWith('.js') && f !== 'i18n.js')) {
  const src = fs.readFileSync(path.join(root, 'js', f), 'utf8');
  const re = /'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g;
  for (const m of src.matchAll(re)) {
    const raw = m[1] ?? m[2] ?? m[3];
    if (raw === undefined || !CJK.test(raw)) continue;
    const unesc = (s) => s.replace(/\\n/g, '\n').replace(/\\'/g, "'").replace(/\\"/g, '"').replace(/\\`/g, '`').replace(/\\\$/g, '$');
    if (m[3] !== undefined) {
      for (const chunk of raw.split(/\$\{[^}]*\}/)) {
        for (const am of chunk.matchAll(/(?:placeholder|title|aria-label)="([^"]*)"/g)) add(unesc(am[1]), f);
        const text = unesc(chunk).replace(/<[^>]*>/g, '\n');
        for (const line of text.split('\n')) add(line, f);
      }
    } else add(unesc(raw), f);
  }
}
for (const f of ['index.html', 'admin.html']) {
  const p = path.join(root, f);
  if (!fs.existsSync(p)) continue;
  let src = fs.readFileSync(p, 'utf8').replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '');
  for (const m of src.matchAll(/>([^<>]*)</g)) add(m[1], f);
  for (const m of src.matchAll(/(placeholder|title|aria-label)="([^"]*)"/g)) add(m[2], f);
}

// ---- 分类：dict 缺口（动态可见，必须修） / 仅 subMap 覆盖（首屏可见，建议修） ----
const gapDict = [], gapSub = [];
for (const [text, files] of found) {
  const rDict = residualCJK(simulate(text, dictKeys));
  if (!rDict.length) continue;
  const rMerged = residualCJK(simulate(text, new Set([...dictKeys, ...subMapKeys])));
  const item = { text, files: [...files].join(','), residual: rDict.join('|') };
  if (rMerged.length) gapDict.push(item); else gapSub.push({ ...item, residual: rMerged.join('|') });
}
gapDict.sort((a, b) => a.text.localeCompare(b.text, 'zh'));
gapSub.sort((a, b) => a.text.localeCompare(b.text, 'zh'));
fs.writeFileSync(path.join(root, '..', 'tools', 'i18n-gap-dict.json'), JSON.stringify(gapDict, null, 1), 'utf8');
fs.writeFileSync(path.join(root, '..', 'tools', 'i18n-gap-sub.json'), JSON.stringify(gapSub, null, 1), 'utf8');
console.error(`dict缺口(动态必现中文): ${gapDict.length}  仅subMap缺口(首屏中文): ${gapSub.length}`);
console.log('=== DICT GAPS (dynamic path) ===');
console.log(gapDict.map(g => `${g.text}  ⟦残:${g.residual}⟧  [${g.files}]`).join('\n'));
console.log('=== SUBMAP-ONLY GAPS (initial pass) ===');
console.log(gapSub.map(g => `${g.text}  ⟦残:${g.residual}⟧  [${g.files}]`).join('\n'));
