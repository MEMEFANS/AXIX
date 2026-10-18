import pptxgen from 'pptxgenjs';
import fs from 'node:fs';
import path from 'node:path';

const src = path.join(import.meta.dirname, 'AxiX讲师课件.md');
const md = fs.readFileSync(src, 'utf8');
const allLines = md.split('\n');

const headerIdx = [];
for (let i = 0; i < allLines.length; i++) {
  if (allLines[i].startsWith('# 第') || allLines[i].startsWith('# AxiX')) headerIdx.push(i);
}
const pages = [];
for (let i = 0; i < headerIdx.length; i++) {
  const start = headerIdx[i];
  const end = i + 1 < headerIdx.length ? headerIdx[i + 1] : allLines.length;
  pages.push(allLines.slice(start, end).join('\n').trim());
}

const prs = new pptxgen();
prs.layout = 'LAYOUT_16x9';

const C = {
  bgDark: '07100F',
  accent: '4FD1B5',
  body: 'E5E7EB',
  sub: '9CA3AF',
  codeBg: '0F1E1C',
  codeQuote: '0C2421',
};

// 幻灯片是 13.33 x 7.5 英寸
// 内容区 x: 0.6 ~ 12.7 (宽 12.1), y: 1.1 ~ 6.8 (高 5.7)
const MARGIN_X = 0.6;
const MAX_Y = 6.8;

