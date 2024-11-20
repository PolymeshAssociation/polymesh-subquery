import { SubstrateEvent } from '@subql/types';
import { handleMultiSigProposalDeleted } from '../multiSig/mapMultiSigProposal';

let transactionVersion = 0;
let oldSpecVersion = 3000;

/**
 * This method helps handling some entity data on chain upgrades
 */
export default async (substrateEvent: SubstrateEvent): Promise<void> => {
  const specVersion = substrateEvent.block.specVersion;

  if (oldSpecVersion !== specVersion) {
    logger.info(
      `Checking for transaction version after chain spec version upgrade from "${oldSpecVersion}" to "${specVersion}"`
    );

    const runtimeVersion = await api.rpc.state.getRuntimeVersion();
    const txVersion = runtimeVersion.transactionVersion.toNumber();

    logger.info(
      `Current runtime transaction version - ${transactionVersion}. New runtime tx version - ${txVersion}`
    );

    if (txVersion !== transactionVersion) {
      logger.info(`Major chain upgrade found with transaction version upgraded `);
      await handleMultiSigProposalDeleted(substrateEvent.block);
      transactionVersion = txVersion;
    } else {
      logger.info(`Transaction version was not changed for the chain upgrade`);
    }

    oldSpecVersion = specVersion;
  }
};
