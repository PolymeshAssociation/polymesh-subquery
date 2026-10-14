import { EventRecord } from '@polkadot/types/interfaces';
import { AnyTuple } from '@polkadot/types-codec/types';
import { SubstrateBlock, SubstrateEvent, SubstrateExtrinsic } from '@subql/types';

/**
 * The block's event records, in block order.
 *
 * SubQuery types `block.events` with its own copy of `EventRecord`, which the webpack build treats
 * as a distinct declaration from `@polkadot/types`', so every consumer would otherwise need its own
 * cast. This is the one place that bridges them; the shapes are identical at runtime.
 */
export const blockEvents = (block: Pick<SubstrateBlock, 'events'>): EventRecord[] =>
  (block.events ?? []) as unknown as EventRecord[]; // the declaration clash above, nothing else

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

/**
 * An event's data as a plain tuple of codecs. `tsc` accepts the data as it is, but the webpack build
 * rejects it for the same declaration clash as above (the intersected `IEventData` carries a second
 * copy of the registry types), so this is the one place that bridges them.
 */
export const eventParams = (event: { event: { data: unknown } }): AnyTuple =>
  event.event.data as AnyTuple;
