const fs=require('fs'),vm=require('vm'),assert=require('node:assert/strict');
let src=fs.readFileSync('resources/app/public/js/a-token-transfer.js','utf8').replace('window.ATokenTransfer = { open, close };','window.ATokenTransfer = { open, close, fillPct, amountUnits, submit };');
const els={};for(const id of ['at-amount','at-uid','at-submit','at-status'])els[id]={value:'',className:'',textContent:''};
const ctx={window:{__atTransferBalanceA:'87743306249999999995'},document:{getElementById:id=>els[id]},console,BigInt};vm.createContext(ctx);vm.runInContext(src,ctx);
const api=ctx.window.ATokenTransfer;ctx.window.__atTransferBalanceA='87.743306249999999995';api.fillPct('100');assert.equal(els['at-amount'].value,'87.74330624');
for(const balance of ['87.743306249999999995','100.000000000000000001','20.000000009999999999','999999999999999999.999999999999999999'])for(const pct of [25,50,75,100]){ctx.window.__atTransferBalanceA=balance;api.fillPct(String(pct));assert(api.amountUnits(els['at-amount'].value)<=api.amountUnits(balance));}
assert(api.amountUnits('87.74330625')>api.amountUnits('87.743306249999999995'));
ctx.window.__atTransferBalanceA='87.743306249999999995';els['at-amount'].value='87.74330625';els['at-uid'].value='ABCDEFGH';
api.submit().then(()=>{assert.match(els['at-status'].textContent,/余额不足/);assert.equal(els['at-submit'].disabled,false);console.log('PASS: exact balance, 16 percentage cases, over-balance blocked before signature');});
