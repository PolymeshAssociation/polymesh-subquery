import { SEED_EVENT_ID } from '../mappings/consts';
import { getOrCreatePosition } from '../mappings/entities/events/mapStakingPosition';
import { ledgerSnapshot } from '../utils/staking';

type LedgerJson = Parameters<typeof ledgerSnapshot>[0] & { stash?: string };

/**
 * A `StakingPosition` for every ledger in chain state.
 *
 * Stashes bonded by a chain's genesis config emit no `Bonded`, and positions are otherwise only
 * created by one, so a genesis staker that never bonded or unbonded again had no position. The
 * ledger is keyed by controller before v8, so each one is filed under the stash it names.
 */
export const seedStakingPositions = async ({
  blockId,
  datetime,
}: {
  blockId: string;
  datetime: Date;
}): Promise<{ seeded: number }> => {
  const entries = await api.query.staking.ledger.entries();
  const ledgers = entries
    .map(([key, value]) => {
      const ledger = value.toJSON() as LedgerJson | null;
      return { ledger, stash: ledger?.stash ?? key.args[0]?.toString() };
    })
    .filter((entry): entry is { ledger: LedgerJson; stash: string } =>
      Boolean(entry.ledger && entry.stash)
    );

  await Promise.all(
    ledgers.map(async ({ ledger, stash }) => {
      const snapshot = ledgerSnapshot(ledger);
      const position = await getOrCreatePosition(
        stash,
        blockId,
        datetime,
        SEED_EVENT_ID,
        undefined
      );

      position.bonded = snapshot.active;
      position.unbonding = snapshot.total - snapshot.active;
      position.unlocking = snapshot.unlocking.map(chunk => ({
        ...chunk,
        amount: chunk.amount.toString(),
      }));

      await position.save();
    })
  );

  return { seeded: ledgers.length };
};
