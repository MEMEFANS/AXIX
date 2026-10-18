import fs from 'node:fs';
const md = fs.readFileSync('AxiX讲师课件.md', 'utf8');
// 找 "# 第" 或 "# AxiX" 开头的行位置
const lines = md.split('\n');
const positions = [];
for (let i = 0; i < lines.length; i++) {
  if (lines[i].startsWith('# 第') || lines[i].startsWith('# AxiX')) {
    positions.push({ line: i, text: lines[i] });
  }
}
console.log(`找到 ${positions.length} 个页面标题:`);
positions.forEach(p => console.log(`  L${p.line}: ${p.text.slice(0, 40)}`));
