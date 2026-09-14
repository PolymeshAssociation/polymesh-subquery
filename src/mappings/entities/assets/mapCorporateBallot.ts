import { Codec } from '@polkadot/types/types';
import { SubstrateEvent } from '@subql/types';
import { decodeEvent } from '../../../decode';
import { BallotVoteEntry, CorporateBallot, CorporateBallotVote } from '../../../types';
import { bytesToString, getBooleanValue, getCaIdValue } from '../../../utils';
import { extractArgs } from '../common';

/**
 * `corporateBallot` pallet handlers.
 *
 * All six events are shape-identical across every checked spec version
 * (docs/reference/event-shape-verification.md) — no version branching in this domain.
 */
const ballotId = (assetId: string, localId: number): string => `${assetId}/${localId}`;

interface RangeJson {
  start: number;
  end: number;
}

interface MetaJson {
  title: string;
  motions: unknown;
}

/** `BallotMeta { title: Bytes, motions: Vec<Motion> }` — `title` decodes like any other `Bytes` field */
const decodeMeta = (rawMeta: Codec): string => {
  const { title, motions } = rawMeta.toJSON() as unknown as MetaJson;

  return JSON.stringify({ title: bytesToString({ toString: () => title } as Codec), motions });
};

export const handleBallotCreated = async (event: SubstrateEvent): Promise<void> => {
  const { block, blockEventId } = extractArgs(event);
  const { caId: rawCaId, range: rawRange, meta: rawMeta, rcv: rawRcv } = decodeEvent(event);

  const { localId, assetId } = await getCaIdValue(rawCaId, block);
  const range = rawRange.toJSON() as unknown as RangeJson;

  await CorporateBallot.create({
    id: ballotId(assetId, localId),
    assetId,
    corporateActionId: ballotId(assetId, localId),
    startDate: new Date(range.start),
    endDate: new Date(range.end),
    meta: decodeMeta(rawMeta),
    rcv: getBooleanValue(rawRcv),
    isRemoved: false,
    createdEventId: blockEventId,
    updatedEventId: blockEventId,
  }).save();
};

export const handleBallotMetaChanged = async (event: SubstrateEvent): Promise<void> => {
  const { block, blockEventId } = extractArgs(event);
  const { caId: rawCaId, meta: rawMeta } = decodeEvent(event);

  const { localId, assetId } = await getCaIdValue(rawCaId, block);
  const ballot = await CorporateBallot.get(ballotId(assetId, localId));

  if (!ballot) {
    return;
  }

  ballot.meta = decodeMeta(rawMeta);
  ballot.updatedEventId = blockEventId;

  await ballot.save();
};

export const handleBallotRangeChanged = async (event: SubstrateEvent): Promise<void> => {
  const { block, blockEventId } = extractArgs(event);
  const { caId: rawCaId, range: rawRange } = decodeEvent(event);

  const { localId, assetId } = await getCaIdValue(rawCaId, block);
  const ballot = await CorporateBallot.get(ballotId(assetId, localId));

  if (!ballot) {
    return;
  }

  const range = rawRange.toJSON() as unknown as RangeJson;

  ballot.startDate = new Date(range.start);
  ballot.endDate = new Date(range.end);
  ballot.updatedEventId = blockEventId;

  await ballot.save();
};

export const handleBallotRcvChanged = async (event: SubstrateEvent): Promise<void> => {
  const { block, blockEventId } = extractArgs(event);
  const { caId: rawCaId, rcv: rawRcv } = decodeEvent(event);

  const { localId, assetId } = await getCaIdValue(rawCaId, block);
  const ballot = await CorporateBallot.get(ballotId(assetId, localId));

  if (!ballot) {
    return;
  }

  ballot.rcv = getBooleanValue(rawRcv);
  ballot.updatedEventId = blockEventId;

  await ballot.save();
};

export const handleBallotRemoved = async (event: SubstrateEvent): Promise<void> => {
  const { block, blockEventId } = extractArgs(event);
  const { caId: rawCaId } = decodeEvent(event);

  const { localId, assetId } = await getCaIdValue(rawCaId, block);
  const ballot = await CorporateBallot.get(ballotId(assetId, localId));

  if (!ballot) {
    return;
  }

  ballot.isRemoved = true;
  ballot.updatedEventId = blockEventId;

  await ballot.save();
};

export const handleBallotVoteCast = async (event: SubstrateEvent): Promise<void> => {
  const { block, blockEventId } = extractArgs(event);
  const { did: rawDid, caId: rawCaId, votes: rawVotes } = decodeEvent(event);

  const { localId, assetId } = await getCaIdValue(rawCaId, block);
  const voterId = rawDid.toString();

  const votes = (rawVotes.toJSON() as unknown as { power: number; fallback: number | null }[]).map(
    (vote): BallotVoteEntry => ({
      power: BigInt(vote.power),
      fallback: vote.fallback ?? undefined,
    })
  );

  await CorporateBallotVote.create({
    id: blockEventId,
    ballotId: ballotId(assetId, localId),
    voterId,
    votes,
    createdEventId: blockEventId,
  }).save();
};
