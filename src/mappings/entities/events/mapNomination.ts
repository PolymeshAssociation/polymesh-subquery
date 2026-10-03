import { SubstrateEvent } from '@subql/types';
import { decodeEvent } from '../../../decode';
import { AnomalyKind, Nomination } from '../../../types';
import { blockTime, EXPLICIT_NULL, getAllByFields, getTextValue } from '../../../utils';
import { ledgerAccount } from '../../../utils/accounts';
import { recordAnomaly } from '../../../utils/anomaly';
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
 * era this nomination was submitted." `null` when the chain has no active era yet; `undefined` when
 * the read failed. Either leaves `eraIndex` null rather than guessed at, but only a failure is
 * reported (see `handleNominated`).
 */
const currentEraIndex = async (): Promise<number | null | undefined> => {
  try {
    const active = (await api.query.staking.activeEra()).toJSON() as { index?: number } | null;

    return active?.index ?? null;
  } catch {
    return undefined;
  }
};

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

export const handleNominated = async (event: SubstrateEvent): Promise<void> => {
  const { blockId, block, blockEventId, eventIdx, moduleId, eventId } = extractArgs(event);
  const { stash: rawStash, targets: rawTargets } = decodeEvent(event);

  const stash = getTextValue(rawStash);

  if (!stash) {
    return;
  }

  const position = await getOrCreatePosition(stash, blockId, blockTime(block), blockEventId);
  // A `nominate` call is on-chain proof the stash is actively participating again.
  position.isChilled = false;
  position.updatedEventId = blockEventId;
  await position.save();

  const targets = (rawTargets.toJSON() as string[] | null) ?? [];
  const open = await getOpenNominations(stash);
  const openValidators = new Set(open.map(({ validatorId }) => validatorId));
  const eraIndex = await currentEraIndex();

  const toClose = open.filter(({ validatorId }) => !targets.includes(validatorId));
  const toOpen = targets.filter(validator => !openValidators.has(validator));

  // The `(position, eraIndex)` index serves "nominations as of era N", which a row without an era
  // drops out of. So a failed read is reported once for the rows it leaves without one.
  if (eraIndex === undefined && toOpen.length > 0) {
    await recordAnomaly({
      kind: AnomalyKind.UnreadableValue,
      detail: `staking.activeEra could not be read, so ${toOpen.length} nomination(s) by ${stash} were written without an era`,
      block,
      eventIdx,
      moduleId,
      eventId,
    });
  }

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
        eraIndex: eraIndex ?? undefined,
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
  const { blockId, block, blockEventId } = extractArgs(event);
  const { stash: rawStash } = decodeEvent(event);

  const stash = getTextValue(rawStash);

  if (!stash) {
    return;
  }

  const position = await getOrCreatePosition(stash, blockId, blockTime(block), blockEventId);
  position.isChilled = true;
  position.updatedEventId = blockEventId;

  const open = await getOpenNominations(stash);

  await Promise.all([
    position.save(),
    ...open.map(nomination => {
      nomination.validToEventId = blockEventId;

      return nomination.save();
    }),
  ]);
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
