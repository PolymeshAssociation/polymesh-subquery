import { SubstrateBlock } from '@subql/types';
import { SEED_EVENT_ID } from '../mappings/consts';
import { mapBlock } from '../mappings/entities/block/mapBlock';
import { writeIndexOrigin } from '../mappings/indexOrigin';
import { ArgumentsJson, Block, Event, EventIdEnum, ModuleIdEnum } from '../types';
import { blockTime, padId } from '../utils/common';
import { relativeFields, seed, SeedReport } from './seeder';
import { SEEDERS } from './seeders';
import { accountRows } from './seeders/identities';
import { snapshotAtParent } from './snapshot';

/** The genesis block's id, which a genesis index's seeded rows point at */
const GENESIS_BLOCK_ID = padId('0');

/** The genesis block, which no block handler maps */
const insertGenesisBlock = (datetime: Date, specVersion: number): Promise<void> =>
  Block.create({
    id: GENESIS_BLOCK_ID,
    blockId: 0,
    parentId: 0,
    hash: chainId,
    parentHash: '',
    specVersionId: specVersion,
    datetime,
    countEvents: 0,
    countExtrinsics: 0,
    countExtrinsicsError: 0,
    countExtrinsicsSigned: 0,
    countExtrinsicsSuccess: 0,
    countExtrinsicsUnsigned: 0,
    extrinsicsRoot: '',
    stateRoot: '',
  }).save();

/** The one synthetic seed `Event`, every seeded row's provenance */
const insertSeedEvent = (blockId: string, specVersion: number): Promise<void> =>
  Event.create({
    id: SEED_EVENT_ID,
    blockId,
    eventIdx: 0,
    specVersionId: specVersion,
    moduleId: ModuleIdEnum.seeding,
    moduleIdText: 'seeding',
    eventId: EventIdEnum.Seeded,
    eventIdText: 'Seeded',
    args: {} as ArgumentsJson,
  }).save();

/**
 * Whether the runtime that executed `block`'s parent is this block's, so the state the block began
 * from is one its registry reads. That runtime is the one the grandparent's state names. A fresh
 * index has recorded no upgrade to tell it, so this asks the chain.
 */
const parentRanThisRuntime = async (block: SubstrateBlock): Promise<boolean> => {
  const parent = await api.rpc.chain.getHeader(block.block.header.parentHash);
  const ran = await api.rpc.state.getRuntimeVersion(parent.parentHash);
  return ran.specVersion.toNumber() === api.runtimeVersion.specVersion.toNumber();
};

/**
 * Starts an index at `block`: seeds every entity from the chain state the block began from, then
 * leaves the block's own events to the handlers, as any block's. Genesis is the start block 1,
 * whose rows point at the genesis block.
 *
 * The first block after a runtime upgrade can't start an index: the state it began from was written
 * by the previous runtime, which its registry can't read.
 */
export const startIndex = async (block: SubstrateBlock): Promise<SeedReport[]> => {
  const number = Number(block.block.header.number.toString());
  const genesis = number <= 1;
  if (!genesis && !(await parentRanThisRuntime(block))) {
    throw new Error(
      `START_BLOCK can't be seeded: block ${number} is the first after a runtime upgrade, so the state it began from was written by the previous runtime; start at the next block`
    );
  }

  const blockId = genesis ? GENESIS_BLOCK_ID : padId(String(number));
  const datetime = blockTime(block);
  logger.info(`Seeding the index from chain storage as block ${number} began`);

  // the block and the seed Event exist before anything points a relation at them
  await (genesis ? insertGenesisBlock(datetime, block.specVersion) : mapBlock(block).save());
  await insertSeedEvent(blockId, block.specVersion);

  const report = await seed(
    snapshotAtParent(block),
    { block, blockId, eventId: SEED_EVENT_ID, datetime, specVersion: block.specVersion },
    { seeders: SEEDERS, accountRows }
  );
  await writeIndexOrigin(block, relativeFields(SEEDERS));

  logger.info(`Seeded the index: ${report.reduce((rows, entity) => rows + entity.rows, 0)} rows`);
  return report;
};
