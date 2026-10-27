import pathlib,sqlite3,json,subprocess,datetime,zoneinfo,collections
r=pathlib.Path('/opt/wg-platform');tz=zoneinfo.ZoneInfo('Asia/Shanghai');now=datetime.datetime.now(tz);start=datetime.datetime(2026,10,19,tzinfo=tz);end=start+datetime.timedelta(days=1);cutoff=min(now,end)
c=sqlite3.connect('file:/var/lib/wg-platform/wg-platform.sqlite?mode=ro',uri=True)
rows=[json.loads(x[0]) for x in c.execute("select payload_json from a_token_activations where status='confirmed' and confirmed_at>=? and confirmed_at<? and plan in ('1','2')",(int(start.timestamp()*1000),int(cutoff.timestamp()*1000)))]
rows=[{'id':x['id'],'wallet':x['wallet'],'plan':str(x['plan']),'txHash':x['txHash'],'confirmedAt':x.get('confirmedAt'),'expectedTo':x.get('payload',{}).get('collectionAddress','')} for x in rows]
print(json.dumps({'start':start.isoformat(),'cutoff':cutoff.isoformat(),'rawCounts':dict(collections.Counter(x['plan'] for x in rows)),'rows':rows},ensure_ascii=False))
