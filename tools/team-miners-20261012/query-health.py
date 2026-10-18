import datetime
import json
import pathlib
import sqlite3
import time

out = {'utc':datetime.datetime.now(datetime.timezone.utc).isoformat(), 'db_exists':pathlib.Path('/opt/wg-platform/wg-platform.sqlite').is_file()}
start = time.monotonic()
db = sqlite3.connect('file:/opt/wg-platform/wg-platform.sqlite?mode=ro', uri=True, timeout=3)
db.execute('PRAGMA query_only=ON')
out['referral_count'] = db.execute('SELECT count(*) FROM platform_referral_links').fetchone()[0]
out['elapsed_seconds'] = time.monotonic() - start
db.close()
print(json.dumps(out))
