import pathlib,tempfile,sqlite3,subprocess,json,os,datetime,re,hashlib
root=pathlib.Path('/opt/wg-platform')
out={'captured_at_utc':datetime.datetime.now(datetime.timezone.utc).isoformat()}
with tempfile.TemporaryDirectory(prefix='wg-deployed-assets-') as temp:
    original=sqlite3.connect('file:'+str(root/'wg-platform.sqlite')+'?mode=ro',uri=True)
    copied=sqlite3.connect(str(pathlib.Path(temp)/'wg-platform.sqlite'));original.backup(copied);copied.close();original.close()
    code=r'''
import assert from 'node:assert/strict';
import {parseUnits,formatUnits} from 'ethers';
import {openDatabase,closeDatabase} from '/opt/wg-platform/src/database.js';
import {createPlatformService} from '/opt/wg-platform/src/platform-service.js';
const root=process.env.WG_ASSET_CHECK_COPY,db=openDatabase(root);
const balances=new Map(db.db.prepare('SELECT address,balances_json FROM wallet_users').all().map(r=>[r.address.toLowerCase(),JSON.parse(r.balances_json)]));
const walletService={database:db,balanceUnits:(w,a)=>BigInt(balances.get(w.toLowerCase())?.[a]||'0')};
const service=createPlatformService({dataRoot:root,walletService});
const meta=JSON.parse(db.db.prepare("SELECT payload_json FROM service_settings WHERE setting_key='a_token_pool_meta'").get().payload_json);
const price=parseUnits(String(meta.priceUsdt),6),results=[];
for(const wallet of ['0x968acf8d6111b7668d730641d86efaec0f6b48a6','0xc6da1e64eca3cb29e160fd72a1787a6e9e40a11d','0x436252b4759eee30066a0d1101911caa7a63ccf2']){
 const free=walletService.balanceUnits(wallet,'A'),lock=BigInt(db.sumATokenLockedByWallet(wallet).aUnits||'0');
 const principalPaid=new Map();
 for(const r of db.db.prepare('SELECT stake_id,payload_json FROM a_token_stake_rewards WHERE wallet=? COLLATE NOCASE').all(wallet)){
  const p=JSON.parse(r.payload_json);assert.ok(p.principalUnits!=null,'Expected explicit ledger principal split for sample');
  principalPaid.set(r.stake_id,(principalPaid.get(r.stake_id)||0n)+BigInt(p.principalUnits));
 }
 const outstanding=db.listATokenStakes(wallet).filter(s=>s.status==='active').reduce((sum,s)=>sum+BigInt(s.principalUnits)-(principalPaid.get(s.id)||0n),0n);
 service.setATokenPriceProvider(()=>0n);const without=service.profile(wallet,{});
 service.setATokenPriceProvider(()=>price);const profile=service.profile(wallet,{});
 const expectedSpot=free*price/10n**18n+lock*price/10n**18n,expectedStake=outstanding*price/10n**18n;
 assert.equal(parseUnits(profile.account.spotValue,6)-parseUnits(without.account.spotValue,6),expectedSpot);
 assert.equal(parseUnits(profile.account.stakingValue,6)-parseUnits(without.account.stakingValue,6),expectedStake);
 assert.equal(parseUnits(profile.account.totalEquity,6)-parseUnits(without.account.totalEquity,6),expectedSpot+expectedStake);
 assert.equal(parseUnits(profile.spot.A,18),free);assert.equal(parseUnits(profile.spotFrozen.A,18),lock);
 results.push({wallet,spot_AIX_value_USDT:formatUnits(expectedSpot,6),staked_AIX_principal:formatUnits(outstanding,18),staked_AIX_value_USDT:formatUnits(expectedStake,6),no_double_counting:true});
}
console.log(JSON.stringify({price_USDT:meta.priceUsdt,accounts:results}));closeDatabase(root);
'''
    result=subprocess.run(['node','--input-type=module','-e',code],cwd=root,env=dict(os.environ,WG_ASSET_CHECK_COPY=temp),capture_output=True,text=True,timeout=35)
    if result.returncode:raise RuntimeError('Deployed asset validation failed: '+result.stderr[-2000:])
    out['isolated_live_source_asset_check']=json.loads(result.stdout)
db=sqlite3.connect('file:'+str(root/'wg-platform.sqlite')+'?mode=ro',uri=True)
out['deleted_attack_accounts_present']=db.execute('SELECT COUNT(*) FROM wallet_users WHERE lower(address) IN (?,?)',('0xd36ddfb9d3fa6b326b49e6eab68c5b961bc3ba59','0xf75a7c032b7a484269ced5663f7fa10acf63b1ac')).fetchone()[0]
out['automatic_withdrawal_enabled']=json.loads(db.execute("SELECT payload_json FROM service_settings WHERE setting_key='wallet_meta'").fetchone()[0]).get('withdrawalAutomation',{}).get('enabled');db.close()
out['service']=subprocess.run(['systemctl','show','wg-platform','--property=MainPID,ActiveState,SubState'],capture_output=True,text=True,check=True,timeout=10).stdout
release_start=int(datetime.datetime(2026,10,10,20,23,2,tzinfo=datetime.timezone.utc).timestamp())
logs=subprocess.run(['journalctl','-u','wg-platform','--since','@'+str(release_start),'--no-pager','-o','json'],capture_output=True,text=True,check=True,timeout=10).stdout
issues=[]
for line in logs.splitlines():
    try:r=json.loads(line);m=r.get('MESSAGE','')
    except Exception:continue
    if any(x in m for x in ['SyntaxError','ReferenceError','TypeError','ERR_MODULE_NOT_FOUND','[admin-user-detail] error','[平级奖日结] 启动补发失败']):issues.append({'time':r.get('__REALTIME_TIMESTAMP'),'message_sha256':hashlib.sha256(m.encode()).hexdigest()})
out['release_runtime_error_hashes']=issues
print(json.dumps(out,ensure_ascii=False,indent=2))
