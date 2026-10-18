import collections
import concurrent.futures
import datetime
import json
import pathlib
import urllib.request

audit = pathlib.Path(__file__).resolve().parent
snapshot = json.loads((audit / 'team-snapshot.json').read_text(encoding='utf-8'))
members = {row['wallet'] for row in snapshot['members']}
rows = [a for a in snapshot['activations'] if a['wallet'].lower() in members and a['status'] == 'confirmed' and (a['confirmed_at'] or 0) >= snapshot['start_ms'] and a['plan'] in ['1','2']]
endpoint = 'https://bsc-dataseed.binance.org'
def rpc_batch(items):
    request_body = [{'jsonrpc':'2.0','id':i,'method':method,'params':params} for i,(method,params) in enumerate(items)]
    request = urllib.request.Request(endpoint, data=json.dumps(request_body).encode(), headers={'Content-Type':'application/json','User-Agent':'Mozilla/5.0'})
    last_error = None
    for attempt in range(3):
        try:
            with urllib.request.urlopen(request, timeout=20) as response:
                result = json.load(response)
            if not isinstance(result,list):
                raise ValueError('Unexpected batch response')
            by_id = {item['id']:item for item in result}
            if len(by_id) != len(items) or any(item.get('error') for item in result):
                raise ValueError('Incomplete or rejected batch response')
            return [by_id[i]['result'] for i in range(len(items))]
        except Exception as error:
            last_error = type(error).__name__
    raise RuntimeError('RPC read failed: ' + str(last_error))
def read_transactions(batch):
    items = []
    for row in batch:
        items += [('eth_getTransactionByHash',[row['tx_hash']]),('eth_getTransactionReceipt',[row['tx_hash']])]
    result = rpc_batch(items)
    return [(row,result[i*2],result[i*2+1]) for i,row in enumerate(batch)]
batches = [rows[i:i+15] for i in range(0,len(rows),15)]
transactions = []
with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
    for batch in pool.map(read_transactions,batches):
        transactions.extend(batch)
        print('Read ' + str(len(transactions)) + '/' + str(len(rows)) + ' transaction/receipt pairs', flush=True)
block_numbers = sorted({int(tx['blockNumber'],16) for _,tx,receipt in transactions if tx and receipt})
def read_blocks(batch):
    results = rpc_batch([('eth_getBlockByNumber',[hex(number),False]) for number in batch])
    return dict(zip(batch,results))
blocks = {}
with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
    for batch in pool.map(read_blocks,[block_numbers[i:i+30] for i in range(0,len(block_numbers),30)]):
        blocks.update(batch)
checks = []
for row,tx,receipt in transactions:
    errors = []
    if not tx or not receipt:
        errors.append('missing transaction or receipt')
    else:
        if tx['hash'].lower() != row['tx_hash'].lower() or receipt['transactionHash'].lower() != row['tx_hash'].lower():
            errors.append('transaction hash mismatch')
        if tx['from'].lower() != row['wallet'].lower() or receipt['from'].lower() != row['wallet'].lower():
            errors.append('payer mismatch')
        if int(tx['value'],16) != int(row['bnb_amount_wei']):
            errors.append('BNB amount mismatch')
        if int(receipt.get('status','0x0'),16) != 1:
            errors.append('transaction unsuccessful')
        if int(tx['blockNumber'],16) != row['block_number'] or int(receipt['blockNumber'],16) != row['block_number']:
            errors.append('block number mismatch')
        if tx.get('chainId') and int(tx['chainId'],16) != 56:
            errors.append('chain mismatch')
        block = blocks.get(int(tx['blockNumber'],16))
        if not block or block['hash'].lower() != receipt['blockHash'].lower():
            errors.append('block hash mismatch')
        elif int(block['timestamp'],16) * 1000 < snapshot['start_ms']:
            errors.append('chain transfer before start date')
    checks.append({'activation_id':row['id'],'wallet':row['wallet'],'plan':row['plan'],'tx_hash':row['tx_hash'],'bnb_amount_wei':row['bnb_amount_wei'],'to':(tx or {}).get('to'),'block_number':row['block_number'],'block_time_utc':datetime.datetime.fromtimestamp(int(blocks[int(tx['blockNumber'],16)]['timestamp'],16),datetime.timezone.utc).isoformat() if tx and blocks.get(int(tx['blockNumber'],16)) else None,'receipt_status':(receipt or {}).get('status'),'passed_payment_checks':not errors,'errors':errors})
out = {'captured_at_utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'rpc_endpoint':endpoint,'chain_id':56,'activation_count':len(rows),'checks':checks,'payment_checks_passed':all(row['passed_payment_checks'] for row in checks),'beneficiary_counts':dict(collections.Counter(row['to'] for row in checks)),'all_requests_read_only':True}
(audit / 'chain-verification.json').write_text(json.dumps(out,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps({'activation_count':len(rows),'payment_checks_passed':out['payment_checks_passed'],'beneficiary_counts':out['beneficiary_counts'],'failures':[row for row in checks if not row['passed_payment_checks']]},ensure_ascii=False,indent=2))
if not out['payment_checks_passed']:
    raise SystemExit(1)
