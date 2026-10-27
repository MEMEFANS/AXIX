import pathlib,json,sqlite3,hashlib,base64,collections
r=pathlib.Path('/opt/wg-platform');out={'files':{},'config':{}}
for f in ['src/a-token-team-service.js','src/a-token-admin-api.js','src/server.js','src/database.js','src/a-token-activation-service.js']:
 b=(r/f).read_bytes();out['files'][f]={'sha':hashlib.sha256(b).hexdigest(),'base64':base64.b64encode(b).decode()}
for line in pathlib.Path('/var/lib/wg-platform/.env').read_text().splitlines():
 if '=' in line:
  k,v=line.split('=',1)
  if k.startswith('A_TOKEN_ROTATION_'):out['config'][k]=v.strip()
c=sqlite3.connect('file:/var/lib/wg-platform/wg-platform.sqlite?mode=ro',uri=True);c.row_factory=sqlite3.Row
out['schemas']={x['name']:x['sql'] for x in c.execute("select name,sql from sqlite_master where name in ('platform_referral_links','a_token_miners','a_token_team_stats_overrides')")}
links=[json.loads(x[0]) for x in c.execute('select payload_json from platform_referral_links')]
children=collections.defaultdict(set)
for x in links:children[str(x.get('referrerWallet','')).lower()].add(str(x.get('wallet','')).lower())
rows=[json.loads(x[0]) for x in c.execute("select payload_json from a_token_activations where status='confirmed' and plan='2'")]
collection='0x0c89b9ddc29f3e4ac968a3e02611bd95a2df1361';rot=[x for x in rows if str(x.get('payload',{}).get('collectionAddress','')).lower()==collection]
miners=[json.loads(x[0]) for x in c.execute('select payload_json from a_token_miners')]
roots=['0x31f80338d1effe26fdf48b48aabfdbddd6f177bd','0x436252b4759eee30066a0d1101911caa7a63ccf2']
allMatched={};out['teams']={}
for root in roots:
 seen={root};stack=[root]
 while stack:
  for x in children[stack.pop()]:
   if x not in seen:seen.add(x);stack.append(x)
 seen.discard(root);matched=[x for x in rot if x['wallet'].lower() in seen]
 for x in matched:allMatched[x['id']]=x
 out['teams'][root]={'members':len(seen),'proWallets':len({x['wallet'].lower() for x in miners if x.get('plan')=='pro1500' and x['wallet'].lower() in seen}),'matchedActivations':len(matched),'matchedWallets':len({x['wallet'].lower() for x in matched}),'matchedDirects':len({x['wallet'].lower() for x in matched if x['wallet'].lower() in children[root]}),'override':[dict(x) for x in c.execute('select * from a_token_team_stats_overrides where wallet=? collate nocase',(root,))]}
out['matched']=list(allMatched.values());out['rotationProTotal']=len(rot);out['deduplicatedMatched']=len(allMatched)
out['minerCounts']=[dict(x) for x in c.execute('select plan,status,count(*) count from a_token_miners group by plan,status')]
print(json.dumps(out,ensure_ascii=False))
