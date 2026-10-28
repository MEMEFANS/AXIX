// Local simulation only. These records are not blockchain transactions or assets.
// Verification recomputes stored calculations; it does not authenticate a server.
export const STORAGE_KEY = 'hash-aix:local:v2';
export const VERSION = 1;
export const RULES = Object.freeze({
  betSeconds: 15,
  lockSeconds: 3,
  quickRevealMs: 1600,
  payoutMultiplier: 1.98,
  payoutNumerator: 198,
  payoutDenominator: 100,
  initialCredits: 1000,
  initialBalanceCents: 100000,
  refillBelowCredits: 100,
  minStake: 1,
  maxStake: 100,
  creditScale: 100,
  maxRecords: 100,
  seedBytes: 32,
  chance: .375,
  theoreticalReturn: .7425,
});

// 2026-10-28 规则改版（0、1、E、F 通杀）生效时刻：早于此时间结算的旧回合按旧规则（无通杀、各 50%）核验
export const LEGACY_RULES_UNTIL = 1793197200000;

const digits = Array.from({ length: 16 }, (_, value) => value);
export const CHOICES = Object.freeze([
  ['odd', '单', '末位是单数', digits.filter(value => value >= 2 && value <= 13 && value % 2 === 1)],
  ['even', '双', '末位是双数', digits.filter(value => value >= 2 && value <= 13 && value % 2 === 0)],
  ['small', '小', '末位落在小区间', digits.filter(value => value >= 2 && value <= 7)],
  ['big', '大', '末位落在大区间', digits.filter(value => value >= 8 && value <= 13)],
].map(([id, label, description, values]) => Object.freeze({
  id, label, description,
  digits: Object.freeze(values.map(value => value.toString(16))),
})));

