// 哈希星盘 37.5% 规则测试（2026-10-28 改版）：
//   0、1、E、F 通杀（庄家通吃）；有效区 2–D：
//   单 = 3,5,7,9,B,D；双 = 2,4,6,8,A,C；小 = 2–7；大 = 8–D——每项 6/16 = 37.5%；
//   旧规则（50%，无通杀）下结算的历史记录仍按旧规则核验（rule=1 或 createdAt 早于 LEGACY_RULES_UNTIL）。
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { CHOICES, RULES, outcomeFromHash, verifyServerRecord, LEGACY_RULES_UNTIL } from '../public/games/hash-aix/core.js';

const sha256 = text => crypto.createHash('sha256').update(String(text)).digest('hex');
const pad = digit => `${'f'.repeat(63)}${digit}`;

// —— 赔率参数：1.98× 返还、37.5% 命中、理论返还率 74.25% ——
assert.equal(RULES.payoutMultiplier, 1.98);
assert.ok(Math.abs(RULES.chance - 0.375) < 1e-9);
assert.ok(Math.abs(RULES.theoreticalReturn - 0.7425) < 1e-9);

// —— 每个选项恰好 6 个命中数字，且全部落在有效区 2–D ——
for (const choice of CHOICES) {
  assert.equal(choice.digits.length, 6, `${choice.id} 应恰有 6 个命中数字（37.5%）`);
  for (const digit of choice.digits) {
    const value = Number.parseInt(digit, 16);
    assert.ok(value >= 2 && value <= 13, `${choice.id} 命中数字 ${digit} 不得落在通杀区 0/1/E/F`);
  }
}
const [odd, even, small, big] = CHOICES;
const liveSorted = [...odd.digits, ...even.digits].sort();
assert.deepEqual(liveSorted, [...Array(12)].map((_, i) => (i + 2).toString(16)).sort(), '单+双 应恰好覆盖 2–D');
assert.deepEqual([...small.digits, ...big.digits].sort(), liveSorted, '小+大 应恰好覆盖 2–D');

// —— 末位判定：通杀区 0/1/E/F 四项全输；有效区单双按奇偶、小 2–7、大 8–D ——
for (let value = 0; value < 16; value++) {
  const digit = value.toString(16);
  const outcome = outcomeFromHash(pad(digit));
  assert.equal(outcome.digit, value);
  assert.equal(outcome.hexDigit, digit);
  assert.equal(outcome.parity, value % 2 ? 'odd' : 'even');
  assert.equal(outcome.size, value >= 8 ? 'big' : 'small');
  assert.equal(outcome.live, value >= 2 && value <= 13);
}
const deadDigits = [0, 1, 14, 15];
for (const value of deadDigits) {
  const outcome = outcomeFromHash(pad(value.toString(16)));
  assert.equal(outcome.live, false, `末位 ${value.toString(16)} 属通杀区`);
  for (const choice of CHOICES) assert.equal(choice.digits.includes(outcome.hexDigit), false, `通杀区 ${outcome.hexDigit} 不得成为任何选项的命中数字`);
}

// —— 服务端凭证核验 ——
const serverSeed = 'aa'.repeat(32);
const serverSeedHash = sha256(serverSeed);
const STAKE = '1000000000000000000';   // 1 AIX
const PAYOUT = '1980000000000000000';  // 1.98 AIX
function roundWithLastDigit(char) {
  for (let nonce = 1; nonce < 10000; nonce++) {
    const clientSeed = 'AIX-starlight';
    const hash = sha256(`${serverSeed}:${clientSeed}:${nonce}`);
    if (hash.endsWith(char)) return { clientSeed, nonce, hash, digit: Number.parseInt(char, 16), hexDigit: char };
  }
  throw new Error(`找不到末位为 ${char} 的回合`);
}
const deadRound = roundWithLastDigit('0'); // 旧规则下 0 属于「小」，新规则通杀
const record = (round, choice, won, { rule, createdAt } = {}) => ({
  serverSeed, serverSeedHash, hash: round.hash, clientSeed: round.clientSeed, nonce: round.nonce,
  choice, digit: round.digit, hexDigit: round.hexDigit, won,
  stakeUnits: STAKE, payoutUnits: won ? PAYOUT : '0',
  ...(rule !== undefined ? { rule } : {}), ...(createdAt !== undefined ? { createdAt } : {}),
});

// 新规则：通杀区判负
const newLoss = await verifyServerRecord(record(deadRound, 'small', false, { rule: 2, createdAt: LEGACY_RULES_UNTIL + 1 }));
assert.ok(newLoss.ok, '新规则：末位 0 通杀，判负应核验通过');
const newLossOldStamp = await verifyServerRecord(record(deadRound, 'small', false, { createdAt: LEGACY_RULES_UNTIL + 1 }));
assert.ok(newLossOldStamp.ok, '新规则（按 createdAt 判定）：末位 0 通杀，判负应核验通过');
// 新规则：通杀区伪造命中 → 核验不通过
const fakeWin = await verifyServerRecord(record(deadRound, 'small', true, { rule: 2, createdAt: LEGACY_RULES_UNTIL + 1 }));
assert.equal(fakeWin.resultOk, false, '新规则：通杀区伪造命中应核验失败');
// 旧规则：0 属于小区间，判命中有效
const legacyWin = await verifyServerRecord(record(deadRound, 'small', true, { rule: 1, createdAt: LEGACY_RULES_UNTIL - 1 }));
assert.ok(legacyWin.ok, '旧规则：末位 0 属于小、判命中应核验通过');
const legacyWinNoRule = await verifyServerRecord(record(deadRound, 'small', true, { createdAt: LEGACY_RULES_UNTIL - 1 }));
assert.ok(legacyWinNoRule.ok, '旧规则（无 rule 字段的历史导出）：判命中应核验通过');

// 有效区：每个选项对全部 16 种末位的命中/未命中逐一核验
for (const choice of CHOICES) {
  for (let value = 0; value < 16; value++) {
    const expected = choice.digits.includes(value.toString(16));
    const round = roundWithLastDigit(value.toString(16));
    const result = await verifyServerRecord(record(round, choice.id, expected, { rule: 2, createdAt: LEGACY_RULES_UNTIL + 1 }));
    assert.ok(result.ok, `新规则：${choice.id} 末位 ${value.toString(16)}（应${expected ? '命中' : '未命中'}）核验失败`);
  }
}

console.log('hash-aix rules tests passed: 37.5%（6/16）命中、通杀区 0/1/E/F、旧记录旧规则核验');
