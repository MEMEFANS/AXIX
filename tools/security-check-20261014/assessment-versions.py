import datetime, json, pathlib
root=pathlib.Path('/opt/wg-platform')
out={'captured_beijing':datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8))).isoformat(),'readonly':True,'dependencies':{},'directory_access':{}}
for package in ['undici','http-cache-semantics']:
    p=root/'node_modules'/package/'package.json'
    if p.is_file():
        d=json.loads(p.read_text());out['dependencies'][package]={'installed':True,'version':d.get('version')}
    else:out['dependencies'][package]={'installed':False}
for p in [pathlib.Path('/opt'),root]:
    s=p.stat();out['directory_access'][str(p)]={'mode':oct(s.st_mode & 0o777),'uid':s.st_uid,'gid':s.st_gid}
print(json.dumps(out,separators=(',',':')))
