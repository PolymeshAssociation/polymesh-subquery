import { SubstrateEvent } from '@subql/types';
import { handleMultiSigProposalDeleted } from '../multiSig/mapMultiSigProposal';

let oldTxVersion = 0;
let oldSpecVersion = 3000;

/**
 * This method helps handling some entity data on chain upgrades
 */
export default async (substrateEvent: SubstrateEvent): Promise<void> => {
  const specVersion = substrateEvent.block.specVersion;

  /**
   * When SQ is started for the first time or the SQ restarts after a crash,
   * the transaction version gets reset to 0 and spec version to 3000, forcing to check for chain upgrade.
   *
   * Hence, we need to get the transaction version and spec version from the parent block.
   */
  if (oldTxVersion === 0) {
    const currentBlockId = substrateEvent.block.block.header.number.toNumber();
    logger.info(
      `No transaction version found, getting it from parent block. Current block id: ${currentBlockId}`
    );

    const parentBlockHash = substrateEvent.block.block.header.parentHash;

    const runtimeVersion = await api.rpc.state.getRuntimeVersion(parentBlockHash);

    oldSpecVersion = runtimeVersion.specVersion.toNumber();
    oldTxVersion = runtimeVersion.transactionVersion.toNumber();

    logger.info(
      `Details for parent block <${
        currentBlockId - 1
      }> - Spec version: <${oldSpecVersion}>. Transaction version: <${oldTxVersion}>`
    );
  }

  if (oldSpecVersion !== specVersion) {
    logger.info(
      `Checking for transaction version after chain spec version upgrade from "${oldSpecVersion}" to "${specVersion}"`
    );

    const runtimeVersion = await api.rpc.state.getRuntimeVersion();
    const txVersion = runtimeVersion.transactionVersion.toNumber();

    logger.info(
      `Current runtime transaction version - ${oldTxVersion}. New runtime tx version - ${txVersion}`
    );

    if (txVersion !== oldTxVersion) {
      logger.info(`Major chain upgrade found with transaction version upgraded `);
      await handleMultiSigProposalDeleted(substrateEvent.block);
      oldTxVersion = txVersion;
    } else {
      logger.info(`Transaction version was not changed for the chain upgrade`);
    }

    oldSpecVersion = specVersion;
  }
};
