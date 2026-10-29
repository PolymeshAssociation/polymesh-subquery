import { EventRecord } from '@polkadot/types/interfaces';
import { SubstrateBlock, SubstrateEvent, SubstrateExtrinsic } from '@subql/types';

/** The block's event records, in block order; none when the block carries no list. */
export const blockEvents = (block: Pick<SubstrateBlock, 'events'>): EventRecord[] =>
  block.events ?? [];

/**
 * A block event record as the `SubstrateEvent` a handler receives, for code that walks a block's
 * records and wants the same decoding the handlers use.
 *
 * SubQuery's `SubstrateEvent` omits one key from the whole `EventRecord` struct, so it demands every
 * struct member as well; the object the runtime hands a handler is only these fields. Decoding reads
 * just these, which is why the literal is safe to present as one.
 */
export const substrateEventAt = (
  block: SubstrateBlock,
  idx: number,
  extrinsic?: SubstrateExtrinsic
): SubstrateEvent => {
  const record = blockEvents(block)[idx];

  return {
    phase: record.phase,
    event: record.event,
    topics: record.topics,
    idx,
    block,
    extrinsic,
  } as unknown as SubstrateEvent;
};
