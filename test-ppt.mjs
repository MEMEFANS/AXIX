import pptxgen from 'pptxgenjs';

const prs = new pptxgen();
prs.layout = 'LAYOUT_16x9';
const slide = prs.addSlide();
slide.background = { color: '07100F' };

// 简单测试
slide.addText('测试标题 Test Title', {
  x: 0.5, y: 0.5, w: 12, h: 1,
  fontSize: 36, bold: true, color: '4FD1B5',
  fontFace: 'Microsoft YaHei',
});

slide.addText('这是第一行内容\n这是第二行内容', {
  x: 0.5, y: 1.8, w: 12, h: 2,
  fontSize: 18, color: 'FFFFFF',
  fontFace: 'Microsoft YaHei',
});

// 表格测试
slide.addTable([
  [{ text: '指标', options: { fill: { color: '0F1E1C' }, color: '4FD1B5', bold: true, fontSize: 14 } },
   { text: '数值', options: { fill: { color: '0F1E1C' }, color: '4FD1B5', bold: true, fontSize: 14 } }],
  [{ text: '总量', options: { fontSize: 14, color: 'E5E7EB' } },
   { text: '20 亿', options: { fontSize: 14, color: 'E5E7EB' } }],
], { x: 0.5, y: 4, w: 12 });

await prs.writeFile({ fileName: `${process.env.USERPROFILE}/Desktop/test.pptx` });
console.log('OK');
