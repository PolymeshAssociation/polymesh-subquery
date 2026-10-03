import { Codec } from '@polkadot/types/types';
import { SEED_EVENT_ID } from '../mappings/consts';
import { AccountBalance } from '../types';
import { getBigIntValue, is8xSpecVersion } from '../utils';
import {
  accountDataFrozen,
  applyChainFreezes,
  emptyBalance,
  PIPS_LOCK_ID,
  readChainHolds,
  readChainLock,
  readChainStakingLock,
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
  /**
   * The runtime the seed is read under. Which chain reads apply — and what an absent `holds` means —
   * depends on the era, so it is passed in rather than inferred from which reads happen to answer.
   */
  specVersion: number;
}

/** How many accounts are seeded at once: a partial index can open on a chain of many accounts. */
const SEED_BATCH = 100;

/** `run` over `items`, `size` at a time, in order. */
const inBatches = async <T, R>(
  items: T[],
  size: number,
  run: (item: T) => Promise<R>
): Promise<R[]> => {
  const batches = Array.from({ length: Math.ceil(items.length / size) }, (_, index) =>
    items.slice(index * size, (index + 1) * size)
  );

  return batches.reduce<Promise<R[]>>(
    async (done, batch) => [...(await done), ...(await Promise.all(batch.map(run)))],
    Promise.resolve([])
  );
};

/**
 * The chain's account of what `address` has frozen and held, as `applyChainFreezes` takes it.
 *
 * The seeded freeze used to go in wholesale under a `'genesis'` lock, which nothing ever lowered:
 * `bonded` is derived from the `'staking '` lock, so a seeded staker's bond was never reported as
 * bonded, and because `frozen` is the MAX over locks the `'genesis'` entry kept `frozen` pinned at
 * the seeded amount even after the staker unbonded. Attributed from chain instead, the same way
 * the reconciler's correction is.
 */
const chainFreezes = async (
  address: string,
  { reserved, frozen }: { reserved: bigint; frozen: bigint },
  { blockId, specVersion }: SeedContext
) => {
  const is8x = is8xSpecVersion(specVersion);

  // `holds` exists only from v8, so an absent value must mean exactly that. Reading it only when
  // something was reserved made a v8 account with nothing reserved look pre-v8 and sent its freeze
  // through the pre-v8 lock reads. On v8, nothing reserved means nothing held — an empty list, not
  // an unknown one — and the era decides every branch below, not whether a read answered.
  let holds: Awaited<ReturnType<typeof readChainHolds>> | undefined;
  if (is8x) {
    holds = reserved > BigInt(0) ? await readChainHolds(address) : [];
  }

  if (frozen <= BigInt(0)) {
    return { frozen, holds, stakingLock: undefined, pipsLock: undefined };
  }

  // A start block inside the two-pass v8 lock → hold migration still sees the old staking lock,
  // so on v8 it is read from the lock list rather than assumed away. Pre-v8 only: a v8 pips
  // deposit is tracked through the generic `Locked` / `Unlocked`.
  const [stakingLock, pipsLock] = is8x
    ? [await readChainStakingLock(address), undefined]
    : await Promise.all([readStakingLock(address, blockId), readChainLock(address, PIPS_LOCK_ID)]);

  return { frozen, holds, stakingLock, pipsLock };
};

/** One account's opening balance, or `undefined` for an account holding nothing. */
const seedBalance = async (
  address: string,
  accountInfo: unknown,
  context: SeedContext
): Promise<AccountBalance | undefined> => {
  // The balance fields, not the account info around them: `frozen` is `miscFrozen`/`feeFrozen`
  // on older runtimes, so only this inner shape is read spec-agnostically.
  const data = (accountInfo as unknown as { data: Record<string, Codec> }).data;

  const free = getBigIntValue(data.free);
  const reserved = getBigIntValue(data.reserved);
  const frozen = accountDataFrozen(data);

  if (free === BigInt(0) && reserved === BigInt(0) && frozen === BigInt(0)) {
    return undefined;
  }

  // Seeded rows have no causing event, so both the account and its balance carry the seed
  // marker rather than a bare block id in an `Event` foreign key.
  const account = await ledgerAccount(address, context.blockId, context.datetime, SEED_EVENT_ID);
  const balance = emptyBalance(address, account.identityId, SEED_EVENT_ID);

  balance.free = free;
  balance.reserved = reserved;
  applyChainFreezes(balance, await chainFreezes(address, { reserved, frozen }, context));

  return balance;
};

export const seedAccountBalances = async (context: SeedContext): Promise<{ seeded: number }> => {
  const entries = await api.query.system.account.entries();

  const seeded = await inBatches(entries, SEED_BATCH, ([key, accountInfo]) =>
    seedBalance(key.args[0].toString(), accountInfo, context)
  );
  const rows = seeded.filter((row): row is AccountBalance => row !== undefined);

  await Promise.all(rows.map(row => row.save()));

  logger.info(
    `Seeded ${rows.length} AccountBalance rows from system.account at ${context.blockId}`
  );

  return { seeded: rows.length };
};
