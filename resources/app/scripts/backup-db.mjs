// 每日数据库备份脚本（跨平台：Linux 生产 / Windows 本机均可运行）
//
// 原理：
//   1. 使用 SQLite `VACUUM INTO` 在线热备 —— 服务运行中也能跑，不锁库、不影响交易，
//      生成的目标文件是已合并 WAL 的一致性快照（崩溃也可恢复）；
//   2. 备份后立即打开副本执行 `PRAGMA integrity_check`，确认备份文件本身完好；
//   3. gzip 压缩保存，同时备份崩溃恢复账本 platform-ledger-transaction.json；
//   4. 自动清理超过保留天数的旧备份；
//   5. 任何一步失败：非 0 退出码 + 日志记录，cron / 任务计划可据此告警。
//
// 用法：
//   node scripts/backup-db.mjs [--keep=14] [--data-dir=<数据目录>] [--out=<备份目录>] [--no-gzip]
//
// 环境变量：
//   WG_DATA_DIR    服务数据目录（与 server 一致），默认 = 项目根目录
//   WG_BACKUP_DIR  备份输出目录，默认 = <数据目录>/backups
//
// Linux（cron，每天 03:17 执行，保留 14 天）：
//   17 3 * * * cd /opt/wg-app && WG_DATA_DIR=/var/lib/wg-data /usr/bin/node scripts/backup-db.mjs >> /var/log/wg-backup.log 2>&1
//
// Windows（任务计划程序，每天执行）：
//   程序: node   参数: scripts\backup-db.mjs   起始位置: 项目目录
//
// 重要：本地备份不等于容灾！请再把备份目录同步到异机/对象存储，例如：
//   rclone sync /var/lib/wg-data/backups remote:wg-backups --include "*.gz"
//
// 注意：.env 含热钱包私钥，本脚本故意不备份它，请用密码管理器/加密渠道单独妥善保管。

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DB_NAME = 'wg-platform.sqlite';
const LEDGER_NAME = 'platform-ledger-transaction.json';

// ── 参数解析 ──
const args = Object.fromEntries(
  process.argv.slice(2).map(a => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? true] : [null, a];
  }).filter(([k]) => k),
);
const dataDir = path.resolve(String(args['data-dir'] || process.env.WG_DATA_DIR || APP_ROOT));
const backupDir = path.resolve(String(args.out || process.env.WG_BACKUP_DIR || path.join(dataDir, 'backups')));
const keepDays = Number(args.keep ?? process.env.WG_BACKUP_KEEP ?? 14);
const useGzip = args.gzip !== false;

// ── 日志（同时输出到 stdout 和备份目录日志文件） ──
function ts() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}
function log(msg) {
  const line = `[${ts()}] ${msg}`;
  console.log(line);
  try {
    fs.mkdirSync(backupDir, { recursive: true });
    fs.appendFileSync(path.join(backupDir, 'backup.log'), `${line}\n`);
  } catch { /* 日志写盘失败不影响主流程 */ }
}

async function gzipFile(src, dest) {
  await pipeline(
    fs.createReadStream(src),
    zlib.createGzip({ level: 9 }),
    fs.createWriteStream(dest),
  );
}

// VACUUM INTO 的文件名需内联在 SQL 中，转义单引号防注入/路径异常
function sqlQuote(p) { return p.replaceAll("'", "''"); }

async function main() {
  const dbPath = path.join(dataDir, DB_NAME);
  if (!fs.existsSync(dbPath)) {
    log(`FAIL 数据库文件不存在: ${dbPath}（请确认 WG_DATA_DIR 是否正确）`);
    process.exit(2);
  }
  fs.mkdirSync(backupDir, { recursive: true });

  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-'); // YYYY-MM-DD-HHMMSS
  const tmpDb = path.join(backupDir, `.tmp-${stamp}.sqlite`);
  const outDb = path.join(backupDir, `wg-platform-${stamp}.sqlite${useGzip ? '.gz' : ''}`);
  const outLedger = path.join(backupDir, `ledger-${stamp}.json.gz`);

  let db;
  try {
    // 1) 在线热备：VACUUM INTO 生成一致性快照（WAL 模式下多连接并发打开安全）
    db = new DatabaseSync(dbPath);
    db.exec(`VACUUM INTO '${sqlQuote(tmpDb)}'`);
    db.close();
    db = null;
    log(`快照生成: ${path.basename(tmpDb)} (${(fs.statSync(tmpDb).size / 1024 / 1024).toFixed(2)} MB)`);

    // 2) 完整性校验：打开备份副本跑 integrity_check
    const verify = new DatabaseSync(tmpDb, { readOnly: true });
    const row = verify.prepare('PRAGMA integrity_check').get();
    const users = verify.prepare('SELECT COUNT(*) AS n FROM wallet_users').get();
    verify.close();
    const ok = String(Object.values(row || {})[0]) === 'ok';
    if (!ok) throw new Error(`integrity_check 未通过: ${JSON.stringify(row)}`);
    log(`完整性校验通过 (integrity_check=ok, 钱包账户 ${users.n} 个)`);

    // 3) 压缩入库
    if (useGzip) {
      await gzipFile(tmpDb, outDb);
      fs.rmSync(tmpDb, { force: true });
    } else {
      fs.renameSync(tmpDb, outDb.replace(/\.gz$/, ''));
    }
    log(`备份完成: ${path.basename(outDb)} (${(fs.statSync(outDb).size / 1024 / 1024).toFixed(2)} MB)`);

    // 4) 崩溃恢复账本（存在则一并备份，文件很小）
    const ledgerPath = path.join(dataDir, LEDGER_NAME);
    if (fs.existsSync(ledgerPath)) {
      await gzipFile(ledgerPath, outLedger);
      log(`账本日志已备份: ${path.basename(outLedger)}`);
    }

    // 5) 清理过期备份（数据库 + 账本；backup.log 不动）
    const cutoff = Date.now() - keepDays * 24 * 60 * 60 * 1000;
    let cleaned = 0;
    for (const f of fs.readdirSync(backupDir)) {
      if (!/^wg-platform-|\.sqlite|^ledger-/.test(f) || f === 'backup.log') continue;
      const fp = path.join(backupDir, f);
      try {
        if (fs.statSync(fp).mtimeMs < cutoff) { fs.rmSync(fp, { force: true }); cleaned++; }
      } catch { /* 单个清理失败不中断 */ }
    }
    log(`清理完成: 删除 ${cleaned} 个超过 ${keepDays} 天的旧备份`);
    log('OK 本次备份成功');
  } catch (err) {
    log(`FAIL 备份失败: ${err?.message || err}`);
    try { fs.rmSync(tmpDb, { force: true }); } catch { /* 忽略 */ }
    process.exit(1);
  } finally {
    try { db?.close(); } catch { /* 忽略 */ }
  }
}

main();