function parsePage(text) {
  const lines = text.split('\n');
  const titleLine = lines.find(l => l.startsWith('# ')) || '';
  const subLine = lines.find(l => l.startsWith('## ')) || '';
  const title = titleLine.replace(/^# /, '').trim();
  const subtitle = subLine.replace(/^## /, '').trim();
  const bodyStart = Math.max(lines.indexOf(titleLine), lines.indexOf(subLine)) + 1;
  const body = lines.slice(bodyStart).join('\n').trim();
  return { title, subtitle, body };
}

// 处理 markdown 行 → PPT runs
function mkRuns(text, fontSize, color, boldColor) {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  const runs = [];
  for (const p of parts) {
    if (!p) continue;
    if (p.startsWith('**') && p.endsWith('**')) {
      runs.push({ text: p.slice(2, -2), options: { bold: true, color: boldColor || C.accent, fontSize } });
    } else {
      runs.push({ text: p, options: { color: color || C.body, fontSize } });
    }
  }
  return runs;
}

function buildSlide(text, idx, total) {
  const { title, subtitle, body } = parsePage(text);
  const slide = prs.addSlide();
  slide.background = { color: C.bgDark };

  // 左侧装饰绿条
  slide.addShape(prs.ShapeType.rect, {
    x: 0, y: 0, w: 0.1, h: 7.5,
    fill: { color: C.accent }, line: { color: C.accent },
  });

  // 标题
  let y = 0.3;
  slide.addText(title, {
    x: 0.4, y, w: 12.5, h: 0.5,
    fontFace: 'Microsoft YaHei', fontSize: 24, bold: true, color: C.accent,
  });
  y += 0.55;

  if (subtitle) {
    slide.addText(subtitle, {
      x: 0.4, y, w: 12.5, h: 0.3,
      fontFace: 'Microsoft YaHei', fontSize: 13, color: C.sub,
    });
    y += 0.35;
  }

  y += 0.15; // 间距

  // 分块处理
  const blocks = body.split(/\n\s*\n/);
  const contentW = 12.2;
  const contentX = 0.4;

  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed) continue;

    // 超出就跳过
    if (y > MAX_Y - 0.3) break;

    // 演讲词
    if (trimmed.startsWith('> ')) {
      const quoteLines = trimmed.replace(/^>\s?/gm, '').split('\n');
      const boxLines = Math.min(quoteLines.length, 10); // 最多显示 10 行
      const boxH = Math.min(boxLines * 0.28 + 0.5, MAX_Y - y);

      slide.addShape(prs.ShapeType.rect, {
        x: contentX, y, w: contentW, h: boxH,
        fill: { color: C.codeQuote }, line: { color: C.accent, pt: 0.5 },
      });
      // 左侧小竖条
      slide.addShape(prs.ShapeType.rect, {
        x: contentX, y, w: 0.05, h: boxH,
        fill: { color: C.accent }, line: { color: C.accent },
      });
      slide.addText('讲师', {
        x: contentX + 0.15, y: y + 0.05, w: 2, h: 0.22,
        color: C.accent, fontSize: 10, bold: true, fontFace: 'Microsoft YaHei',
      });

      let qy = y + 0.3;
      for (let i = 0; i < boxLines; i++) {
        const line = quoteLines[i];
        if (qy + 0.25 > y + boxH) break;
        slide.addText(mkRuns(line, 12, C.sub, C.accent), {
          x: contentX + 0.15, y: qy, w: contentW - 0.3, h: 0.25,
          fontFace: 'Microsoft YaHei', valign: 'top',
        });
        qy += 0.25;
      }
      y += boxH + 0.15;
      continue;
    }

    // 表格
    if (trimmed.startsWith('|') && trimmed.includes('\n|')) {
      const rows = trimmed.split('\n')
        .filter(l => l.trim().startsWith('|') && !l.includes('---'))
        .map(l => l.split('|').map(c => c.trim()).filter((c, i, a) => !(i === 0 || i === a.length - 1)));
      if (rows.length) {
        const cols = rows[0].length;
        const colW = contentW / cols;
        const rowH = Math.min(24, (MAX_Y - y - 0.1) / rows.length * 72);
        const rowHin = rowH / 72;
        const rows2show = Math.min(rows.length, Math.floor((MAX_Y - y - 0.1) / rowHin));
        for (let r = 0; r < rows2show; r++) {
          for (let c = 0; c < cols; c++) {
            const isH = r === 0;
            slide.addText(rows[r][c], {
              x: contentX + c * colW, y: y + r * rowHin, w: colW, h: rowHin,
              fill: isH ? { color: C.codeBg } : { color: r % 2 ? '0C1715' : C.bgDark },
              color: isH ? C.accent : C.body,
              bold: isH, fontSize: isH ? 11 : 10,
              align: c === 0 ? 'left' : 'center', valign: 'middle',
              fontFace: 'Microsoft YaHei',
              border: { pt: 0.5, color: '1F3A37' },
            });
          }
        }
        y += rows2show * rowHin + 0.15;
      }
      continue;
    }

    // 代码/ASCII
    if (trimmed.startsWith('```')) {
      const code = trimmed.replace(/^```[a-zA-Z]*\n?/, '').replace(/```\s*$/, '').trim();
      const cLines = code.split('\n').slice(0, 15); // 最多 15 行
      const boxH = Math.min(cLines.length * 0.22 + 0.2, MAX_Y - y);
      slide.addShape(prs.ShapeType.rect, {
        x: contentX, y, w: contentW, h: boxH,
        fill: { color: C.codeBg }, line: { color: '1F3A37' },
      });
      for (let i = 0; i < cLines.length; i++) {
        const ly = y + 0.1 + i * 0.22;
        if (ly + 0.2 > y + boxH) break;
        slide.addText(cLines[i], {
          x: contentX + 0.15, y: ly, w: contentW - 0.3, h: 0.22,
          fontSize: 10, color: 'A7F3D0', fontFace: 'Consolas', valign: 'top',
        });
      }
      y += boxH + 0.15;
      continue;
    }

    // 普通文本 / 列表
    const bLines = trimmed.split('\n');
    let showCount = 0;
    for (const line of bLines) {
      if (line.trim() === '') {
        y += 0.12;
        continue;
      }
      if (y + 0.3 > MAX_Y) break;
      // 列表项前缀处理
      let text = line;
      if (/^[-✅•]\s/.test(line)) text = '  ' + line.replace(/^[-✅•]\s/, '• ');
      else if (/^\d+\.\s/.test(line)) text = '  ' + line;

      slide.addText(mkRuns(text, 13, C.body, C.accent), {
        x: contentX, y, w: contentW, h: 0.3,
        fontFace: 'Microsoft YaHei', valign: 'top',
      });
      y += 0.3;
      showCount++;
      if (showCount > 18) break; // 每页最多 18 行普通文本
    }
    y += 0.1;
  }

  // 页脚
  slide.addText('AxiX · 通缩驱动 · 价值共识', {
    x: 0.4, y: 7.2, w: 6, h: 0.2,
    fontFace: 'Microsoft YaHei', fontSize: 8, color: C.sub,
  });
  slide.addText(`${idx + 1} / ${total}`, {
    x: 7, y: 7.2, w: 6, h: 0.2,
    fontFace: 'Microsoft YaHei', fontSize: 8, color: C.sub, align: 'right',
  });
}

pages.forEach((p, i) => buildSlide(p, i, pages.length));

const outPath = path.join(process.env.USERPROFILE, 'Desktop', 'AxiX讲师课件.pptx');
await prs.writeFile({ fileName: outPath });
console.log(`✅ ${outPath}`);
console.log(`📊 ${pages.length} 页`);
