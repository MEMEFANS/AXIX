import collections
import datetime
from decimal import Decimal
import json
import pathlib

audit = pathlib.Path(__file__).resolve().parent
snapshot = json.loads((audit / 'team-snapshot.json').read_text(encoding='utf-8'))
tz = datetime.timezone(datetime.timedelta(hours=8))
def time_text(value):
    return datetime.datetime.fromtimestamp(int(value) / 1000, tz).strftime('%Y-%m-%d %H:%M:%S') if value else '—'
def short(wallet):
    return wallet[:8] + '...' + wallet[-6:]
members = {row['wallet']:row for row in snapshot['members']}
raw_addresses = {row['wallet'].lower():row['wallet'] for row in snapshot['directs'] + snapshot['miners'] + snapshot['activations']}
plans = {'1':('mini120', 2 * 10**15), '2':('pro1500', 5 * 10**16)}
miners = collections.defaultdict(list)
for row in snapshot['miners']:
    miners[(row['wallet'].lower(),row['plan'])].append(row)
qualifying = []
for row in snapshot['activations']:
    wallet = row['wallet'].lower()
    if wallet not in members or row['status'] != 'confirmed' or row['plan'] not in plans:
        continue
    if not row['confirmed_at'] or row['confirmed_at'] < snapshot['start_ms']:
        continue
    miner_plan, bnb_wei = plans[row['plan']]
    assert int(row['bnb_amount_wei']) == bnb_wei, row['id']
    assert len(miners[(wallet,miner_plan)]) == 1, row['id']
    assert row['block_number'] and row['tx_hash'], row['id']
    qualifying.append(row)
assert not snapshot['graph_anomalies']
assert len({(a['wallet'].lower(),a['plan']) for a in qualifying}) == len(qualifying)
qualified_by_wallet = collections.defaultdict(dict)
for row in qualifying:
    qualified_by_wallet[row['wallet'].lower()][row['plan']] = row
rows = []
for direct in snapshot['directs']:
    wallet = direct['wallet'].lower()
    if wallet == snapshot['excluded_branch']:
        continue
    branch_members = [row for row in members.values() if row['branch'] == wallet]
    acts = [row for row in qualifying if members[row['wallet'].lower()]['branch'] == wallet]
    personal = collections.Counter(a['plan'] for a in acts if a['wallet'].lower() == wallet)
    team = collections.Counter(a['plan'] for a in acts if a['wallet'].lower() != wallet)
    actual_miners = [m for m in snapshot['miners'] if m['wallet'].lower() in members and members[m['wallet'].lower()]['branch'] == wallet and m['started_at'] >= snapshot['start_ms'] and m['plan'] in ['mini120','pro1500']]
    rows.append({
        'wallet':direct['wallet'],'short':short(direct['wallet']), 'joined_at_beijing':time_text(direct['created_at']),
        'direct_mini':personal['1'],'direct_pro':personal['2'],'team_mini':team['1'],'team_pro':team['2'],
        'confirmed_count':len(acts),'team_members_excluding_direct':len(branch_members)-1,
        'confirmed_bnb':str(Decimal(sum(int(a['bnb_amount_wei']) for a in acts)) / Decimal(10**18)),
        'actual_miner_records':len(actual_miners),
    })
total_keys = ['direct_mini','direct_pro','team_mini','team_pro','confirmed_count','actual_miner_records','team_members_excluding_direct']
totals = {key:sum(row[key] for row in rows) for key in total_keys}
totals['mini'] = totals['direct_mini'] + totals['team_mini']
totals['pro'] = totals['direct_pro'] + totals['team_pro']
totals['confirmed_bnb'] = str(sum(Decimal(row['confirmed_bnb']) for row in rows))
assert totals['mini'] + totals['pro'] == totals['confirmed_count'] == len(qualifying)
exceptions = []
for row in snapshot['miners']:
    wallet = row['wallet'].lower()
    if wallet not in members or row['started_at'] < snapshot['start_ms'] or row['plan'] not in ['mini120','pro1500']:
        continue
    plan = '1' if row['plan'] == 'mini120' else '2'
    if plan not in qualified_by_wallet[wallet]:
        activation_rows = [a for a in snapshot['activations'] if a['wallet'].lower() == wallet and a['plan'] == plan]
        exceptions.append({'wallet':raw_addresses.get(wallet,wallet),'branch':raw_addresses.get(members[wallet]['branch'],members[wallet]['branch']), 'plan':row['plan'], 'started_at_beijing':time_text(row['started_at']), 'miner_status':row['status'], 'activation_statuses':[a['status'] for a in activation_rows], 'miner_id':row['id']})
