import json
import pathlib
import shutil

root = pathlib.Path(__file__).resolve().parents[2]
app = root / 'resources/app'
path = app / 'test/social-security.test.js'
backup = root / 'tools/admin-security-20261011/before/test/social-security.test.js'
backup.parent.mkdir(parents=True, exist_ok=True)
shutil.copy2(path, backup)
data = path.read_bytes()
text = data.decode('utf-8').replace('\r\n', '\n')
start = text.index('// Exercise the actual preview click handler')
end = text.index("const address='0x'", start)
text = text[:start] + '// Historical screenshot rendering is verified in admin-security-browser.test.js.\n' + text[end:]
text = text.replace("import fs from 'node:fs';\n", '').replace("import vm from 'node:vm';\n", '')
text = text.replace('historical preview blocked, raster preview works, ', '')
path.write_bytes(text.replace('\n', '\r\n').encode('utf-8') if b'\r\n' in data else text.encode('utf-8'))
package = app / 'package.json'
data = json.loads(package.read_text(encoding='utf-8'))
data['scripts']['test:admin-security'] = 'node test/social-security.test.js && node test/admin-security.test.js && node test/admin-security-browser.test.js'
package.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print('Moved obsolete popup mock coverage to actual sandbox browser test; retained all frozen-wallet regressions')
