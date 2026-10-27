import ExcelJS from 'exceljs';
import { openDatabase } from '/opt/wg-platform/src/database.js';
import { createATokenRevenueService } from '/opt/wg-platform/src/a-token-revenue-service.js';

const W = '0x79b8cee7fb9724e3edb1c7e41bb353873df512e4';
const db = openDatabase('/var/lib/wg-platform');
const wb = new ExcelJS.Workbook();
wb.creator = 'AIX Platform';
wb.created = new Date();

const HEADER_FILL = 'FF1F4E79';
const HEADER_FONT = { color: 'FFFFFFFF', bold: true, size: 11, name: 'Arial' };
const ZEBRA1 = 'FFFFFFFF';
const ZEBRA2 = 'FFF7F9FC';
const BORDER = { style: 'thin', color: 'FFD9DEE7' };
const KPI_FILL = 'FFEAF2FF';
const POS_FONT = { color: 'FF0F6B35', bold: true };

function bjFmt(ms) {
  if (!ms) return '';
  const d = new Date(Number(ms) + 8 * 3600_000);
  const p = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}
function fmtA(units) {
  try { return Number(BigInt(units || '0')) / 1e18; } catch { return 0; }
}
function setHeader(ws, row, cols) {
  cols.forEach((c, i) => {
    const cell = ws.getCell(row, i + 1);
    cell.value = c;
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_FILL } };
    cell.font = HEADER_FONT;
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
    cell.border = { top: BORDER, bottom: BORDER, left: BORDER, right: BORDER };
  });
}
function styleRow(ws, r, ncol, isKpi = false) {
  const fill = isKpi ? KPI_FILL : ((r - 2) % 2 === 0 ? ZEBRA1 : ZEBRA2);
  for (let c = 1; c <= ncol; c++) {
    const cell = ws.getCell(r, c);
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } };
    cell.border = { top: BORDER, bottom: BORDER, left: BORDER, right: BORDER };
    cell.font = { name: 'Arial', size: 10, ...(isKpi ? { bold: true } : {}) };
  }
}

// ============ Sheet 1: 收益汇总 ============
const ws1 = wb.addWorksheet('收益汇总', { views: [{ state: 'frozen', ySplit: 1 }] });
ws1.columns = [
  { header: '收益类型', key: 'kind', width: 22 },
  { header: '笔数', key: 'cnt', width: 10 },
  { header: '累计金额 (AIX)', key: 'amount', width: 20 },
  { header: '首次到账 (北京)', key: 'first', width: 22 },
  { header: '最近到账 (北京)', key: 'last', width: 22 },
  { header: '状态', key: 'status', width: 12 },
];

const rev = createATokenRevenueService({ database: db }).listRevenue(W, { limit: 5000 });
const rows1 = [];
for (const s of rev.summary) {
  rows1.push([s.label, s.count, Number(s.amount), '', '', '正常']);
}
// 加汇总行
rows1.push(['合计', rev.summary.reduce((a, b) => a + b.count, 0), Number(rev.total), '', '', '']);
rows1.forEach((r, idx) => {
  ws1.addRow(r);
  styleRow(ws1, idx + 2, 6, idx === rows1.length - 1);
});
ws1.getColumn(3).numFmt = '#,##0.0000';

// ============ Sheet 2: 矿机收益 ============
const ws2 = wb.addWorksheet('矿机收益', { views: [{ state: 'frozen', ySplit: 1 }] });
ws2.columns = [
  { header: '到账时间 (北京)', key: 't', width: 22 },
  { header: '矿机计划', key: 'plan', width: 14 },
  { header: '释放金额 (AIX)', key: 'amt', width: 18 },
];
const miners = db.db.prepare('SELECT plan FROM a_token_miners WHERE lower(wallet)=?').all(W);
const minerReleases = db.db.prepare('SELECT released_at, amount_units FROM a_token_miner_releases WHERE lower(wallet)=? ORDER BY released_at').all(W);
let minerTotal = 0n;
minerReleases.forEach((r, i) => {
  ws2.addRow([bjFmt(r.released_at), miners[0]?.plan || '', fmtA(r.amount_units)]);
  styleRow(ws2, i + 2, 3);
  minerTotal += BigInt(r.amount_units);
});
ws2.addRow(['合计', '', fmtA(minerTotal.toString())]);
styleRow(ws2, minerReleases.length + 2, 3, true);
ws2.getColumn(3).numFmt = '#,##0.0000';

