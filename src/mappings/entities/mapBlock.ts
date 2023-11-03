import { SubstrateBlock } from '@subql/types';
import { Block } from '../../types';
import genesisHandler from '../migrations/genesisHandler';
import migrationHandlers from '../migrations/migrationHandlers';
import { logError } from '../util';
import mapSubqueryVersion from './mapSubqueryVersion';

export const mapBlock = async (block: SubstrateBlock): Promise<Block> => {
  const header = block.block.header;
  const blockId = header.number.toNumber();
  const ss58Format = header.registry.chainSS58;

  /**
   * This handles the insertion of new SQ version on every restart
   */
  await mapSubqueryVersion().catch(e => logError(e));

  /**
   * This manages the insertion of all the genesis block data on processing block #1
   */
  if (blockId === 1) {
    await genesisHandler().catch(e => logError(e));
  }

  /**
   * In case some data needs to be migrated for newly added entities/attributes to any entity, this can be used
   */
  await migrationHandlers(blockId, ss58Format).catch(e => logError(e));

  const countExtrinsics = block.block.extrinsics.length;

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
