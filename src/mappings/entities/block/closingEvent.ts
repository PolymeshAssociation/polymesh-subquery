import { SubstrateEvent, SubstrateExtrinsic } from '@subql/types';
import { extrinsicEventIndices } from '../../blockContext';
import { handleToolingEvent } from '../events/mapEvent';

/**
 * The event an extrinsic closes with — its `system.ExtrinsicSuccess` or `ExtrinsicFailed` — as an
 * indexed `Event`, for a write that has an extrinsic to answer to but no event of its own.
 *
 * Some state changes arrive with no event: a fee a runtime charged without announcing it, a
 * controller moved by `set_controller`. What they write still needs provenance, and provenance is a
 * relation to an `Event`, which must not point at a row that is not there. The closing event is the
 * natural owner — the change settles with the extrinsic — and nothing else writes to the ledger on
 * it, so entries keyed on it cannot collide with the call's own. It is not otherwise indexed, so it
 * is written here, once; writing the same row again is harmless.
 *
 * `undefined` when the block carries no events for the extrinsic, which a signed one always has.
 */
export const indexClosingEvent = async (
  extrinsic: SubstrateExtrinsic
): Promise<SubstrateEvent | undefined> => {
  const closing = closingEventOf(extrinsic);

  if (closing) {
    await handleToolingEvent(closing).save();
  }

  return closing;
};

/** The closing event as a `SubstrateEvent`, without indexing it — for deciding before writing. */
export const closingEventOf = (extrinsic: SubstrateExtrinsic): SubstrateEvent | undefined => {
  const records = (extrinsic.block.events ?? []) as unknown as SubstrateEvent[];
  const own = extrinsicEventIndices(extrinsic.block, extrinsic.idx);
  const closingIdx = own.at(-1);

  if (closingIdx === undefined) {
    return undefined;
  }

  return {
    phase: records[closingIdx].phase,
    event: records[closingIdx].event,
    topics: records[closingIdx].topics,
    idx: closingIdx,
    block: extrinsic.block,
    extrinsic,
  } as unknown as SubstrateEvent;
};
