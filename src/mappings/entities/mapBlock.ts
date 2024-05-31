import { SubstrateBlock } from '@subql/types';
import { Block } from '../../types';

export const mapBlock = (block: SubstrateBlock): Block => {
  const header = block.block.header;
  const blockId = header.number.toNumber();
  const countExtrinsics = block.block.extrinsics?.length;

  return Block.create({
    id: `${blockId}`,
    blockId,
    parentId: blockId - 1,
    hash: header.hash.toHex(),
    parentHash: header.parentHash.toHex(),
    stateRoot: header.stateRoot.toHex(),
    extrinsicsRoot: header.extrinsicsRoot.toHex(),
    countExtrinsics,
    countExtrinsicsUnsigned: 0,
    countExtrinsicsSigned: 0,
    countExtrinsicsSuccess: 0,
    countExtrinsicsError: 0,
    countEvents: block.events.length,
    datetime: block.timestamp,
    specVersionId: block.specVersion,
  });
};
