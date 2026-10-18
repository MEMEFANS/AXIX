import pathlib, difflib, json, hashlib, shutil

app = pathlib.Path('resources/app')
root = pathlib.Path('tools/address-investigation-20261011/rewards-fix')
candidate = root / 'production-candidate'
names = ['src/platform-service.js','src/server.js','src/a-token-income.js','src/a-token-revenue-service.js','public/js/operator-admin.js']
manifest = {'files':[], 'note':'Exact changes only; production files retain all existing production-only logic.'}
for name in names:
    before = (root / 'local-before' / name).read_text(encoding='utf-8').splitlines(keepends=True)
    after = (app / name).read_text(encoding='utf-8').splitlines(keepends=True)
    prod_bytes = (root / 'production-before' / name).read_bytes()
    prod = prod_bytes.decode('utf-8').replace('\r\n','\n')
    # Each diff group carries two unchanged lines to anchor insertions safely.
    patches = []
    for group in difflib.SequenceMatcher(None,before,after,autojunk=False).get_grouped_opcodes(2):
        first,last = group[0],group[-1]
        old = ''.join(before[first[1]:last[2]])
        new = ''.join(after[first[3]:last[4]])
        if prod.count(old)!=1:
            raise RuntimeError(f'{name}: patch anchor is not unique ({prod.count(old)})')
        patches.append({'old':old,'new':new})
        prod = prod.replace(old,new,1)
    output = candidate / name; output.parent.mkdir(parents=True,exist_ok=True)
    data = prod.encode('utf-8'); output.write_bytes(data)
    manifest['files'].append({'path':name,'before_sha256':hashlib.sha256(prod_bytes).hexdigest(), 'after_sha256':hashlib.sha256(data).hexdigest(),'patches':patches})
    review = root / 'review' / (name.replace('/','_')+'.diff'); review.parent.mkdir(parents=True,exist_ok=True)
    review.write_text(''.join(difflib.unified_diff(prod_bytes.decode('utf-8').splitlines(keepends=True),prod.splitlines(keepends=True),fromfile='production/'+name,tofile='candidate/'+name)),encoding='utf-8')
name = 'src/a-token-admin-income.js'
output = candidate / name; output.parent.mkdir(parents=True,exist_ok=True); shutil.copyfile(app/name,output)
manifest['files'].append({'path':name,'before_sha256':None,'after_sha256':hashlib.sha256(output.read_bytes()).hexdigest(),'new_file':True})
(root/'patch-manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps({'prepared_files':[f['path'] for f in manifest['files']]},ensure_ascii=False))