assert totals['actual_miner_records'] - totals['confirmed_count'] == len(exceptions)
summary = {'root':snapshot['root'],'excluded_branch':snapshot['excluded_branch'],'start_beijing':snapshot['start_beijing'],'captured_at_beijing':snapshot['captured_at_beijing'],'branches':rows,'totals':totals,'exceptions':exceptions,'database_read_only':True}
(audit / 'summary.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2),encoding='utf-8')

capture = datetime.datetime.fromisoformat(snapshot['captured_at_beijing']).strftime('%Y-%m-%d %H:%M:%S')
lines = [
    '# 团队矿机激活统计', '',
    '查询地址：`' + snapshot['root'] + '`',
    '统计期间：北京时间 2026-10-06 00:00:00 至 ' + capture + '。',
    '排除分支：`' + snapshot['excluded_branch'] + '` 及其全部下级。查询地址本人不计入团队。', '',
    '统计口径：只统计已确认、金额为 0.002 BNB（Mini）或 0.05 BNB（Pro）、且存在对应矿机的激活记录；日期按激活确认时间筛选，不按加入时间。',
    '下级团队包含该直推的全部下级，不含该直推本人。每条分支合计 = 本人 + 下级团队，各分支互不重复。',
    '本次直接读取线上数据库，未修改账户、矿机、余额或推荐关系；未重新执行链上交易验证。', '',
    '## 分支汇总', '',
    '| 直推地址 | 加入时间（北京） | 本人 Mini | 本人 Pro | 下级 Mini | 下级 Pro | 已确认合计 | 对应 BNB |',
    '|---|---|---:|---:|---:|---:|---:|---:|',
]
for row in rows:
    lines.append('| ' + ' | '.join([row['wallet'],row['joined_at_beijing'],str(row['direct_mini']),str(row['direct_pro']),str(row['team_mini']),str(row['team_pro']),str(row['confirmed_count']),row['confirmed_bnb']]) + ' |')
lines += [
    '| **合计** | — | ' + ' | '.join(str(totals[key]) for key in ['direct_mini','direct_pro','team_mini','team_pro','confirmed_count']) + ' | ' + totals['confirmed_bnb'] + ' |', '',
    f"共 {len(rows)} 个直推、{totals['team_members_excluding_direct']} 个下级地址。Mini {totals['mini']} 台、Pro {totals['pro']} 台，共 {totals['confirmed_count']} 台已确认开通，对应套餐金额合计 {totals['confirmed_bnb']} BNB。", '',
    '## 矿机与激活记录差异', '',
    f"矿机表实际有 {totals['actual_miner_records']} 台，其中 {len(exceptions)} 台 Pro 的激活记录为 rejected（被拒绝），未计入上面的已确认激活业绩。它们全部位于 0x361852...134270 分支。该分支矿机表共 420 台，上面的已确认口径为 416 台。", '',
    '| 地址 | 矿机 | 矿机开始时间（北京） | 当前矿机状态 | 激活记录状态 |',
    '|---|---|---|---|---|',
]
for row in exceptions:
    lines.append('| ' + ' | '.join([row['wallet'],'Pro',row['started_at_beijing'],row['miner_status'],','.join(row['activation_statuses'])]) + ' |')
lines += ['', '## 各地址激活明细', '', '“—”表示没有符合本次统计条件的已确认激活记录。', '']
for row in rows:
    branch = row['wallet'].lower()
    lines += ['### ' + row['wallet'], '', '| 地址 | 推荐人 | 与查询地址的层级 | 加入时间（北京） | Mini 确认时间（北京） | Pro 确认时间（北京） | 已确认台数 |', '|---|---|---:|---|---|---|---:|']
    branch_members = sorted([m for m in members.values() if m['branch'] == branch], key=lambda m:(m['depth'],m['joined_at'],m['wallet']))
    for member in branch_members:
        acts = qualified_by_wallet[member['wallet']]
        cells = [raw_addresses.get(member['wallet'],member['wallet']),member['referrer_wallet'],str(member['depth']),time_text(member['joined_at']),time_text(acts.get('1',{}).get('confirmed_at')),time_text(acts.get('2',{}).get('confirmed_at')),str(len(acts))]
        lines.append('| ' + ' | '.join(cells) + ' |')
    lines.append('')
report = '\n'.join(lines) + '\n'
(audit / 'report.md').write_text(report,encoding='utf-8')
desktop = pathlib.Path('C:/Users/cy020/Desktop')
target = desktop / '团队矿机统计-7d1159-20261006起-20261012.md'
assert not target.exists(), 'Do not overwrite an existing report'
target.write_text(report,encoding='utf-8-sig')
print(json.dumps({'totals':totals,'branches':rows,'exceptions':exceptions,'report_path':str(target),'captured_at_beijing':capture},ensure_ascii=False,indent=2))