const CHOICE_IDS = new Set(CHOICES.map(choice => choice.id));
const HEX = /^[a-f0-9]{64}$/;
const CLIENT_SEED = /^[A-Za-z0-9_.-]{1,64}$/;
const copy = value => JSON.parse(JSON.stringify(value));
const uint = value => Number.isSafeInteger(value) && value >= 0;
const signedInt = value => Number.isSafeInteger(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = error => ({ ok: false, error });
const validStakeCents = value => Number.isSafeInteger(value) && value >= RULES.minStake * 100 && value <= RULES.maxStake * 100 && value % 100 === 0;

function browserStorage() {
  try { return globalThis.localStorage || null; } catch { return null; }
}

function randomBytes(size) {
  const result = new Uint8Array(size);
  globalThis.crypto.getRandomValues(result);
  return result;
}

function hexBytes(bytes) {
  return Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
}

function emptyData() {
  return {
    version: VERSION,
    kind: 'local-simulation',
    revision: 0,
    balanceCents: RULES.initialBalanceCents,
    nonce: 0,
    clientSeed: 'AIX-starlight',
    pending: null,
    records: [],
    freeRefills: 0,
    refillCents: 0,
    stats: { rounds: 0, played: 0, observed: 0, wins: 0, losses: 0, stakedCents: 0, payoutCents: 0, netCents: 0 },
  };
}

export async function hashHex(text) {
  if (typeof text !== 'string') throw new TypeError('Hash input must be text.');
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return hexBytes(new Uint8Array(digest));
}

export function outcomeFromHash(hash) {
  if (typeof hash !== 'string' || !HEX.test(hash)) throw new TypeError('Expected a lowercase SHA-256 hash.');
  const hexDigit = hash.at(-1), digit = Number.parseInt(hexDigit, 16);
  // 0、1、E、F 为通杀区；有效区 2–D——每项恰中 6/16 = 37.5%
  return { digit, hexDigit, parity: digit % 2 ? 'odd' : 'even', size: digit >= 8 ? 'big' : 'small', live: digit >= 2 && digit <= 13 };
}

function winningChoice(choice, outcome) {
  return !!outcome.live && (choice === outcome.parity || choice === outcome.size);
}

function validBaseRound(round) {
  if (!object(round) || round.kind !== 'local-simulation' || round.version !== VERSION) return false;
  if (!uint(round.nonce) || round.nonce < 1 || typeof round.id !== 'string' || round.id.length > 100) return false;
  if (typeof round.seed !== 'string' || !HEX.test(round.seed) || typeof round.commitment !== 'string' || !HEX.test(round.commitment)) return false;
  if (round.id !== `local-${round.nonce}-${round.commitment.slice(0, 12)}`) return false;
  if (typeof round.clientSeed !== 'string' || !CLIENT_SEED.test(round.clientSeed)) return false;
  if (!['open', 'locked', 'revealed'].includes(round.status)) return false;
  if (!uint(round.createdAt)) return false;
  if (round.mode === 'quick') {
    if (round.status === 'open') {
      if (round.closesAt !== null || round.revealsAt !== null || round.choice !== null) return false;
    } else if (![round.closesAt, round.revealsAt].every(uint) || round.closesAt < round.createdAt || round.revealsAt - round.closesAt !== RULES.quickRevealMs) return false;
  } else {
    // v1 records without a mode retain their original 15 + 3 second schedule.
    if (round.mode !== undefined && round.mode !== 'timed') return false;
    if (![round.closesAt, round.revealsAt].every(uint)) return false;
    if (round.closesAt - round.createdAt !== RULES.betSeconds * 1000 || round.revealsAt - round.closesAt !== RULES.lockSeconds * 1000) return false;
  }
  if (round.choice === null) return round.stakeCents === 0;
  return CHOICE_IDS.has(round.choice) && validStakeCents(round.stakeCents);
}

function validRecordShape(record) {
  return validBaseRound(record) && record.status === 'revealed' && uint(record.revealedAt) && record.revealedAt >= record.revealsAt
    && typeof record.hash === 'string' && HEX.test(record.hash)
    && Number.isSafeInteger(record.digit) && record.digit >= 0 && record.digit <= 15
    && typeof record.hexDigit === 'string' && /^[a-f0-9]$/.test(record.hexDigit)
    && (typeof record.won === 'boolean' || record.won === null)
    && uint(record.payoutCents) && signedInt(record.netCents)
    && record.payoutMultiplier === RULES.payoutMultiplier;
}

export async function verifyRecord(record) {
  const result = { ok: false, mode: 'consistency-only', commitOk: false, hashOk: false, resultOk: false, payoutOk: false };
  if (!validRecordShape(record)) return { ...result, error: 'invalid-record' };
  const [commitment, hash] = await Promise.all([
    hashHex(record.seed),
    hashHex(`${record.seed}:${record.clientSeed}:${record.nonce}`),
  ]);
  const outcome = outcomeFromHash(hash);
  const won = record.choice === null ? null : winningChoice(record.choice, outcome);
  const payoutCents = won ? record.stakeCents * RULES.payoutNumerator / RULES.payoutDenominator : 0;
  result.commitOk = commitment === record.commitment;
  result.hashOk = hash === record.hash;
  result.resultOk = outcome.digit === record.digit && outcome.hexDigit === record.hexDigit && won === record.won;
  result.payoutOk = payoutCents === record.payoutCents && payoutCents - record.stakeCents === record.netCents;
  result.ok = result.commitOk && result.hashOk && result.resultOk && result.payoutOk;
  return { ...result, expectedHash: hash, expectedCommitment: commitment, expectedDigit: outcome.digit, expectedHexDigit: outcome.hexDigit, expectedPayoutCents: payoutCents };
}

// 服务端凭证验算（AIX 版，2026-10-28 改版）：字段口径与 /api/hash-aix 返回的 record 一致。
// 验算四件事：承诺一致（SHA256(serverSeed) === serverSeedHash）、开奖哈希一致
// （SHA256(serverSeed:clientSeed:nonce) === hash）、末位判定一致（0、1、E、F 通杀）、
// 1.98× 返还一致。旧回合（rule=1 或 createdAt 早于 LEGACY_RULES_UNTIL）按旧规则核验。
export async function verifyServerRecord(record) {
  const result = { ok: false, mode: 'server-proof', commitOk: false, hashOk: false, resultOk: false, payoutOk: false };
  const shape = object(record) && typeof record.serverSeed === 'string' && HEX.test(record.serverSeed)
    && typeof record.serverSeedHash === 'string' && HEX.test(record.serverSeedHash)
    && typeof record.hash === 'string' && HEX.test(record.hash)
    && typeof record.clientSeed === 'string' && CLIENT_SEED.test(record.clientSeed)
    && uint(record.nonce) && record.nonce >= 1
    && CHOICE_IDS.has(record.choice)
    && Number.isSafeInteger(record.digit) && record.digit >= 0 && record.digit <= 15
    && typeof record.hexDigit === 'string' && /^[a-f0-9]$/.test(record.hexDigit)
    && typeof record.won === 'boolean'
    && typeof record.stakeUnits === 'string' && /^\d+$/.test(record.stakeUnits)
    && typeof record.payoutUnits === 'string' && /^\d+$/.test(record.payoutUnits);
  if (!shape) return { ...result, error: 'invalid-record' };
  const [commitment, hash] = await Promise.all([
    hashHex(record.serverSeed),
    hashHex(`${record.serverSeed}:${record.clientSeed}:${record.nonce}`),
  ]);
  const outcome = outcomeFromHash(hash);
  const usesDeadZone = record.rule === 2 || (record.rule === undefined && !(typeof record.createdAt === 'number' && record.createdAt < LEGACY_RULES_UNTIL));
  const won = usesDeadZone
    ? winningChoice(record.choice, outcome)
    : record.choice === outcome.parity || record.choice === outcome.size;
  const expectedPayoutUnits = won ? BigInt(record.stakeUnits) * BigInt(RULES.payoutNumerator) / BigInt(RULES.payoutDenominator) : 0n;
  result.commitOk = commitment === record.serverSeedHash;
  result.hashOk = hash === record.hash;
  result.resultOk = outcome.digit === record.digit && outcome.hexDigit === record.hexDigit && won === record.won;
  result.payoutOk = expectedPayoutUnits === BigInt(record.payoutUnits);
  result.ok = result.commitOk && result.hashOk && result.resultOk && result.payoutOk;
  return { ...result, expectedHash: hash, expectedCommitment: commitment, expectedDigit: outcome.digit, expectedHexDigit: outcome.hexDigit };
}

async function readData(raw) {
  const data = JSON.parse(raw);
  if (!object(data) || data.version !== VERSION || data.kind !== 'local-simulation') throw new Error('Invalid local profile.');
  if (![data.revision, data.balanceCents, data.nonce, data.freeRefills, data.refillCents].every(uint)) throw new Error('Invalid totals.');
  if (!CLIENT_SEED.test(data.clientSeed) || typeof data.clientSeed !== 'string') throw new Error('Invalid client seed.');
  if (!Array.isArray(data.records) || data.records.length > RULES.maxRecords || !object(data.stats)) throw new Error('Invalid records.');
  const stats = data.stats;
  if (!['rounds', 'played', 'observed', 'wins', 'losses', 'stakedCents', 'payoutCents'].every(key => uint(stats[key])) || !signedInt(stats.netCents)) throw new Error('Invalid statistics.');
  if (stats.played !== stats.wins + stats.losses || stats.rounds !== stats.played + stats.observed || stats.netCents !== stats.payoutCents - stats.stakedCents) throw new Error('Inconsistent statistics.');
  if (data.records.length !== Math.min(stats.rounds, RULES.maxRecords)) throw new Error('Incomplete local history.');
  const confirmations = await Promise.all(data.records.map(record => verifyRecord(record)));
  if (confirmations.some(result => !result.ok)) throw new Error('Inconsistent round record.');
  for (let index = 0; index < data.records.length; index++) {
    if (data.records[index].nonce !== stats.rounds - index) throw new Error('Unexpected round order.');
  }
  if (new Set(data.records.map(record => record.id)).size !== data.records.length) throw new Error('Duplicate local round.');
  if (data.pending !== null) {
    if (!validBaseRound(data.pending) || data.pending.nonce !== data.nonce) throw new Error('Invalid current round.');
    if (await hashHex(data.pending.seed) !== data.pending.commitment) throw new Error('Current commitment is inconsistent.');
    if (data.pending.status === 'revealed') {
      if (stats.rounds !== data.nonce || !data.records[0] || JSON.stringify(data.pending) !== JSON.stringify(data.records[0])) throw new Error('Missing final round.');
    } else if (stats.rounds !== data.nonce - 1) throw new Error('Unexpected pending round.');
  } else if (data.nonce !== 0 || stats.rounds !== 0) throw new Error('Missing current round.');
  const heldCents = data.pending && data.pending.status !== 'revealed' ? data.pending.stakeCents : 0;
  if (data.balanceCents !== RULES.initialBalanceCents + data.refillCents + stats.payoutCents - stats.stakedCents - heldCents) throw new Error('Inconsistent local balance.');
  return copy(data);
}

export class HashSession {
  constructor({ storage = browserStorage(), now = Date.now, randomBytes: bytes = randomBytes } = {}) {
    this._storage = storage;
    this._now = now;
    this._bytes = bytes;
    this._data = emptyData();
    this._sourceRaw = null;
    this._memoryOnly = !storage;
    this._loaded = false;
    this._loadError = null;
    this._lastError = null;
    this._queue = Promise.resolve();
    this._busy = 0;
  }

  get data() { const data = copy(this._data); if (data.pending) data.pending.status = this.phase; return data; }
  get current() { const round = this._data.pending; return round ? { ...copy(round), status: this.phase } : null; }
  get phase() {
    if (!this._data.pending) return 'idle';
    if (this._data.pending.status === 'revealed') return 'revealed';
    if (this._data.pending.status === 'locked') return 'locked';
    if (this._data.pending.mode === 'quick') return 'open';
    return this._now() < this._data.pending.closesAt ? 'open' : 'locked';
  }
  get countdownMs() {
    if (!this._data.pending || ['idle', 'revealed'].includes(this.phase)) return 0;
    if (this._data.pending.mode === 'quick' && this.phase === 'open') return 0;
    const until = this.phase === 'open' ? this._data.pending.closesAt : this._data.pending.revealsAt;
    return Math.max(0, until - this._now());
  }
  get storageAvailable() { return !this._memoryOnly && Boolean(this._storage); }
  get loadError() { return this._loadError; }
  get lastError() { return this._lastError; }
  get busy() { return this._busy > 0; }
  get coordinationMode() { return this._memoryOnly ? 'memory' : globalThis.navigator?.locks?.request ? 'web-lock' : 'revision-check'; }

  _time() {
    const value = this._now();
    if (!uint(value) || value > Number.MAX_SAFE_INTEGER - 20000) throw new Error('clock-unavailable');
    return value;
  }

  _raw() {
    if (this._memoryOnly) return this._sourceRaw;
    try { return this._storage.getItem(STORAGE_KEY) ?? null; }
    catch { this._memoryOnly = true; return this._sourceRaw; }
  }

  async _sync() {
    const raw = this._raw();
    if (this._loaded && raw === this._sourceRaw) return !this._loadError;
    if (raw === null || raw === undefined) {
      // A different tab clearing existing data is a conflict, not an implicit refill.
      if (this._loaded && this._data.revision > 0 && !this._memoryOnly) { this._loadError = 'storage-changed'; return false; }
      this._data = emptyData(); this._sourceRaw = null; this._loaded = true; this._loadError = null; return true;
    }
    try { this._data = await readData(raw); this._loadError = null; }
    catch { this._loadError = 'stored-data-invalid'; }
    this._sourceRaw = raw; this._loaded = true;
    return !this._loadError;
  }

  _save(next) {
    if (!uint(next.balanceCents) || !uint(next.revision + 1)) return fail('balance-limit');
    if (!this._memoryOnly) {
      const latest = this._raw();
      if (!this._memoryOnly && latest !== this._sourceRaw) return fail('storage-conflict');
    }
    next.revision++;
    const raw = JSON.stringify(next);
    if (!this._memoryOnly) {
      try { this._storage.setItem(STORAGE_KEY, raw); }
      catch { this._memoryOnly = true; }
    }
    this._data = next; this._sourceRaw = raw; this._loadError = null;
    return { ok: true, saved: !this._memoryOnly };
  }

  _run(operation) {
    this._busy++;
    const task = this._queue.then(async () => {
      const work = async () => {
        if (!await this._sync()) return fail(this._loadError);
        return operation();
      };
      let result;
      try {
        const locks = !this._memoryOnly && globalThis.navigator?.locks;
        result = locks?.request ? await locks.request(`${STORAGE_KEY}:write`, { mode: 'exclusive' }, work) : await work();
      } catch (error) {
        result = fail(error.message === 'clock-unavailable' ? error.message : 'operation-unavailable');
      }
      this._lastError = result.ok ? null : result.error;
      return result;
    });
    this._queue = task.catch(() => {});
    return task.finally(() => { this._busy--; });
  }

  ready() { return this._run(() => ({ ok: true, restored: this._data.revision > 0, phase: this.phase })); }

  beginRound(mode = 'quick') {
    return this._run(async () => {
      if (!['quick', 'timed'].includes(mode)) return fail('invalid-mode');
      if (this._data.pending && this._data.pending.status !== 'revealed') return fail('round-active');
      if (this._data.nonce >= Number.MAX_SAFE_INTEGER - 1) return fail('round-limit');
      const bytes = this._bytes(RULES.seedBytes);
      if (!(bytes instanceof Uint8Array) || bytes.length !== RULES.seedBytes) return fail('random-unavailable');
      const seed = hexBytes(bytes), commitment = await hashHex(seed), createdAt = this._time();
      const next = copy(this._data), nonce = next.nonce + 1;
      next.nonce = nonce;
      next.pending = {
        version: VERSION, kind: 'local-simulation', mode,
        id: `local-${nonce}-${commitment.slice(0, 12)}`, nonce,
        clientSeed: next.clientSeed, seed, commitment,
        createdAt, closesAt: mode === 'quick' ? null : createdAt + RULES.betSeconds * 1000,
        revealsAt: mode === 'quick' ? null : createdAt + (RULES.betSeconds + RULES.lockSeconds) * 1000,
        choice: null, stakeCents: 0, status: 'open',
      };
      const result = this._save(next);
      return result.ok ? { ...result, round: this.current } : result;
    });
  }

  wager(choice, credits) {
    return this._run(() => {
      if (!CHOICE_IDS.has(choice)) return fail('invalid-choice');
      if (!Number.isSafeInteger(credits) || credits < RULES.minStake || credits > RULES.maxStake) return fail('invalid-stake');
      const round = this._data.pending;
      if (!round) return fail('no-round');
      const now = this._time();
      if (round.status !== 'open' || (round.mode !== 'quick' && now >= round.closesAt)) return fail('round-locked');
      if (round.mode === 'quick' && now < round.createdAt) return fail('clock-unavailable');
      if (round.choice !== null) return fail('already-entered');
      const stakeCents = credits * RULES.creditScale;
      if (stakeCents > this._data.balanceCents) return fail('insufficient-credits');
      const next = copy(this._data); next.balanceCents -= stakeCents;
      next.pending.choice = choice; next.pending.stakeCents = stakeCents;
      if (round.mode === 'quick') {
        next.pending.status = 'locked'; next.pending.closesAt = now;
        next.pending.revealsAt = now + RULES.quickRevealMs;
      }
      const result = this._save(next);
      return result.ok ? { ...result, round: this.current, balanceCents: this._data.balanceCents } : result;
    });
  }

  observe() {
    return this._run(() => {
      const round = this._data.pending;
      if (!round) return fail('no-round');
      if (round.choice !== null) return fail('already-entered');
      if (round.mode !== 'quick' || round.status !== 'open') return fail('round-locked');
      const now = this._time(), next = copy(this._data);
      if (now < round.createdAt) return fail('clock-unavailable');
      next.pending.status = 'locked'; next.pending.closesAt = now;
      next.pending.revealsAt = now + RULES.quickRevealMs;
      const result = this._save(next);
      return result.ok ? { ...result, round: this.current } : result;
    });
  }

  tick() {
    return this._run(async () => {
      const round = this._data.pending;
      if (!round || round.status === 'revealed') return { ok: true, phase: this.phase, revealed: false };
      if (round.mode === 'quick' && round.status === 'open') return { ok: true, phase: 'open', revealed: false };
      const now = this._time();
      if (now < round.closesAt) return { ok: true, phase: this.phase, revealed: false };
      if (now < round.revealsAt) {
        if (round.status === 'open') {
          const next = copy(this._data); next.pending.status = 'locked';
          const result = this._save(next); if (!result.ok) return result;
        }
        return { ok: true, phase: 'locked', revealed: false };
      }
      const hash = await hashHex(`${round.seed}:${round.clientSeed}:${round.nonce}`);
      const { digit, hexDigit, parity, size, live } = outcomeFromHash(hash);
      const won = round.choice === null ? null : winningChoice(round.choice, { parity, size, live });
      const payoutCents = won ? round.stakeCents * RULES.payoutNumerator / RULES.payoutDenominator : 0;
      const record = {
        ...copy(round), status: 'revealed', revealedAt: now,
        hash, digit, hexDigit, won, payoutCents,
        netCents: payoutCents - round.stakeCents,
        payoutMultiplier: RULES.payoutMultiplier,
      };
      const next = copy(this._data);
      next.balanceCents += payoutCents; next.pending = record;
      next.records.unshift(copy(record)); next.records = next.records.slice(0, RULES.maxRecords);
      next.stats.rounds++;
      if (record.choice === null) next.stats.observed++;
      else {
        next.stats.played++; next.stats[won ? 'wins' : 'losses']++;
        next.stats.stakedCents += record.stakeCents; next.stats.payoutCents += record.payoutCents;
        next.stats.netCents = next.stats.payoutCents - next.stats.stakedCents;
      }
      const result = this._save(next);
      return result.ok ? { ...result, phase: 'revealed', revealed: true, record: copy(record) } : result;
    });
  }

  setClientSeed(value) {
    return this._run(() => {
      if (typeof value !== 'string' || !CLIENT_SEED.test(value)) return fail('invalid-client-seed');
      if (value === this._data.clientSeed) return { ok: true, clientSeed: value };
      const next = copy(this._data); next.clientSeed = value;
      const result = this._save(next);
      return result.ok ? { ...result, clientSeed: value, appliesTo: 'next-round' } : result;
    });
  }

  refill() {
    return this._run(() => {
      const round = this._data.pending;
      if (round && round.status !== 'revealed' && round.choice !== null) return fail('round-active');
      if (this._data.balanceCents >= RULES.refillBelowCredits * 100) return fail('refill-not-needed');
      const next = copy(this._data), addedCents = RULES.initialBalanceCents - next.balanceCents;
      if (!uint(next.refillCents + addedCents) || !uint(next.freeRefills + 1)) return fail('balance-limit');
      next.balanceCents = RULES.initialBalanceCents; next.refillCents += addedCents; next.freeRefills++;
      const result = this._save(next);
      return result.ok ? { ...result, addedCents, balanceCents: next.balanceCents } : result;
    });
  }
}
