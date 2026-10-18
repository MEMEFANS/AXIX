// 从 _missing-<lang>.json 生成待翻译模板 _todo-<lang>.json（key → ""，每键一行）
// 用法：node tools/i18n-todo.js [lang...]
const fs = require('fs');
const path = require('path');
const LANG_DIR = path.join(__dirname, 'i18n-lang');
const langs = process.argv.slice(2).length ? process.argv.slice(2) : ['ja', 'ko', 'ru', 'es'];
for (const lang of langs) {
  const mf = path.join(LANG_DIR, `_missing-${lang}.json`);
  if (!fs.existsSync(mf)) { console.log(`skip ${lang}: no _missing file`); continue; }
  const keys = JSON.parse(fs.readFileSync(mf, 'utf8'));
  const lines = keys.map(k => JSON.stringify(k) + ': ""');
  const out = '{\n' + lines.join(',\n') + '\n}\n';
  fs.writeFileSync(path.join(LANG_DIR, `_todo-${lang}.json`), out, 'utf8');
  console.log(`[${lang}] todo=${keys.length}`);
}
