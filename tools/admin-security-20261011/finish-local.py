import json
import pathlib

root = pathlib.Path(__file__).resolve().parents[2]
app = root / 'resources/app'
(app / 'public/withdraw-admin.html').write_text('''<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><meta http-equiv="refresh" content="0;url=/funds-admin.html"><title>AxiX 资金后台</title></head>
<body><p>提现审核与测试入账已移至<a href="/funds-admin.html">资金管理后台</a>。</p></body>
</html>
''', encoding='utf-8')
(app / 'public/js/withdraw-admin.js').write_text("// The former withdrawal console is now the unified funds console.\nwindow.location.replace('/funds-admin.html');\n", encoding='utf-8')
package = app / 'package.json'
data = json.loads(package.read_text(encoding='utf-8'))
data['scripts']['test:admin-security'] = 'node test/admin-security.test.js && node test/admin-security-browser.test.js'
package.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print('Replaced legacy withdrawal UI and added focused security test entry')
