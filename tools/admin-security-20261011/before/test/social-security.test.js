import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { Wallet } from 'ethers';
import { createLotteryService, normalizeSocialScreenshot } from '../src/lottery-service.js';
import { createATokenApi } from '../src/a-token-api.js';
import { createWithdrawalPayoutService } from '../src/withdrawal-payout-service.js';

const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
const injection = '\"><img src=x onerror="window.securityCanary=1">';
for (const source of [injection, 'javascript:alert(1)', 'data:image/svg+xml;base64,PHN2Zy8+', 'data:text/html;base64,PHNjcmlwdD4=', 'data:image/png;base64,PHNjcmlwdD4=', png+'\" onerror="test()', '', null]) {
  assert.throws(() => normalizeSocialScreenshot(source));
}
assert.equal(normalizeSocialScreenshot(png), png);
assert.throws(() => normalizeSocialScreenshot('x'.repeat(950001)), e => e.statusCode===413);
let inserts=0;
const lottery=createLotteryService({ database:{getSetting:()=>null,listSocialSubmissionsSince:()=>[],insertSocialSubmission:()=>inserts++},walletService:{} });
assert.throws(()=>lottery.submitSocial('0x'+'1'.repeat(40),'twitter',injection));
assert.equal(inserts,0);
assert.equal(lottery.submitSocial('0x'+'1'.repeat(40),'twitter',png).screenshotUrl,png);
assert.equal(inserts,1);

// Exercise the actual preview click handler with a canary, without parsing user HTML.
let handler, opens=0, preview;
const messages=[];
const shot={dataset:{shot:'test'},addEventListener:(type,fn)=>handler=fn};
const host={innerHTML:'',querySelectorAll:sel=>sel==='[data-shot]'?[shot]:[]};
const popup={opener:{},document:{createElement:()=>({style:{}}),body:{replaceChildren:image=>preview=image},write:()=>{throw new Error('Unsafe HTML preview')}}};
const context={window:{open:()=>{opens++;return popup;}},document:{getElementById:id=>id==='al-content'?host:{addEventListener:()=>{}}},console};
vm.createContext(context);
const script=fs.readFileSync(new URL('../public/js/admin-lottery.js',import.meta.url),'utf8').replace('return { init, load };','return { init, load, renderSocial, setSocialForTest: list => socialList = list };');
vm.runInContext(script,context);
const admin=context.window.AdminLottery;admin.init({api:()=>{},toast:text=>messages.push(text)});
admin.setSocialForTest([{id:'test',wallet:'test',platform:'twitter',status:'pending',screenshotUrl:injection}]);admin.renderSocial();handler();
assert.equal(opens,0);assert.equal(messages.length,1);
admin.setSocialForTest([{id:'test',wallet:'test',platform:'twitter',status:'pending',screenshotUrl:png}]);admin.renderSocial();handler();
assert.equal(opens,1);assert.equal(preview.src,png);assert.equal(popup.opener,null);

const address='0x'+'1'.repeat(40);let frozen=true, reads=0;const responses=[];
const api=createATokenApi({walletService:{database:{},adminGetWithdrawalFreeze:()=>frozen?{frozen:true}:null},getSession:()=>({address}),readBody:()=>{reads++;return {};},send:(res,status,body)=>responses.push({status,body}),claimService:{listClaims:()=>[],status:()=>({enabled:true})},poolService:{quote:()=>({ok:true})}});
for(const pathname of ['/api/a-token/withdraw','/api/a-token/claim-signature','/api/a-token/transfer','/api/a-token/orders']){
  await api.handle({method:'POST',headers:{}},{},pathname);
  assert.equal(responses.at(-1).status,403);assert.equal(responses.at(-1).body.code,'WITHDRAWAL_FROZEN');
}
assert.equal(reads,0);
await api.handle({method:'GET',headers:{},url:'/api/a-token/claims'},{},'/api/a-token/claims');assert.equal(responses.at(-1).status,200);
frozen=false;await api.handle({method:'POST',headers:{}},{},'/api/a-token/quote');assert.equal(responses.at(-1).status,200);assert.equal(reads,1);

const signer=Wallet.createRandom();let claimed=0;let record={id:'blocked',wallet:address,status:'pending_auto',network:'bsc'};
const payout=createWithdrawalPayoutService({walletService:{payoutRecord:()=>record,claimPayout:()=>{claimed++;return record;},adminGetWithdrawalFreeze:()=>({frozen:true})},privateKey:signer.privateKey,withdrawalAddress:signer.address,enabled:true,networks:[{id:'bsc',chainId:56,tokenContract:'0x'+'2'.repeat(40),provider:{}}]});
await payout.enqueue(record.id);assert.equal(claimed,0);
record={...record,status:'signed'};await payout.enqueue(record.id);assert.equal(claimed,0);
console.log('security regression passed: malicious uploads rejected, historical preview blocked, raster preview works, AIX exits frozen, queued and signed USDT sends blocked');
