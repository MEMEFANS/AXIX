// 提取指定文件中的长中文句子（>6字），标记哪些还不是词典整句键
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const CJK = /[\u4e00-\u9fff]/;
const i18nSrc = fs.readFileSync(path.join(root, 'js', 'i18n.js'), 'utf8');
const keys = new Set();
for (const m of i18nSrc.matchAll(/'((?:[^'\\\n]|\\.)*)'\s*:/g)) if (CJK.test(m[1])) keys.add(m[1]);
for (const m of i18nSrc.matchAll(/"((?:[^"\\\n]|\\.)*)"\s*:/g)) if (CJK.test(m[1])) keys.add(m[1]);

const targets = ['js/leaderboard.js', 'js/ai-managed.js', 'index.html', 'js/overview.js', 'js/strategy.js'];
const out = [];
for (const t of targets) {
  const p = path.join(root, t);
  if (!fs.existsSync(p)) continue;
  let src = fs.readFileSync(p, 'utf8');
  if (t.endsWith('.html')) {
    src = src.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '');
    for (const m of src.matchAll(/>([^<>]+)</g)) {
      const line = m[1].replace(/\s+/g, ' ').trim();
      const han = (line.match(/[\u4e00-\u9fff]/g) || []).length;
      if (han < 4 || keys.has(line)) continue;
      out.push({ t: line, f: t });
    }
    continue;
  }
  const re = /'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g;
  for (const m of src.matchAll(re)) {
    const raw = m[1] ?? m[2] ?? m[3];
    if (raw === undefined) continue;
    const chunks = m[3] !== undefined ? raw.split(/\$\{[^}]*\}/) : [raw];
    for (let c of chunks) {
      c = c.replace(/\\n/g, '\n').replace(/\\'/g, "'").replace(/\\"/g, '"').replace(/<[^>]*>/g, '\n');
      for (let line of c.split('\n')) {
        line = line.replace(/\s+/g, ' ').trim();
        // 统计汉字数量，>=4 个汉字才算长句
        const han = (line.match(/[\u4e00-\u9fff]/g) || []).length;
        if (han < 4) continue;
        if (keys.has(line)) continue;
        out.push({ t: line, f: t });
      }
    }
  }
}
const seen = new Set(), uniq = [];
for (const o of out) { if (!seen.has(o.t)) { seen.add(o.t); uniq.push(o); } }
uniq.sort((a, b) => b.t.length - a.t.length);
console.log(uniq.map(o => `${o.t}   [${o.f}]`).join('\n'));
console.error(`共 ${uniq.length} 条非整句键的长句`);
