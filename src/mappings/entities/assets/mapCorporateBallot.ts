import { Codec } from '@polkadot/types/types';
import { SubstrateEvent } from '@subql/types';
import { decodeEvent } from '../../../decode';
import { BallotVoteEntry, CorporateBallot, CorporateBallotVote } from '../../../types';
import { bytesToString, getBooleanValue, getCaIdValue } from '../../../utils';
import { extractArgs, getOrAnomaly } from '../common';

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

interface MotionJson {
  title?: string;
  infoLink?: string;
  info_link?: string;
  choices?: string[];
}

interface MetaJson {
  title: string;
  motions?: MotionJson[];
}

/** Hex-encoded `Bytes` as text. `toJSON()` gives `0x…` for every `Bytes` field in this structure. */
const text = (value: string | undefined): string | undefined =>
  value === undefined ? undefined : bytesToString({ toString: () => value } as Codec);

/**
 * `BallotMeta { title: Bytes, motions: Vec<Motion> }`, where
 * `Motion { title: Bytes, info_link: Bytes, choices: Vec<Bytes> }`.
 *
 * Every one of those is `Bytes`, so all of them arrive hex-encoded and all of them are decoded here.
 * The motions carry the readable content of a ballot — what is being voted on and what the options
 * are — so leaving them as `0x…` means no consumer can display a ballot without decoding it itself.
 * The stored shape is unchanged; only the byte fields inside it become text.
 */
const decodeMeta = (rawMeta: Codec): string => {
  const { title, motions } = rawMeta.toJSON() as unknown as MetaJson;

  return JSON.stringify({
    title: text(title),
    motions: (motions ?? []).map(motion => ({
      title: text(motion.title),
      infoLink: text(motion.infoLink ?? motion.info_link),
      choices: (motion.choices ?? []).map(choice => text(choice)),
    })),
  });
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
  const ballot = await getOrAnomaly(
    id => CorporateBallot.get(id),
    ballotId(assetId, localId),
    'CorporateBallot',
    event
  );

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
  const ballot = await getOrAnomaly(
    id => CorporateBallot.get(id),
    ballotId(assetId, localId),
    'CorporateBallot',
    event
  );

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
  const ballot = await getOrAnomaly(
    id => CorporateBallot.get(id),
    ballotId(assetId, localId),
    'CorporateBallot',
    event
  );

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
  const ballot = await getOrAnomaly(
    id => CorporateBallot.get(id),
    ballotId(assetId, localId),
    'CorporateBallot',
    event
  );

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

  const id = `${ballotId(assetId, localId)}/${voterId}`;

  // Upserted, because the chain keys `Votes` on `(CAId, IdentityId)`: voting again while the ballot
  // is open replaces the previous vote rather than adding one. A row per `VoteCast` would leave a
  // voter who changed their mind counted twice.
  const existing = await CorporateBallotVote.get(id);

  if (existing) {
    existing.votes = votes;
    existing.updatedEventId = blockEventId;

    await existing.save();

    return;
  }

  await CorporateBallotVote.create({
    id,
    ballotId: ballotId(assetId, localId),
    voterId,
    votes,
    createdEventId: blockEventId,
    updatedEventId: blockEventId,
  }).save();
};
