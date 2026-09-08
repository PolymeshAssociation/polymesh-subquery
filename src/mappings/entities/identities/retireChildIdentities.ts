import { ChildIdentity } from '../../../types';
import { is8xSpecVersion } from '../../../utils';
import { ChainUpgradeCrossing } from '../block/mapChainUpgrade';

/** `store.getByFields` requires a limit, and the node rejects one above its query limit */
const PAGE_SIZE = 100;

/**
 * Every `ChildIdentity` row, read in pages over a total order.
 *
 * Read in full before anything is removed: paging by offset over a set that is shrinking under
 * the reader skips rows.
 */
const allChildIdentityIds = async (): Promise<string[]> => {
  const ids: string[] = [];
  let offset = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const page = await store.getByFields<ChildIdentity>('ChildIdentity', [], {
      limit: PAGE_SIZE,
      offset,
      orderBy: 'id',
      orderDirection: 'ASC',
    });

    ids.push(...page.map(({ id }) => id));

    if (page.length < PAGE_SIZE) {
      return ids;
    }

    offset += page.length;
  }
};

/**
 * Drops every `ChildIdentity` row when the chain crosses into 8.x.
 *
 * `v8.0.0:pallets/identity/src/migrations.rs` drains `ParentDid` and removes every `ChildDid` in
 * a storage migration that emits **no events**, and `ChildDidCreated` / `ChildDidUnlinked` do not
 * exist in the v8 runtime at all. An indexer cannot observe an absence, so without this the rows
 * survive forever asserting parent/child links the chain deleted (defect A11).
 *
 * This is still required under a full resync: the rows are written while indexing v5 to v7
 * blocks, and only stop being true at the upgrade block.
 *
 * Driven off the persisted `ChainUpgrade` comparison rather than a module level flag, so it is
 * decided the same way under `--workers` and across restarts.
 */
export const retireChildIdentitiesAtV8 = async ({
  previousSpecVersion,
  specVersion,
}: ChainUpgradeCrossing): Promise<void> => {
  if (is8xSpecVersion(previousSpecVersion) || !is8xSpecVersion(specVersion)) {
    return;
  }

  const ids = await allChildIdentityIds();

  logger.info(
    `Chain crossed into 8.x at spec ${specVersion}; retiring ${ids.length} ChildIdentity rows the v8 storage migration deleted without an event`
  );

  if (ids.length) {
    await store.bulkRemove('ChildIdentity', ids);
  }
};
