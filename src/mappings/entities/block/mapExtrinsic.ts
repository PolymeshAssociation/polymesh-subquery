import { SubstrateBlock, SubstrateExtrinsic } from '@subql/types';
import { CallIdEnum, Extrinsic, ModuleIdEnum } from '../../../types';
import { camelToSnakeCase, padId } from '../../../utils';

export function createExtrinsic(extrinsic: SubstrateExtrinsic): Extrinsic {
  const blockId = padId(extrinsic.block.block.header.number.toString());
  const extrinsicIdx = extrinsic.idx;
  const signedbyAddress = !extrinsic.extrinsic.signer.isEmpty;
  const address = signedbyAddress ? extrinsic.extrinsic.signer.toString() : null;
  const paramsTxt = JSON.stringify((extrinsic.extrinsic.toHuman() as any).method.args);

  return Extrinsic.create({
    id: `${blockId}/${extrinsicIdx}`,
    blockId,
    extrinsicIdx,
    extrinsicLength: extrinsic.extrinsic.length,
    signed: extrinsic.extrinsic.isSigned ? 1 : 0,
    moduleId: extrinsic.extrinsic.method.section.toLowerCase() as ModuleIdEnum,
    callId: camelToSnakeCase(extrinsic.extrinsic.method.method) as CallIdEnum,
    paramsTxt,
    success: extrinsic.success ? 1 : 0,
    signedbyAddress: signedbyAddress ? 1 : 0,
    address,
    nonce: extrinsic.extrinsic.nonce.toNumber(),
    extrinsicHash: extrinsic.extrinsic.hash.toJSON(),
    specVersionId: extrinsic.block.specVersion,
  });
}

export function wrapExtrinsics(wrappedBlock: SubstrateBlock): SubstrateExtrinsic[] {
  return wrappedBlock.block.extrinsics.map((extrinsic, idx) => {
    const events = wrappedBlock.events.filter(
      ({ phase }) => phase.isApplyExtrinsic && phase.asApplyExtrinsic.eqn(idx)
    );
    return {
      idx,
      extrinsic,
      block: wrappedBlock,
      events,
      success: events.findIndex(evt => evt.event.method === 'ExtrinsicSuccess') > -1,
    };
  });
}
