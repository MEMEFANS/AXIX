import base64, hashlib, json, pathlib, sqlite3, urllib.request
root = pathlib.Path('/opt/wg-platform')
data = pathlib.Path('/var/lib/wg-platform')
names = ['src/a-token-activation-service.js', 'src/a-token-team-service.js', 'src/database.js',
         'src/server.js', 'public/js/operator-admin.js', 'public/admin.html']
files = {name: {'sha256': hashlib.sha256((root/name).read_bytes()).hexdigest(),
                'base64': base64.b64encode((root/name).read_bytes()).decode()} for name in names}
with sqlite3.connect('file:' + str(data/'wg-platform.sqlite') + '?mode=ro', uri=True) as db:
    recent = [json.loads(row[0]) for row in db.execute("SELECT payload_json FROM a_token_activations WHERE plan='2' AND status='confirmed' ORDER BY created_at DESC LIMIT 150")]
with urllib.request.urlopen('http://127.0.0.1:8082/api/a-token/plans', timeout=10) as response:
    plans = json.load(response)
print(json.dumps({'files': files, 'reporting': json.loads((data/'pro-reporting-exclusions.json').read_text()),
                  'reportingSha256': hashlib.sha256((data/'pro-reporting-exclusions.json').read_bytes()).hexdigest(),
                  'recentPro': recent, 'plans': plans}))
