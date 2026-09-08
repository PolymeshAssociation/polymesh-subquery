import { SubstrateBlock, SubstrateEvent } from '@subql/types';
import { ChainUpgrade } from '../../../types';
import { padId } from '../../../utils';
import { repairAuthorizationsAfterUpgrade } from '../identities/repairAuthorizations';
import { handleMultiSigProposalDeleted } from '../multiSig/mapMultiSigProposal';

/** Zero padded so `orderBy: id` on the table is numeric order over spec versions */
export const chainUpgradeId = (specVersion: number): string => padId(specVersion.toString());

/**
 * The most recently observed upgrade, or `undefined` before the first one is recorded.
 *
 * Ordering by `id` rather than `specVersionId` keeps the read on the primary key, and the two
 * agree because the id is the zero padded spec version.
 */
export const getLatestChainUpgrade = async (): Promise<ChainUpgrade | undefined> => {
  const [latest] = await store.getByFields<ChainUpgrade>('ChainUpgrade', [], {
    limit: 1,
    orderBy: 'id',
    orderDirection: 'DESC',
  });

  return latest;
};

/**
 * Runtime version of the block before this one, read from the chain.
 *
 * Only reached when the table is empty - the first upgrade a fresh index observes has nothing
 * persisted to compare against. `api.rpc.state.getRuntimeVersion` is block scoped, so passing the
 * parent hash asks for the version the chain ran under before the upgrade.
 */
const runtimeVersionBefore = async (block: SubstrateBlock) => {
  const runtimeVersion = await api.rpc.state.getRuntimeVersion(block.block.header.parentHash);

  return {
    specVersion: runtimeVersion.specVersion.toNumber(),
    transactionVersion: runtimeVersion.transactionVersion.toNumber(),
  };
};

export interface ChainUpgradeCrossing {
  previousSpecVersion: number;
  specVersion: number;
  previousTransactionVersion: number;
  transactionVersion: number;
  block: SubstrateBlock;
}

/**
 * Work that only makes sense to run once, at the boundary the chain crossed.
 *
 * Kept as a list so a later phase adds to it without touching the detection above.
 */
const onUpgradeCrossed = async (crossing: ChainUpgradeCrossing): Promise<void> => {
  const { previousTransactionVersion, transactionVersion, block } = crossing;

  if (transactionVersion === previousTransactionVersion) {
    logger.info('Transaction version was not changed for the chain upgrade');

    return;
  }

  logger.info(
    `Major chain upgrade found: transaction version ${previousTransactionVersion} -> ${transactionVersion}`
  );

  await handleMultiSigProposalDeleted(block);
  await repairAuthorizationsAfterUpgrade(block);
};

/**
 * Records the runtime upgrade a `system.CodeUpdated` announces, and runs the one off work that
 * belongs to the boundary it crossed.
 *
 * Upgrade detection used to sit in two module level variables seeded from the parent block. That
 * made it per process rather than per chain: under `--workers` every thread carried its own copy
 * and re-derived the baseline, and a restart re-ran the boundary work. Both now come from
 * `ChainUpgrade` rows, so detection is the same whichever thread sees the event and however many
 * times the block is replayed.
 */
export default async (substrateEvent: SubstrateEvent): Promise<void> => {
  const block = substrateEvent.block;
  const { specVersion } = block;
  const blockId = padId(block.block.header.number.toString());

  const latest = await getLatestChainUpgrade();

  if (latest?.specVersionId === specVersion) {
    logger.info(`Spec version ${specVersion} is already recorded; nothing to do at ${blockId}`);

    return;
  }

  const previous = latest
    ? { specVersion: latest.specVersionId, transactionVersion: latest.transactionVersion }
    : await runtimeVersionBefore(block);

  const runtimeVersion = await api.rpc.state.getRuntimeVersion();
  const transactionVersion = runtimeVersion.transactionVersion.toNumber();

  logger.info(
    `Chain upgrade at block ${blockId}: spec ${previous.specVersion} -> ${specVersion}, transaction version ${previous.transactionVersion} -> ${transactionVersion}`
  );

  await ChainUpgrade.create({
    id: chainUpgradeId(specVersion),
    specVersionId: specVersion,
    transactionVersion,
    firstBlockId: blockId,
    datetime: block.timestamp,
  }).save();

  if (previous.specVersion === specVersion) {
    return;
  }

  await onUpgradeCrossed({
    previousSpecVersion: previous.specVersion,
    specVersion,
    previousTransactionVersion: previous.transactionVersion,
    transactionVersion,
    block,
  });
};
