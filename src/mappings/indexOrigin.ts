import { SubstrateBlock } from '@subql/types';
import { blockTime } from '../utils';
import { IndexOrigin } from '../types';

const ORIGIN_ID = 'origin';

/**
 * Records where the index started: the start block and the runtime that ran it, and the fields it
 * counts from there, such as lifetime totals, which are relative to the start block rather than
 * absolute. Written once, by the first block.
 */
export const writeIndexOrigin = (block: SubstrateBlock, relativeFields: string[]): Promise<void> =>
  IndexOrigin.create({
    id: ORIGIN_ID,
    startBlock: Number(block.block.header.number.toString()),
    startBlockHash: block.block.header.hash.toHex(),
    specVersion: block.specVersion,
    relativeFields,
    datetime: blockTime(block),
  }).save();
