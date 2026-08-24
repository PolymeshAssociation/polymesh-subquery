import { SubstrateExtrinsic } from '@subql/types';
import { CallIdEnum, EvmTransaction, Extrinsic, ModuleIdEnum } from '../../../types';
import {
  ResolvedEthTransact,
  camelToSnakeCase,
  evmAddressFromSs58,
  getOrCreateAccount,
  getSignerAddress,
  isEthTransact,
  padId,
  resolveEthTransact,
} from '../../../utils';
import { toEnum } from '../common';
import { upsertEvmAccountMapping } from '../revive/mapEvmAccountMapping';

export function createExtrinsic(extrinsic: SubstrateExtrinsic): Extrinsic {
  const blockId = padId(extrinsic.block.block.header.number.toString());
  const extrinsicIdx = extrinsic.idx;
  const extrinsicId = `${blockId}/${padId(extrinsicIdx.toString())}`;
  const signedbyAddress = !extrinsic.extrinsic.signer.isEmpty;
  const address = signedbyAddress ? extrinsic.extrinsic.signer.toString() : null;
  const paramsTxt = JSON.stringify((extrinsic.extrinsic.toHuman() as any).method.args);
  const moduleId = extrinsic.extrinsic.method.section.toLowerCase();
  const callId = camelToSnakeCase(extrinsic.extrinsic.method.method);

  const created = Extrinsic.create({
    id: extrinsicId,
    blockId,
    extrinsicIdx,
    extrinsicLength: extrinsic.extrinsic.length,
    signed: extrinsic.extrinsic.isSigned ? 1 : 0,
    moduleId: toEnum(ModuleIdEnum, moduleId, ModuleIdEnum.unknown),
    moduleIdText: moduleId,
    callId: toEnum(CallIdEnum, callId, CallIdEnum.unknown),
    callIdText: callId,
    paramsTxt,
    success: extrinsic.success ? 1 : 0,
    signedbyAddress: signedbyAddress ? 1 : 0,
    address,
    nonce: extrinsic.extrinsic.nonce.toNumber(),
    extrinsicHash: extrinsic.extrinsic.hash.toJSON(),
    specVersionId: extrinsic.block.specVersion,
  });

  const resolved = isEthTransact(extrinsic) ? resolveEthTransact(extrinsic) : undefined;

  if (resolved) {
    /**
     * `eth_transact` is included as an unsigned extrinsic wrapping an Ethereum transaction, so
     * `signed` stays 0. The attribution and the call that actually ran are recovered from the
     * payload and recorded as if they had been dispatched directly
     */
    created.address = resolved.fromAddress;
    created.ethAddress = resolved.fromEthAddress;
    created.ethTxHash = resolved.ethTxHash;
    created.moduleId = toEnum(ModuleIdEnum, resolved.moduleId, ModuleIdEnum.unknown);
    created.moduleIdText = resolved.moduleId;
    created.callId = toEnum(CallIdEnum, resolved.callId, CallIdEnum.unknown);
    created.callIdText = resolved.callId;
    created.paramsTxt = resolved.paramsTxt;
    created.nonce = Number(resolved.tx.nonce);
    created.success = extrinsic.success && !resolved.reverted ? 1 : 0;
  }

  return created;
}

const createEvmTransaction = (
  extrinsic: SubstrateExtrinsic,
  resolved: ResolvedEthTransact
): Promise<void> => {
  const blockId = padId(extrinsic.block.block.header.number.toString());
  const extrinsicId = `${blockId}/${padId(extrinsic.idx.toString())}`;
  const { tx } = resolved;

  return EvmTransaction.create({
    id: extrinsicId,
    extrinsicId,
    blockId,
    ethTxHash: resolved.ethTxHash,
    ethTxType: tx.txType,
    callKind: resolved.callKind,
    fromEthAddress: resolved.fromEthAddress,
    fromAddress: resolved.fromAddress,
    toEthAddress: tx.to,
    contractAddress: resolved.contractAddress,
    value: tx.value.toString(),
    ethNonce: tx.nonce,
    gasLimit: tx.gasLimit.toString(),
    gasPrice: tx.gasPrice?.toString(),
    maxFeePerGas: tx.maxFeePerGas?.toString(),
    maxPriorityFeePerGas: tx.maxPriorityFeePerGas?.toString(),
    chainId: tx.chainId?.toString(),
    input: tx.data,
    reverted: resolved.reverted,
    revertReason: resolved.revertReason,
    datetime: extrinsic.block.timestamp,
    createdBlockId: blockId,
    updatedBlockId: blockId,
  }).save();
};

/**
 * `revive.mapAccount` and `revive.unmapAccount` emit no event of their own, so the mapping they
 * maintain can only be picked up from the extrinsic itself
 */
const handleEvmAccountMapping = async (extrinsic: SubstrateExtrinsic): Promise<void> => {
  const address = getSignerAddress(extrinsic);
  const evmAddress = evmAddressFromSs58(address, extrinsic.extrinsic.registry.chainSS58);

  if (!evmAddress) {
    return;
  }

  return upsertEvmAccountMapping({
    evmAddress,
    address,
    mapped: camelToSnakeCase(extrinsic.extrinsic.method.method) === 'map_account',
    datetime: extrinsic.block.timestamp,
    blockId: padId(extrinsic.block.block.header.number.toString()),
  });
};

const isAccountMappingCall = (extrinsic: SubstrateExtrinsic): boolean => {
  if (extrinsic.extrinsic.method.section !== 'revive' || !extrinsic.success) {
    return false;
  }
  const callId = camelToSnakeCase(extrinsic.extrinsic.method.method);

  return callId === 'map_account' || callId === 'unmap_account';
};

/**
 * Persists the extrinsic, along with the decoded Ethereum transaction it carried and any EVM
 * account mapping it registered
 */
export const handleExtrinsic = async (extrinsic: SubstrateExtrinsic): Promise<void> => {
  await createExtrinsic(extrinsic).save();

  if (isEthTransact(extrinsic)) {
    const resolved = resolveEthTransact(extrinsic);

    if (resolved) {
      // `EvmTransaction` references the extrinsic, so it has to be written after it
      await createEvmTransaction(extrinsic, resolved);

      /**
       * Only indexes the sender once it is attached to an Identity, as with every other account
       */
      await getOrCreateAccount(
        resolved.fromAddress,
        padId(extrinsic.block.block.header.number.toString()),
        extrinsic.block.timestamp
      );
    }
  } else if (isAccountMappingCall(extrinsic)) {
    await handleEvmAccountMapping(extrinsic);
  }
};
