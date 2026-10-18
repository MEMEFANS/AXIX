// 扫描前端源码中未被 i18n 词典覆盖的中文文案
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const CJK = /[\u4e00-\u9fff]/;

// ---------- 1. 提取 i18n.js 词典键（所有含中文且后跟 ":" 的字符串字面量） ----------
const i18nSrc = fs.readFileSync(path.join(root, 'js', 'i18n.js'), 'utf8');
const keys = new Set();
// 单引号键：'中文' :
for (const m of i18nSrc.matchAll(/'((?:[^'\\\n]|\\.)*)'\s*:/g)) {
  if (CJK.test(m[1])) keys.add(m[1]);
}
// 双引号键
for (const m of i18nSrc.matchAll(/"((?:[^"\\\n]|\\.)*)"\s*:/g)) {
  if (CJK.test(m[1])) keys.add(m[1]);
}
console.error(`词典键数量: ${keys.size}`);

const covered = (s) => keys.has(s);

// ---------- 2. 从 JS 提取中文字符串字面量 ----------
const jsFiles = fs.readdirSync(path.join(root, 'js')).filter(f => f.endsWith('.js') && f !== 'i18n.js');
const found = new Map(); // text -> Set(file)
const add = (t, file) => {
  const s = t.trim();
  if (!s || !CJK.test(s)) return;
  if (!found.has(s)) found.set(s, new Set());
  found.get(s).add(file);
};
for (const f of jsFiles) {
  const src = fs.readFileSync(path.join(root, 'js', f), 'utf8');
  // 单引号 / 双引号 / 模板字符串，逐个取出含中文的字面量；模板按 ${} 切分
  const re = /'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g;
  for (const m of src.matchAll(re)) {
    const raw = m[1] ?? m[2] ?? m[3];
    if (raw === undefined || !CJK.test(raw)) continue;
    const unesc = (s) => s.replace(/\\n/g, '\n').replace(/\\'/g, "'").replace(/\\"/g, '"').replace(/\\`/g, '`').replace(/\\\$/g, '$');
    if (m[3] !== undefined) {
      for (const chunk of raw.split(/\$\{[^}]*\}/)) {
        // 模板片段多为 HTML：先抽属性值，再去标签，再按行提取纯文本
        for (const am of chunk.matchAll(/(?:placeholder|title|aria-label)="([^"]*)"/g)) add(unesc(am[1]), f);
        const text = unesc(chunk).replace(/<[^>]*>/g, '\n');
        for (const line of text.split('\n')) add(line.replace(/\s+/g, ' '), f);
      }
    } else {
      add(unesc(raw), f);
    }
  }
}

// ---------- 3. 从 HTML 提取文本节点与属性 ----------
for (const f of ['index.html', 'admin.html']) {
  const p = path.join(root, f);
  if (!fs.existsSync(p)) continue;
  let src = fs.readFileSync(p, 'utf8');
  src = src.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '');
  for (const m of src.matchAll(/>([^<>]*)</g)) {
    const t = m[1].replace(/\s+/g, ' ').trim();
    if (CJK.test(t)) add(t, f);
  }
  for (const m of src.matchAll(/(placeholder|title|aria-label)="([^"]*)"/g)) {
    const t = m[2].replace(/\s+/g, ' ').trim();
    if (CJK.test(t)) add(t, f);
  }
}

// ---------- 4. 找出未覆盖的 ----------
const missing = [];
for (const [text, files] of found) {
  if (covered(text)) continue;
  missing.push({ text, files: [...files] });
}
missing.sort((a, b) => b.text.length - a.text.length);
fs.writeFileSync(path.join(root, '..', 'tools', 'i18n-missing.json'), JSON.stringify(missing, null, 1), 'utf8');
console.error(`源码中文文案总数: ${found.size}，未覆盖: ${missing.length}`);
console.log(missing.slice(0, 400).map(m => `${m.text}   [${[...m.files].join(',')}]`).join('\n'));
