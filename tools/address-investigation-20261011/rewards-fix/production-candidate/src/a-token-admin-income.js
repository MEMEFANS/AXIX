import { formatAix, readAixIncome, readStakePayments, splitStakePayment } from './a-token-income.js';

// List limits only apply when presenting rows, never to cumulative amounts.
export function readAdminAixIncome(database, wallet) {
  const minerReleases = readAixIncome(database, wallet, 'miner');
  const rawStakes = database.listATokenStakes(wallet);
  const stakeRewards = readStakePayments(database, wallet, rawStakes);
  let interest = 0n, principal = 0n, credited = 0n;
  for (const row of stakeRewards) {
    interest += BigInt(row.interestUnits);
    principal += BigInt(row.principalUnits);
    credited += BigInt(row.amountUnits || '0');
  }
  const teamRows = readAixIncome(database, wallet, 'team');
  let teamTotal = 0n;
  const byKind = {};
  for (const row of teamRows) {
    const amount = BigInt(row.amountUnits || '0'), kind = row.kind || 'other';
    teamTotal += amount;
    byKind[kind] = (byKind[kind] || 0n) + amount;
  }
  return {
    minerReleases,
    minerTotalReleased:formatAix(minerReleases.reduce((sum, row) => sum + BigInt(row.amountUnits || '0'), 0n)),
    stakeRewards,
    stakes:{
      count:rawStakes.length, totalEarned:formatAix(interest),
      principalReturned:formatAix(principal), totalCredited:formatAix(credited),
      items:rawStakes.map(stake => {
        const payment = splitStakePayment(stake, stake.totalEarnedUnits);
        return { ...stake,
          principalUnits:formatAix(stake.principalUnits),
          totalEarnedUnits:formatAix(stake.totalEarnedUnits),
          dayEarnedUnits:formatAix(stake.dayEarnedUnits),
          interestEarnedUnits:formatAix(payment.interest),
          principalReturnedUnits:formatAix(payment.principal),
          outstandingPrincipalUnits:formatAix(payment.outstanding),
        };
      }),
    },
    teamRewards:{count:teamRows.length, total:formatAix(teamTotal),
      byKind:Object.fromEntries(Object.entries(byKind).map(([kind, amount]) => [kind, formatAix(amount)]))},
  };
}
