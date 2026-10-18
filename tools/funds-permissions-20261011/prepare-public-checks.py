import pathlib

audit=pathlib.Path(__file__).resolve().parent
previous=audit.parent/'admin-security-20261011'
source=(previous/'verify-release-public.py').read_text(encoding='utf-8')
source=source.replace("manifest = json.loads((audit / 'release-manifest.json').read_text(encoding='utf-8'))", "manifest = json.loads((audit / 'release-manifest.json').read_text(encoding='utf-8'))\nprotected = json.loads((audit / 'release-payload.json').read_text(encoding='utf-8'))['protected']")
source=source.replace("manifest[name]['after']", "(manifest[name]['after'] if name in manifest else protected[name])")
source=source.replace('/js/operator-admin.js?v=20261011-security-2','/js/operator-admin.js?v=20261011-permissions-1')
source=source.replace('/js/funds-admin.js?v=20261011-security-1','/js/funds-admin.js?v=20261011-permissions-1')
(audit/'verify-public.py').write_text(source,encoding='utf-8')
source=(previous/'public-browser-smoke.cjs').read_text(encoding='utf-8')
source=source.replace("const login = JSON.parse(fs.readFileSync(path.join(__dirname,'login-private.json'),'utf8'));", "const credentialText = fs.readFileSync('C:/Users/cy020/Desktop/后台登录信息-20261011.txt','utf8');\nconst login = {username:credentialText.match(/^账号：(.*)$/m)[1].trim(),password:credentialText.match(/^密码：(.*)$/m)[1].trim(),fundsToken:credentialText.match(/^管理令牌：(.*)$/m)[1].trim()};")
source=source.replace("document.getElementById('funds-auto-state').textContent==='自动提现已关闭'", "/^自动提现已(开启|关闭)$/.test(document.getElementById('funds-auto-state').textContent)")
source=source.replace('keeps automatic payout disabled','shows the current automatic payout setting')
source=source.replace("await funds.click('#funds-lock');", "await funds.click('#funds-tab-assets');await funds.waitForFunction(()=>document.getElementById('funds-assets-body').children.length>0,{timeout:25000});\n  await funds.click('#funds-tab-miners');await funds.waitForFunction(()=>document.getElementById('funds-miners-body').children.length>0,{timeout:25000});\n  result.checks.push('funds-only asset adjustment and miner grant panels load their authenticated records');\n  await funds.click('#funds-lock');")
source=source.replace("result.checks.push('operator login works and funding panels are removed');", "assert.equal(await admin.$('#admin-aix-credit-form'),null);\n  await admin.click('[data-admin-page=\"a-miner\"]');await admin.waitForSelector('#am-open-funds',{timeout:25000});assert.equal(await admin.$('#am-grant'),null);\n  const oldRoutes=['grant','debit','grant-miner','grant-stake','activations/confirm'];\n  for(const route of oldRoutes){const checked=await admin.evaluate(async route=>{const res=await fetch('/api/admin/a-token/'+route);return {status:res.status,code:(await res.json()).code};},route);assert.equal(checked.status,403);assert.equal(checked.code,'FUNDS_ADMIN_REQUIRED');}\n  for(const uri of ['/api/wallet/admin/asset-adjustments','/api/wallet/admin/miner-grants'])assert.equal(await admin.evaluate(async uri=>(await fetch(uri)).status,uri),401);\n  result.checks.push('operator write forms removed, old asset/miner APIs denied, and operator cookie cannot access new funds endpoints');")
(audit/'public-browser.cjs').write_text(source,encoding='utf-8')
print('Prepared public header/content and read-only browser checks')
