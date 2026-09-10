import { Codec } from '@polkadot/types/types';
import { AccountBalance } from '../types';
import { getBigIntValue } from '../utils';
import {
  accountDataFrozen,
  emptyBalance,
  ledgerAccount,
  recomputeDerived,
} from '../mappings/entities/identities/mapPolyxLedger';

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
    const data = (accountInfo as unknown as { data: Record<string, Codec> }).data;

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
    // A genesis freeze is recorded as a single lock so `frozen` stays a MAX going forward.
    balance.locks =
      frozen > BigInt(0) ? [{ lockId: 'genesis', amount: frozen, reasons: undefined }] : [];
    recomputeDerived(balance);

    rows.push(balance);
  }

  await Promise.all(rows.map(row => row.save()));

  logger.info(`Seeded ${rows.length} AccountBalance rows from system.account at ${blockId}`);

  return { seeded: rows.length };
};
