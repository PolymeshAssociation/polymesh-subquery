import { SubstrateBlock } from '@subql/types';
import { Block } from '../../../types';
import { blockTime, padId } from '../../../utils';

export const mapBlock = (block: SubstrateBlock): Block => {
  const header = block.block.header;
  const blockId = header.number.toNumber();
  const extrinsics = block.block.extrinsics ?? [];
  const countExtrinsics = extrinsics.length;
  const countExtrinsicsSigned = extrinsics.filter(({ isSigned }) => isSigned).length;
  const outcomes = (method: string): number =>
    block.events.filter(({ event }) => event.section === 'system' && event.method === method)
      .length;

  return Block.create({
    id: `${padId(blockId.toString())}`,
    blockId,
    parentId: blockId - 1,
    hash: header.hash.toHex(),
    parentHash: header.parentHash.toHex(),
    stateRoot: header.stateRoot.toHex(),
    extrinsicsRoot: header.extrinsicsRoot.toHex(),
    countExtrinsics,
    countExtrinsicsUnsigned: countExtrinsics - countExtrinsicsSigned,
    countExtrinsicsSigned,
    countExtrinsicsSuccess: outcomes('ExtrinsicSuccess'),
    countExtrinsicsError: outcomes('ExtrinsicFailed'),
    countEvents: block.events.length,
    datetime: blockTime(block),
    specVersionId: block.specVersion,
  });
};
