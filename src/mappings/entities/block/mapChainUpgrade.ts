import { SubstrateBlock, SubstrateEvent } from '@subql/types';
import { ChainUpgrade } from '../../../types';
import { padId } from '../../../utils';
import { repairAuthorizationsAfterUpgrade } from '../identities/repairAuthorizations';
import { retireChildIdentitiesAtV8 } from '../identities/retireChildIdentities';
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
  /** The `system.CodeUpdated` event id — provenance for the rows the boundary work rewrites. */
  blockEventId: string;
}

/**
 * Work that only makes sense to run once, at the boundary the chain crossed.
 *
 * Kept as a list so a later phase adds to it without touching the detection above.
 */
const onUpgradeCrossed = async (crossing: ChainUpgradeCrossing): Promise<void> => {
  const { previousTransactionVersion, transactionVersion, block, blockEventId } = crossing;

  /**
   * Keyed on the spec version rather than the transaction version: what it repairs is a storage
   * migration, which is tied to the runtime release and not to the call encoding
   */
  await retireChildIdentitiesAtV8(crossing);

  if (transactionVersion === previousTransactionVersion) {
    logger.info('Transaction version was not changed for the chain upgrade');

    return;
  }

  logger.info(
    `Major chain upgrade found: transaction version ${previousTransactionVersion} -> ${transactionVersion}`
  );

  await handleMultiSigProposalDeleted(block, blockEventId);
  await repairAuthorizationsAfterUpgrade(block, blockEventId);
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
  const blockId = padId(block.block.header.number.toString());
  const blockEventId = `${blockId}/${padId(String(substrateEvent.idx ?? 0))}`;

  // `CodeUpdated` is emitted by the upgrade itself, so the block carrying it still ran under the
  // runtime being replaced: `block.specVersion` names the spec the chain is *leaving*. The new code
  // takes effect from the next block. The block-scoped runtime version is the state this block
  // leaves behind, so it is the one place both the new spec and its transaction version come from
  // the same runtime — reading the spec from the block instead recorded every upgrade one release
  // behind, beside the next release's transaction version, and ran the spec-keyed boundary work one
  // upgrade late.
  const runtimeVersion = await api.rpc.state.getRuntimeVersion();
  const specVersion = runtimeVersion.specVersion.toNumber();
  const transactionVersion = runtimeVersion.transactionVersion.toNumber();

  const latest = await getLatestChainUpgrade();

  if (latest?.specVersionId === specVersion) {
    logger.info(`Spec version ${specVersion} is already recorded; nothing to do at ${blockId}`);

    return;
  }

  const previous = latest
    ? { specVersion: latest.specVersionId, transactionVersion: latest.transactionVersion }
    : await runtimeVersionBefore(block);

  logger.info(
    `Chain upgrade at block ${blockId}: spec ${previous.specVersion} -> ${specVersion}, transaction version ${previous.transactionVersion} -> ${transactionVersion}`
  );

  await ChainUpgrade.create({
    id: chainUpgradeId(specVersion),
    specVersionId: specVersion,
    transactionVersion,
    firstBlockId: blockId,
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
    blockEventId,
  });
};