// ============ Sheet 3: 质押收益 ============
const ws3 = wb.addWorksheet('质押收益', { views: [{ state: 'frozen', ySplit: 1 }] });
ws3.columns = [
  { header: '质押单号', key: 'id', width: 40 },
  { header: '到账时间 (北京)', key: 't', width: 22 },
  { header: '总额 (AIX)', key: 'total', width: 16 },
  { header: '利息 (AIX)', key: 'interest', width: 16 },
  { header: '本金返还 (AIX)', key: 'principal', width: 18 },
];
const stakeRows = db.db.prepare('SELECT stake_id, settled_at, amount_units, json_extract(payload_json,\'$.interestUnits\') AS i, json_extract(payload_json,\'$.principalUnits\') AS p FROM a_token_stake_rewards WHERE lower(wallet)=? ORDER BY settled_at').all(W);
let stakeTotal = 0n, stakeInt = 0n, stakePri = 0n;
stakeRows.forEach((r, i) => {
  ws3.addRow([r.stake_id, bjFmt(r.settled_at), fmtA(r.amount_units), fmtA(r.i), fmtA(r.p)]);
  styleRow(ws3, i + 2, 5);
  stakeTotal += BigInt(r.amount_units);
  stakeInt += BigInt(r.i || '0');
  stakePri += BigInt(r.p || '0');
});
ws3.addRow(['合计', '', fmtA(stakeTotal.toString()), fmtA(stakeInt.toString()), fmtA(stakePri.toString())]);
styleRow(ws3, stakeRows.length + 2, 5, true);
[3, 4, 5].forEach(c => ws3.getColumn(c).numFmt = '#,##0.0000');

// ============ Sheet 4: 团队分润 ============
const ws4 = wb.addWorksheet('团队分润', { views: [{ state: 'frozen', ySplit: 1 }] });
ws4.columns = [
  { header: '类型', key: 'kind', width: 18 },
  { header: '笔数', key: 'cnt', width: 10 },
  { header: '累计金额 (AIX)', key: 'amt', width: 20 },
  { header: '首次到账 (北京)', key: 'first', width: 22 },
  { header: '最近到账 (北京)', key: 'last', width: 22 },
];
const teamRows = db.db.prepare("SELECT kind, COUNT(*) AS cnt, SUM(CAST(amount_units AS REAL)) AS amt, MIN(created_at) AS first_at, MAX(created_at) AS last_at FROM a_token_team_rewards WHERE lower(recipient_wallet)=? GROUP BY kind ORDER BY amt DESC").all(W);
let teamTotal = 0n;
teamRows.forEach((r, i) => {
  ws4.addRow([r.kind, r.cnt, r.amt / 1e18, bjFmt(r.first_at), bjFmt(r.last_at)]);
  styleRow(ws4, i + 2, 5);
  teamTotal += BigInt(Math.round(r.amt));
});
ws4.addRow(['合计', teamRows.reduce((a, b) => a + b.cnt, 0), fmtA(teamTotal.toString()), '', '']);
styleRow(ws4, teamRows.length + 2, 5, true);
ws4.getColumn(3).numFmt = '#,##0.0000';

// 保存
const out = '/tmp/79b8-income-report.xlsx';
await wb.xlsx.writeFile(out);
console.log('written', out);
db.close?.();
