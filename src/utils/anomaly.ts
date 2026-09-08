import { SubstrateBlock } from '@subql/types';
import { AnomalyKind, EventIdEnum, IndexerAnomaly, ModuleIdEnum } from '../types';
import { padId } from './common';

export interface AnomalyInput {
  kind: AnomalyKind;
  /** What was expected against what was seen. Read by a human reviewing the table, so be specific */
  detail: string;
  block: SubstrateBlock;
  /** Index of the event the anomaly is attributable to. Omitted for block level anomalies */
  eventIdx?: number;
  moduleId?: ModuleIdEnum;
  eventId?: EventIdEnum;
  /**
   * When set, only the first anomaly carrying this key is written by this process.
   *
   * The acceptance criterion for this table is "review every distinct `(kind, moduleId,
   * eventId)`", so a value the chain emits a million times is worth exactly one row. Callers on
   * an unbounded path - an enum member the schema has never known - pass a key; callers
   * reporting a specific block's data do not.
   */
  dedupeKey?: string;
}

/**
 * Sequence numbers handed out within one block, keyed by `blockId/eventIdx`.
 *
 * A single event can produce more than one anomaly - a decoder that does not match reports the
 * miss and then the arity it fell back to - so the event id alone is not unique. The map is
 * dropped whenever the block changes, which bounds it to one block's events.
 *
 * This is block scoped rather than process scoped on purpose: a worker thread indexes a whole
 * block, so two workers never hand out sequence numbers for the same block.
 */
let sequenceBlockId: string | undefined;
let sequences = new Map<string, number>();

/** Keys already written by this process. Diagnostic only - see `AnomalyInput.dedupeKey` */
const seenDedupeKeys = new Set<string>();

const nextSequence = (blockId: string, eventKey: string): number => {
  if (sequenceBlockId !== blockId) {
    sequenceBlockId = blockId;
    sequences = new Map();
  }

  const seq = sequences.get(eventKey) ?? 0;
  sequences.set(eventKey, seq + 1);

  return seq;
};

/**
 * Records something the indexer could not decode or resolve.
 *
 * Returns the write so an async caller can await it. Callers on a synchronous path - `toEnum`,
 * the decode layer's field lookup - may drop it with `void`: an anomaly row is a diagnostic, and
 * losing one never loses index data.
 */
export const recordAnomaly = async ({
  kind,
  detail,
  block,
  eventIdx,
  moduleId,
  eventId,
  dedupeKey,
}: AnomalyInput): Promise<void> => {
  if (dedupeKey !== undefined) {
    if (seenDedupeKeys.has(dedupeKey)) {
      return;
    }
    seenDedupeKeys.add(dedupeKey);
  }

  const blockId = padId(block.block.header.number.toString());
  const eventKey = padId((eventIdx ?? 0).toString());
  const seq = nextSequence(blockId, eventKey);

  logger.warn(
    `Indexer anomaly ${kind} at ${blockId}/${eventKey} (${moduleId ?? '-'}.${
      eventId ?? '-'
    }): ${detail}`
  );

  await IndexerAnomaly.create({
    id: `${blockId}/${eventKey}/${padId(seq.toString())}`,
    kind,
    moduleId,
    eventId,
    detail,
    specVersionId: block.specVersion,
    blockId,
    createdAt: block.timestamp,
  }).save();
};
