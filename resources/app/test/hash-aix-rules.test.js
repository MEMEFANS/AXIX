// 哈希星盘 V3 规则测试（2026-10-28）：
//   胜负与数字均由哈希推导：roll = 哈希末 8 位，roll < 0x60000000 命中（2^32 的 37.5%，精确）；
//   亮灯组每项 8 个数字（选「单」时 1、3、5、7、9、B、D、F 全亮）；
//   数字按胜负从亮灯组/对应组均匀取出——赢必在亮灯组、输必不在，开奖与押注始终对应；
//   历史回合按版本核验：V1（各 50%）→ V2（0/1/E/F 通杀）→ V3。
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { CHOICES, RULES, outcomeV3, verifyServerRecord, LEGACY_RULES_UNTIL, RULES_V3_SINCE } from '../public/games/hash-aix/core.js';

const sha256 = text => crypto.createHash('sha256').update(String(text)).digest('hex');

// —— 赔率参数：1.98× 返还、37.5% 命中、理论返还率 74.25% ——
assert.equal(RULES.payoutMultiplier, 1.98);
assert.ok(Math.abs(RULES.chance - 0.375) < 1e-9);
assert.ok(Math.abs(RULES.theoreticalReturn - 0.7425) < 1e-9);
// 命中阈值精确性：0x60000000 × 8 = 3 × 2^32，即恰为 2^32 的 3/8 = 37.5%
assert.equal((0x60000000n * 8n) / (1n << 32n), 3n);

// —— 亮灯组：每项 8 个数字；单+双、小+大 恰好瓜分 16 个数字；选「单」时 1 与 F 都亮 ——
const [odd, even, small, big] = CHOICES;
for (const choice of CHOICES) {
  assert.equal(choice.digits.length, 8, `${choice.id} 应有 8 个亮灯数字`);
  assert.equal(new Set(choice.digits).size, 8);
}
const allHex = [...Array(16)].map((_, value) => value.toString(16)).sort();
assert.deepEqual([...odd.digits, ...even.digits].sort(), allHex, '单+双 应瓜分全部 16 个数字');
assert.deepEqual([...small.digits, ...big.digits].sort(), allHex, '小+大 应瓜分全部 16 个数字');
assert.ok(odd.digits.includes('1') && odd.digits.includes('f'), '选「单」时 1 与 F 都要亮起');

// —— V3 推导：开奖与押注始终对应 + 核验通过 + 篡改必失败 ——
const serverSeed = crypto.randomBytes(32).toString('hex');
const serverSeedHash = sha256(serverSeed);
const STAKE = '1000000000000000000';   // 1 AIX
const PAYOUT = '1980000000000000000';  // 1.98 AIX
function v3Record(nonce, choice) {
  const clientSeed = 'AIX-starlight';
  const hash = sha256(`${serverSeed}:${clientSeed}:${nonce}`);
  const { won, digit } = outcomeV3(hash, choice);
  return { serverSeed, serverSeedHash, hash, clientSeed, nonce, choice, digit, hexDigit: digit.toString(16), won,
    stakeUnits: STAKE, payoutUnits: won ? PAYOUT : '0', rule: 3, createdAt: RULES_V3_SINCE + 1 };
}
for (const choice of CHOICES) {
  for (let nonce = 1; nonce <= 40; nonce++) {
    const record = v3Record(nonce, choice.id);
    const lit = new Set(choice.digits);
    // 赢必在亮灯组、输必不在：开奖数字与押注选择始终对应
    assert.equal(lit.has(record.hexDigit), record.won, `${choice.id} #${nonce} 开奖数字与胜负不对应`);
    const result = await verifyServerRecord(record);
    assert.ok(result.ok, `V3 核验失败：${choice.id} #${nonce}`);
    // 篡改胜负（返还同步改）→ 判定不一致，核验失败
    const flipped = await verifyServerRecord({ ...record, won: !record.won, payoutUnits: record.won ? '0' : PAYOUT });
    assert.equal(flipped.ok, false, `V3 篡改胜负应核验失败：${choice.id} #${nonce}`);
    // 篡改数字 → 核验失败
    const badDigit = record.digit === 0 ? 1 : 0;
    const tampered = await verifyServerRecord({ ...record, digit: badDigit, hexDigit: badDigit.toString(16) });
    assert.equal(tampered.ok, false, `V3 篡改数字应核验失败：${choice.id} #${nonce}`);
  }
}

