import { Codec } from '@polkadot/types/types';
import { AccountBalance } from '../types';
import { getBigIntValue } from '../utils';
import {
  accountDataFrozen,
  applyChainFreezes,
  emptyBalance,
  readChainHolds,
} from '../mappings/entities/identities/mapPolyxLedger';
import { ledgerAccount } from '../utils/accounts';
import { readStakingLock } from '../utils/staking';

/**
 * Snapshots `system.account` into `AccountBalance` rows.
 *
 * The POLYX ledger derives every balance from events, so without an opening snapshot every
 * derived balance is wrong by the genesis allocation. `genesisHandler` seeds Accounts,
 * Identities and Portfolios but **no balances** — this fills that gap.
 *
 * Written as a domain seeder rather than inline in `genesisHandler` because plan
 * [10](../../docs/implementation/10-partial-index.md) needs the identical read at an arbitrary
 * `START_BLOCK`: `api.query` always targets the block being indexed, so the same call seeds
 * genesis when run from the genesis handler and block B when run from the partial-index seeder.
 */

export interface SeedContext {
  blockId: string;
  datetime: Date;
}

export const seedAccountBalances = async ({
  blockId,
  datetime,
}: SeedContext): Promise<{ seeded: number }> => {
  const entries = await api.query.system.account.entries();

  const rows: AccountBalance[] = [];

  for (const [key, accountInfo] of entries) {
    const address = key.args[0].toString();
    // The balance fields, not the account info around them: `frozen` is `miscFrozen`/`feeFrozen`
    // on older runtimes, so only this inner shape is read spec-agnostically.
    const data = accountInfo.data as unknown as Record<string, Codec>;

    const free = getBigIntValue(data.free);
    const reserved = getBigIntValue(data.reserved);
    const frozen = accountDataFrozen(data);

    if (free === BigInt(0) && reserved === BigInt(0) && frozen === BigInt(0)) {
      continue;
    }

    const account = await ledgerAccount(address, blockId, datetime);
    const balance = emptyBalance(address, account.identityId, blockId);

    balance.free = free;
    balance.reserved = reserved;

    /**
     * The seeded freeze used to go in wholesale under a `'genesis'` lock, which nothing ever
     * lowered (F7): `bonded` is derived from the `'staking '` lock, so a seeded staker's bond was
     * never reported as bonded, and because `frozen` is the MAX over locks the `'genesis'` entry
     * kept `frozen` pinned at the seeded amount even after the staker unbonded.
     *
     * Attributed from chain instead, the same way the reconciler's correction is. Which read
     * applies is decided by the chain itself: `balances.holds` only exists from v8, so an
     * `undefined` there *is* the pre-v8 signal, and only the unexplained remainder stays neutral.
     */
    const holds = reserved > BigInt(0) ? await readChainHolds(address) : undefined;
    const stakingLock =
      holds === undefined && frozen > BigInt(0)
        ? await readStakingLock(address, blockId)
        : undefined;

    applyChainFreezes(balance, { frozen, holds, stakingLock });

    rows.push(balance);
  }

  await Promise.all(rows.map(row => row.save()));

  logger.info(`Seeded ${rows.length} AccountBalance rows from system.account at ${blockId}`);

  return { seeded: rows.length };
};
