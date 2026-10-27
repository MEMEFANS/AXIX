const fs=require('fs');
const p='resources/app/public/js/a-token-transfer.js';let s=fs.readFileSync(p,'utf8');
s=s.replace('  function fillPct(pct) {',`  function amountUnits(value) {
    const match = /^(\\d+)(?:\\.(\\d{0,18}))?$/.exec(String(value || '').trim());
    if (!match) throw new Error('请输入有效的 AIX 数量（最多 18 位小数）');
    return BigInt(match[1]) * 10n ** 18n + BigInt((match[2] || '').padEnd(18, '0'));
  }

  function fillPct(pct) {`);
s=s.replace("    const bal = Number(window.__atTransferBalanceA || 0);\r\n    const amt = bal * (Number(pct) / 100);\r\n    if ($('at-amount')) $('at-amount').value = amt > 0 ? (Math.floor(amt * 1e8) / 1e8).toString() : '0';",`    const units = amountUnits(window.__atTransferBalanceA || '0') * BigInt(pct) / 100n;
    // Truncate to eight display decimals without rounding above the ledger balance.
    const ticks = units / 10n ** 10n;
    const fraction = (ticks % 100000000n).toString().padStart(8, '0').replace(/0+$/, '');
    if ($('at-amount')) $('at-amount').value = (ticks / 100000000n).toString() + (fraction ? '.' + fraction : '');`);
s=s.replace("window.__atTransferBalanceA = Number(prof?.balances?.A || 0);","window.__atTransferBalanceA = String(prof?.balances?.A || '0');");
s=s.replace("      const bal = Number(window.__atTransferBalanceA || 0);\r\n      if (n > bal)","      const bal = window.__atTransferBalanceA || '0';\r\n      if (amountUnits(amt) > amountUnits(bal))");
s=s.replace("setStatus(e.message?.includes('请') ? e.message : '互转失败，请重试', 'error');","setStatus(e.message || '互转失败，请重试', 'error');");
if(s.includes('const amt = bal *')||s.includes('if (n > bal)'))throw Error('replacement missed');fs.writeFileSync(p,s);