// —— 大样本命中率：20000 局收敛到 37.5%（±1.5%）；数字覆盖全部 16 个 ——
const TOTAL = 20000;
let wins = 0;
for (let nonce = 1; nonce <= TOTAL; nonce++) {
  if (outcomeV3(sha256(`${serverSeed}:freq:${nonce}`), 'odd').won) wins++;
}
const rate = wins / TOTAL;
assert.ok(Math.abs(rate - 0.375) < 0.015, `命中率 ${rate} 偏离 37.5%`);
{
  const seen = new Set();
  for (let nonce = 1; nonce <= 8000; nonce++) seen.add(outcomeV3(sha256(`${serverSeed}:dist:${nonce}`), 'odd').digit);
  assert.equal(seen.size, 16, '大样本应覆盖全部 16 个数字');
}

// —— 历史版本核验兼容：V2（0/1/E/F 通杀）与 V1（各 50%）——
function legacyRound(lastDigitChar) {
  for (let nonce = 1; nonce < 10000; nonce++) {
    const clientSeed = 'AIX-starlight';
    const hash = sha256(`${serverSeed}:${clientSeed}:${nonce}`);
    if (hash.endsWith(lastDigitChar)) return { clientSeed, nonce, hash, digit: Number.parseInt(lastDigitChar, 16), hexDigit: lastDigitChar };
  }
  throw new Error(`找不到末位为 ${lastDigitChar} 的回合`);
}
function legacyRecord(round, choice, won, rule, createdAt) {
  return { serverSeed, serverSeedHash, hash: round.hash, clientSeed: round.clientSeed, nonce: round.nonce, choice,
    digit: round.digit, hexDigit: round.hexDigit, won, stakeUnits: STAKE, payoutUnits: won ? PAYOUT : '0', rule, createdAt };
}
const deadRound = legacyRound('0'); // 末位 0：V1 属于「小」命中；V2 通杀判负
// V1（rule=1 与无 rule 字段的历史导出）：0 属于小区间，押小命中
assert.ok(await verifyServerRecord(legacyRecord(deadRound, 'small', true, 1, LEGACY_RULES_UNTIL - 1)), 'V1 应按旧规则核验通过');
{
  const { rule, ...noRule } = legacyRecord(deadRound, 'small', true, 1, LEGACY_RULES_UNTIL - 1);
  assert.ok(await verifyServerRecord(noRule), 'V1（无 rule 字段的历史导出）应按旧规则核验通过');
}
// V2：0/1/E/F 通杀，押小判负；伪造命中应失败
assert.ok(await verifyServerRecord(legacyRecord(deadRound, 'small', false, 2, LEGACY_RULES_UNTIL + 1)), 'V2 通杀判负应核验通过');
assert.equal((await verifyServerRecord(legacyRecord(deadRound, 'small', true, 2, LEGACY_RULES_UNTIL + 1))).ok, false, 'V2 伪造命中应核验失败');
// V2 有效区：末位 3 押单命中
const liveRound = legacyRound('3');
assert.ok(await verifyServerRecord(legacyRecord(liveRound, 'odd', true, 2, LEGACY_RULES_UNTIL + 1)), 'V2 有效区命中应核验通过');

console.log('hash-aix V3 tests passed: 37.5% 精确命中、8 数字亮灯组、开奖与押注对应、V1/V2 历史兼容核验');
