import { SubstrateBlock, SubstrateEvent } from '@subql/types';
import { decodeEvent } from '../../../decode';
import { Nomination } from '../../../types';
import { blockTime, EXPLICIT_NULL, getAllByFields, getTextValue } from '../../../utils';
import { ledgerAccount } from '../../../utils/accounts';
import { readOrAnomaly } from '../../../utils/anomaly';
import { readActiveEraIndex } from '../../../utils/staking';
import { extractArgs } from '../common';
import { getOrCreatePosition } from './mapStakingPosition';

/**
 * `Nominated` (pre-v8 `staking`, v8+ `validators`) and the nomination side of `Chilled`/`Kicked`.
 *
 * `nominate` replaces the whole target set in one call, so `handleNominated` diffs against the
 * currently-open rows: targets no longer present are closed, targets already open are left
 * untouched (same row, same `validFromEvent`), and newly-added targets get new rows.
 */

/**
 * Keyed on `blockEventId`, not `blockId` — two `Nominated` events for the same stash can land in
 * one block (e.g. a `utility.batch` of `nominate` calls), and a `blockId`-only id would let the
 * second event's row overwrite the first's, silently erasing whichever nomination closed there.
 */
const nominationId = (stash: string, validator: string, blockEventId: string): string =>
  `${stash}/${validator}/${blockEventId}`;

/**
 * `Nominated` carries no era — a nomination applies to future elections, not a specific past one.
 * Read `staking.activeEra()` once per call so `Nomination.eraIndex` at least records "as of which
 * era this nomination was submitted." `undefined` when the chain has no active era yet, which
 * leaves `eraIndex` null rather than guessed at, as does an `activeEra` that doesn't decode with the
 * block's metadata, which is recorded as an anomaly.
 */
const currentEraIndex = (block: SubstrateBlock, eventIdx: number): Promise<number | undefined> =>
  readOrAnomaly(
    { block, eventIdx },
    'the era of the nomination is left unrecorded',
    readActiveEraIndex
  );

/**
 * A stash's open nominations, read through the `(position, validToEvent)` index: only the open
 * ones, rather than every nomination the stash ever made, which grew with each re-nomination. An
 * open nomination is written with an explicit `null`, which the store's cache needs to match one.
 */
const getOpenNominations = (stash: string): Promise<Nomination[]> =>
  getAllByFields<Nomination>('Nomination', [
    ['positionId', '=', stash],
    ['validToEventId', '=', EXPLICIT_NULL],
  ]);

/** Closes every open nomination `stash` holds as a nominator, stamping the closing event. */
const closeOpenNominations = async (stash: string, blockEventId: string): Promise<Nomination[]> => {
  const open = await getOpenNominations(stash);

  return Promise.all(
    open.map(nomination => {
      nomination.validToEventId = blockEventId;

      return nomination.save().then(() => nomination);
    })
  );
};

export const handleNominated = async (event: SubstrateEvent): Promise<void> => {
  const { blockId, block, blockEventId, eventIdx } = extractArgs(event);
  const { stash: rawStash, targets: rawTargets } = decodeEvent(event);

  const stash = getTextValue(rawStash);

  if (!stash) {
    return;
  }

  const position = await getOrCreatePosition(
    stash,
    blockId,
    blockTime(block),
    blockEventId,
    block,
    eventIdx
  );
  // A `nominate` call is on-chain proof the stash is actively participating again.
  position.isChilled = false;
  position.updatedEventId = blockEventId;
  await position.save();

  const targets = (rawTargets.toJSON() as string[] | null) ?? [];
  const open = await getOpenNominations(stash);
  const openValidators = new Set(open.map(({ validatorId }) => validatorId));
  const eraIndex = await currentEraIndex(block, eventIdx);

  const toClose = open.filter(({ validatorId }) => !targets.includes(validatorId));
  const toOpen = targets.filter(validator => !openValidators.has(validator));

  await Promise.all([
    ...toClose.map(nomination => {
      nomination.validToEventId = blockEventId;

      return nomination.save();
    }),
    ...toOpen.map(async validator => {
      // `validator` is a nomination *target* — a third-party stash that may never have signed an
      // indexed extrinsic of its own, so nothing else guarantees its `Account` row exists yet.
      await ledgerAccount(validator, blockId, blockTime(block));

      return Nomination.create({
        id: nominationId(stash, validator, blockEventId),
        positionId: stash,
        validatorId: validator,
        eraIndex,
        validFromEventId: blockEventId,
        validToEventId: EXPLICIT_NULL, // explicitly open (see `getOpenNominations`)
      }).save();
    }),
  ]);
};

/** `Chilled(stash)` — the stash stopped participating as validator or nominator; close its own
 * open nominations (as a nominator) and mark the position chilled. Does not touch nominations
 * pointing *at* a chilled validator — the chain doesn't invalidate those either. */
export const handleChilled = async (event: SubstrateEvent): Promise<void> => {
  const { blockId, block, blockEventId, eventIdx } = extractArgs(event);
  const { stash: rawStash } = decodeEvent(event);

  const stash = getTextValue(rawStash);

  if (!stash) {
    return;
  }

  const position = await getOrCreatePosition(
    stash,
    blockId,
    blockTime(block),
    blockEventId,
    block,
    eventIdx
  );
  position.isChilled = true;
  position.updatedEventId = blockEventId;

  await Promise.all([position.save(), closeOpenNominations(stash, blockEventId)]);
};

/**
 * `InvalidatedNominators` — `validate_cdd_expiry_nominators` removed the listed stashes from the
 * chain's nominator set because their CDD expired, and unbonded their active balance (which
 * arrives as its own `Unbonded` event, so the ledger is left to that handler). The stash drops out
 * of the nominator set exactly as `chill` would drop it, so its open nominations close and the
 * position is marked chilled. Only stashes that were actually removed are listed.
 *
 * Pre-v7 the event is positional `(councilDid, councilAccount, expiredNominators)`; from v7 it is
 * named. Both decode to `expiredNominators` through the registered shape. v8.0.0 to v8.1.2 declare
 * it under the `validators` pallet too, but the runtime never deposits it there (only v7 ones do),
 * so the `Unbonded` is the only trace a v8 CDD expiry leaves.
 */
export const handleInvalidatedNominators = async (event: SubstrateEvent): Promise<void> => {
  const { blockId, block, blockEventId, eventIdx } = extractArgs(event);
  const { expiredNominators } = decodeEvent(event);

  const stashes = (expiredNominators.toJSON() as string[] | null) ?? [];

  for (const stash of stashes) {
    const position = await getOrCreatePosition(
      stash,
      blockId,
      blockTime(block),
      blockEventId,
      block,
      eventIdx
    );
    position.isChilled = true;
    position.updatedEventId = blockEventId;

    await Promise.all([position.save(), closeOpenNominations(stash, blockEventId)]);
  }
};

/** `Kicked(nominator, stash)` — the validator `stash` removed `nominator` from its nominator list. */
export const handleKicked = async (event: SubstrateEvent): Promise<void> => {
  const { blockEventId } = extractArgs(event);
  const { nominator: rawNominator, stash: rawValidator } = decodeEvent(event);

  const nominator = getTextValue(rawNominator);
  const validator = getTextValue(rawValidator);

  if (!nominator || !validator) {
    return;
  }

  const open = await getOpenNominations(nominator);
  const match = open.find(({ validatorId }) => validatorId === validator);

  if (!match) {
    return;
  }

  match.validToEventId = blockEventId;

  await match.save();
};
