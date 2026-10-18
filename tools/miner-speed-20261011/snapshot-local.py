import pathlib
import sqlite3

root = pathlib.Path(__file__).resolve().parents[2]
source = root / 'resources/app/wg-platform.sqlite'
target = pathlib.Path(__file__).parent / 'benchmark-data/wg-platform.sqlite'
target.parent.mkdir(parents=True, exist_ok=True)
with sqlite3.connect(source.as_uri() + '?mode=ro', uri=True) as src:
    with sqlite3.connect(str(target)) as dst:
        src.backup(dst)
print('Created isolated snapshot for local performance verification')
