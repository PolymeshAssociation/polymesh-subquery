import { SubstrateExtrinsic } from '@subql/types';
import { CallIdEnum, Extrinsic, ModuleIdEnum } from '../../../types';
import { camelToSnakeCase, padId } from '../../../utils';
import { toEnum } from '../common';

export function createExtrinsic(extrinsic: SubstrateExtrinsic): Extrinsic {
  const blockId = padId(extrinsic.block.block.header.number.toString());
  const extrinsicIdx = extrinsic.idx;
  const extrinsicId = `${blockId}/${padId(extrinsicIdx.toString())}`;
  const signedbyAddress = !extrinsic.extrinsic.signer.isEmpty;
  const address = signedbyAddress ? extrinsic.extrinsic.signer.toString() : null;
  const paramsTxt = JSON.stringify((extrinsic.extrinsic.toHuman() as any).method.args);
  const moduleId = extrinsic.extrinsic.method.section.toLowerCase();
  const callId = camelToSnakeCase(extrinsic.extrinsic.method.method);

  return Extrinsic.create({
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
}
