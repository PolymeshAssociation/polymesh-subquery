import { Codec } from '@polkadot/types/types';
import { SubstrateEvent } from '@subql/types';
import { decodeEvent } from '../../../decode';
import {
  BallotVoteEntry,
  CorporateAction,
  CorporateBallot,
  CorporateBallotVote,
} from '../../../types';
import { getBooleanValue, getCaIdValue } from '../../../utils';
import { fieldOf, isObject, itemsOf, jsonOf } from '../../../utils/codec';
import { extractArgs, getOrAnomaly } from '../common';
import { caId } from './mapCorporateAction';
import { storedText } from '../../../utils/text';

/**
 * `corporateBallot` pallet handlers. All six events have one shape in every runtime.
 */
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

const isRange = (json: unknown): json is RangeJson =>
  isObject(json) && typeof json.start === 'number' && typeof json.end === 'number';

const isMeta = (json: unknown): json is MetaJson =>
  isObject(json) &&
  typeof json.title === 'string' &&
  (json.motions === undefined || Array.isArray(json.motions));

/** `power` is a number, or hex text once a balance outgrows what JSON numbers hold exactly. */
interface VoteJson {
  power: number | string;
  fallback: number | null;
}

const isVotes = (json: unknown): json is VoteJson[] =>
  Array.isArray(json) &&
  json.every(
    vote =>
      isObject(vote) &&
      (typeof vote.power === 'number' || typeof vote.power === 'string') &&
      (vote.fallback === null || typeof vote.fallback === 'number')
  );

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
  // the shape checked on the JSON; the text read from the codec, as the chain stores it
  jsonOf(rawMeta, isMeta, 'BallotMeta');
  const motions = fieldOf(rawMeta, 'motions');

  return JSON.stringify({
    title: storedText(fieldOf(rawMeta, 'title')),
    motions: (motions ? itemsOf(motions, 'BallotMeta.motions') : []).map(motion => {
      const choices = fieldOf(motion, 'choices');
      return {
        title: storedText(fieldOf(motion, 'title')),
        infoLink: storedText(fieldOf(motion, 'info_link')),
        choices: (choices ? itemsOf(choices, 'Motion.choices') : []).map(choice =>
          storedText(choice)
        ),
      };
    }),
  });
};

/** The ballot of corporate action `id`, from its range, meta and RCV flag; unsaved */
export const ballotRow = (
  assetId: string,
  id: string,
  { range, meta, rcv }: { range: Codec; meta: Codec; rcv: Codec },
  corporateActionId: string | undefined,
  blockEventId: string
): CorporateBallot => {
  const { start, end } = jsonOf(range, isRange, 'BallotTimeRange');
  return CorporateBallot.create({
    id,
    assetId,
    corporateActionId,
    startDate: new Date(start),
    endDate: new Date(end),
    meta: decodeMeta(meta),
    rcv: getBooleanValue(rcv),
    isRemoved: false,
    createdEventId: blockEventId,
    updatedEventId: blockEventId,
  });
};

/** A voter's votes, one entry per motion choice, as the chain's `Vec<BallotVote>` gives them */
export const ballotVotesOf = (rawVotes: Codec): BallotVoteEntry[] =>
  jsonOf(rawVotes, isVotes, 'BallotVotes').map(
    (vote): BallotVoteEntry => ({
      power: BigInt(vote.power).toString(),
      fallback: vote.fallback ?? undefined,
    })
  );

export const handleBallotCreated = async (event: SubstrateEvent): Promise<void> => {
  const { block, blockEventId } = extractArgs(event);
  const { caId: rawCaId, range, meta, rcv } = decodeEvent(event);

  const { localId, assetId } = await getCaIdValue(rawCaId, block);
  const id = caId(assetId, localId);
  const corporateAction = await getOrAnomaly(
    actionId => CorporateAction.get(actionId),
    id,
    'CorporateAction',
    event
  );

  await ballotRow(assetId, id, { range, meta, rcv }, corporateAction?.id, blockEventId).save();
};

export const handleBallotMetaChanged = async (event: SubstrateEvent): Promise<void> => {
  const { block, blockEventId } = extractArgs(event);
  const { caId: rawCaId, meta: rawMeta } = decodeEvent(event);

  const { localId, assetId } = await getCaIdValue(rawCaId, block);
  const ballot = await getOrAnomaly(
    id => CorporateBallot.get(id),
    caId(assetId, localId),
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
    caId(assetId, localId),
    'CorporateBallot',
    event
  );

  if (!ballot) {
    return;
  }

  const range = jsonOf(rawRange, isRange, 'BallotTimeRange');

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
    caId(assetId, localId),
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
    caId(assetId, localId),
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
  const { voterDid: rawDid, caId: rawCaId, votes: rawVotes } = decodeEvent(event);

  const { localId, assetId } = await getCaIdValue(rawCaId, block);
  const voterId = rawDid.toString();

  const votes = ballotVotesOf(rawVotes);

  const id = `${caId(assetId, localId)}/${voterId}`;

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
    ballotId: caId(assetId, localId),
    voterId,
    votes,
    createdEventId: blockEventId,
    updatedEventId: blockEventId,
  }).save();
};
