import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const JOURNAL_NAME = 'platform-ledger-transaction.json';

export function writeJsonAtomic(file, value) {
  const target = path.resolve(file);
  fs.mkdirSync(path.dirname(target), { recursive:true });
  const temp = `${target}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  let handle;
  try {
    handle = fs.openSync(temp, 'w');
    fs.writeFileSync(handle, JSON.stringify(value, null, 2), 'utf8');
    fs.fsyncSync(handle);
    fs.closeSync(handle);
    handle = null;
    fs.renameSync(temp, target);
    try {
      const directory = fs.openSync(path.dirname(target), 'r');
      try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
    } catch { /* directory fsync is not supported on every platform */ }
  } finally {
    if (handle !== undefined && handle !== null) fs.closeSync(handle);
    if (fs.existsSync(temp)) {
      try { fs.unlinkSync(temp); } catch { /* best effort cleanup */ }
    }
  }
}

function journalFile(dataRoot) {
  return path.join(path.resolve(dataRoot || '.'), JOURNAL_NAME);
}

function validateJournal(journal) {
  const walletValid = journal?.walletState?.users && typeof journal.walletState.users === 'object';
  const platformValid = journal?.platformState?.accounts && typeof journal.platformState.accounts === 'object';
  if (journal?.version !== 1 || !walletValid || !platformValid) {
    throw new Error('平台资金事务日志格式无效，已停止启动以保护账本');
  }
}

export function recoverLedgerTransaction(dataRoot) {
  const root = path.resolve(dataRoot || '.');
  const file = journalFile(root);
  if (!fs.existsSync(file)) return false;
  let journal;
  try {
    journal = JSON.parse(fs.readFileSync(file, 'utf8'));
    validateJournal(journal);
  } catch (error) {
    const backup = `${file}.corrupt-${Date.now()}`;
    try { fs.copyFileSync(file, backup); } catch { /* best effort */ }
    throw new Error(`无法恢复平台资金事务：${error?.message || error}`);
  }
  writeJsonAtomic(path.join(root, 'wallet-accounts.json'), journal.walletState);
  writeJsonAtomic(path.join(root, 'platform-accounts.json'), journal.platformState);
  fs.unlinkSync(file);
  return true;
}

export function commitLedgerStates(dataRoot, walletState, platformState) {
  const root = path.resolve(dataRoot || '.');
  const file = journalFile(root);
  writeJsonAtomic(file, {
    version:1,
    id:`txn_${crypto.randomBytes(8).toString('hex')}`,
    createdAt:new Date().toISOString(),
    walletState,
    platformState,
  });
  recoverLedgerTransaction(root);
}
