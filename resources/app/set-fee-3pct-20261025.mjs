// 批量把指定钱包地址的 AIX 交易手续费覆盖为 3%（300 bps）
// 写入 service_settings.a_token_fee_overrides，实时读取、无需重启
import { openDatabase } from './src/database.js';

const KEY = 'a_token_fee_overrides';
const BPS = 300;

const ADDRESSES = [
  '0x431905ce2fa37962102d0c60896ff84f56f45826',
  '0xb0fc5c6f327a0f97157a4f3716f002c5ec0da879',
  '0xcd8bb03e98f84831f2c972727d7c29b01a029132',
  '0xfe428167b264ee20ccca4af3f16730c82c0e7e10',
  '0x06c838cf25d80bb5d4387860932ce4daf55915dd',
  '0xedb7602e7552bf394c51c25ba7f7f78c9b99534f',
  '0x1d58bfd88d6ffea0848b72598478e5376d979c7c',
  '0x7b276223ce28899cc248a9f80d3f4ca292ea546a',
  '0x2d01681743daee3daa7edc4743602399c8944f8d',
  '0xbc0a192e26f0b664b4e40423bd3aec86d8b2d460',
  '0x4133393e0ac0cdd344c732b9c97fec39e20ad960',
  '0x9891c1a1e1418f4823cd8716e32232d2e000c238',
  '0xc62cc085725b489d785aac6b8fafee5db1fc75d5',
  '0x024b0e656a755afd400972bf96b2da7d9f73e938',
  '0xb278bd2043c34241e8019d05a74686abad074866',
  '0xe1240c0b64d4d37ca3727bdbccec86547b8035ff',
  '0x71ee735083bf3c5fbdb63110ed522b1d2596a308',
  '0x3d23d1af7967ab93ea71cc34464c8159933add1e',
  '0xcebf5b628e4f0e77e4851ffb08118417e84acad8',
  '0xf9b68c22dde3903956901e8c4a9e41c38fb12b50',
  '0xcc78dfd3f1cf084fe504627a67cbd5cdcd4518fb',
  '0x6a760e7715dcb1f4a1ca14c4a7f37e4a2f369152',
  '0xb86e8601a309294cd7afedadf47f1dee824eedd9',
];

const dataRoot = process.env.WG_DATA_DIR || '/var/lib/wg-platform';
const db = openDatabase(dataRoot);

const raw = db.getSetting(KEY);
let cfg = {};
try { cfg = JSON.parse(raw || '{}') || {}; } catch { cfg = {}; }
if (!cfg.wallets || typeof cfg.wallets !== 'object') cfg.wallets = {};

const before = Object.keys(cfg.wallets).length;
const bad = [];
for (const addr of ADDRESSES) {
  const k = String(addr).trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(k)) { bad.push(addr); continue; }
  cfg.wallets[k] = BPS;
}
db.saveSetting(KEY, JSON.stringify(cfg));

console.log('非法/跳过的地址:', bad.length ? bad : '无');
console.log('写入前已配置地址数:', before);
console.log('写入后已配置地址数:', Object.keys(cfg.wallets).length);
console.log('本次清单地址数:', ADDRESSES.length);
console.log('--- 当前全部覆盖配置 ---');
console.log(JSON.stringify(cfg, null, 2));
