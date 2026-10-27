import sqlite3, json, urllib.request, datetime

db = sqlite3.connect('file:/var/lib/wg-platform/wg-platform.sqlite?mode=ro', uri=True)

# 1) reconcile 游标
row = db.execute("SELECT payload_json FROM service_settings WHERE setting_key='a_token_activation_reconcile_v1'").fetchone()
cur = json.loads(row[0]) if row else {}
print('对账游标:', cur)

# 2) RPC 当前块高（用服务同一个 rpcUrl —— 从 .env 读）
import re
env = open('/var/lib/wg-platform/.env').read() if __import__('os').path.exists('/var/lib/wg-platform/.env') else open('/opt/wg-platform/.env').read()
m = re.search(r'^(?:RPC_URL|BSC_RPC_URL|WEB3_RPC)\s*=\s*["\']?([^"\'\r\n]+)', env, re.M)
rpc = m.group(1).strip() if m else 'https://bsc-dataseed.binance.org'
print('RPC(脱敏):', rpc[:40] + '...')
req = urllib.request.Request(rpc, data=json.dumps({'jsonrpc':'2.0','id':1,'method':'eth_blockNumber','params':[]}).encode(), headers={'Content-Type':'application/json'})
latest = int(json.loads(urllib.request.urlopen(req, timeout=15).read())['result'], 16)
print('BSC 当前块高:', latest)
if cur.get('lastBlock'):
    lag = latest - int(cur['lastBlock'])
    print('游标落后:', lag, '块')
    upd = cur.get('updatedAt')
    if upd:
        print('游标更新时间:', datetime.datetime.fromtimestamp(upd/1000).strftime('%H:%M:%S'))
