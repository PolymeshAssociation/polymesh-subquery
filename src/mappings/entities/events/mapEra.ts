import { SubstrateBlock, SubstrateEvent } from '@subql/types';
import { decodeEvent } from '../../../decode';
import { AnomalyKind, Era, Validator, ValidatorEra } from '../../../types';
import { blockTime, getAllByFields, getBigIntValue, getTextValue, padId } from '../../../utils';
import { readOrAnomaly, recordAnomaly } from '../../../utils/anomaly';
import {
  EraExposure,
  EraValidatorPrefs,
  readCurrentEraIndex,
  readEraExposures,
  readEraRewardPoints,
  readEraTotalStake,
  readEraValidatorPrefs,
} from '../../../utils/staking';
import { extractArgs } from '../common';
import { getOrCreateValidator } from './mapValidator';

/**
 * `StakersElected`/`EraPaid` — era boundaries. `StakersElected` carries no payload in either era
 * (`AugmentedEvent<ApiType, []>`), so the era index and the elected validator set are both
 * resolved from chain storage (`staking.currentEra()` and the era's exposures, NOT
 * `activeEra()` / `session.validators()` — see `readCurrentEraIndex`/`readEraExposures` in
 * `src/utils/staking.ts` for why) when it fires; that resolution also doubles as the era-start
 * signal, since no event marks that directly.
 *
 * Before v7.0.0 the same two boundaries were `StakingElection(ElectionCompute)` and
 * `EraPayout(EraIndex, Balance, Balance)`, and both are routed here: `new_era` writes
 * `ErasStakers` before depositing `StakingElection`, so the same storage reads apply.
 */

const getOrCreateEra = (eraIndex: number, blockEventId: string): Era => {
  const id = padId(eraIndex.toString());

  return Era.create({ id, eraIndex, startEventId: blockEventId });
};

export const handleStakersElected = async (event: SubstrateEvent): Promise<void> => {
  const { blockId, block, blockEventId, eventIdx, moduleId, eventId } = extractArgs(event);
  const read = await readOrAnomaly(
    { block, eventIdx, moduleId, eventId },
    'the era this election opened was not recorded',
    async () => ({ eraIndex: await readCurrentEraIndex() })
  );

  // already recorded as unreadable
  if (!read) {
    return;
  }

  const { eraIndex } = read;

  // The event carries no payload, so the era it opens is only knowable from chain state. Without
  // it there is no row to write — but an era boundary the index skipped is a gap, not a no-op.
  if (eraIndex === undefined) {
    await recordAnomaly({
      kind: AnomalyKind.UnreadableValue,
      detail: 'staking.currentEra is not set, so the era this election opened was not recorded',
      block,
      eventIdx,
      moduleId,
      eventId,
    });

    return;
  }

  await recordElection(eraIndex, { block, blockId, blockEventId, eventIdx });
};

/**
 * Records the validators elected for `eraIndex`: the `Era`, a `ValidatorEra` per validator with its
 * exposure and preferences, and which `Validator`s are active. Called on each election event, and
 * by the genesis seed for the era the genesis config elects, which has no election event.
 *
 * An election always stores its exposures, so finding none means they were read from the wrong
 * map, such as a v7 `erasStakers` on a block whose `api` carries a neighbouring runtime's metadata.
 * That is recorded, and nothing is written: an empty set would mark every validator inactive.
 */
export const recordElection = async (
  eraIndex: number,
  {
    block,
    blockId,
    blockEventId,
    eventIdx,
  }: { block: SubstrateBlock; blockId: string; blockEventId: string; eventIdx?: number }
): Promise<void> => {
  const read = await readOrAnomaly(
    { block, eventIdx },
    `the elected set of era ${eraIndex} was not recorded`,
    () => Promise.all([readEraExposures(eraIndex), readEraValidatorPrefs(eraIndex)])
  );

  if (!read) {
    return;
  }

  const [exposures, prefs] = read;

  if (exposures.length === 0) {
    await recordAnomaly({
      kind: AnomalyKind.UnreadableValue,
      detail: `no exposures were found for era ${eraIndex}, so its elected set was not recorded`,
      block,
      eventIdx,
    });

    return;
  }

  const id = padId(eraIndex.toString());
  const era = (await Era.get(id)) ?? getOrCreateEra(eraIndex, blockEventId);
  era.validatorCount = exposures.length;

  await era.save();

  const validators = exposures.map(({ stash }) => stash);
  const activeSet = new Set(validators);

  const previouslyActive = await getAllByFields<Validator>('Validator', [['isActive', '=', true]]);

  await Promise.all([
    ...previouslyActive
      .filter(validator => !activeSet.has(validator.id))
      .map(validator => {
        validator.isActive = false;
        validator.updatedEventId = blockEventId;

        return validator.save();
      }),
    ...exposures.map(async exposure => {
      const validator = await getOrCreateValidator(
        exposure.stash,
        blockId,
        blockTime(block),
        blockEventId,
        block,
        eventIdx
      );
      const own = prefs.get(exposure.stash);
      validator.isActive = true;
      // the preferences as they stand: before 7.0 `staking.validate` set them with no event
      if (own?.commission !== undefined) {
        validator.commission = own.commission;
      }
      if (own?.blocked !== undefined) {
        validator.blocked = own.blocked;
      }
      validator.updatedEventId = blockEventId;

      await Promise.all([
        validator.save(),
        validatorEra(eraIndex, validator, exposure, own, blockEventId).save(),
      ]);
    }),
  ]);
};

const validatorEraId = (eraIndex: number, stash: string): string =>
  `${padId(eraIndex.toString())}/${stash}`;

/** A validator's row in an era's elected set, as the election stored it. */
const validatorEra = (
  eraIndex: number,
  validator: Validator,
  exposure: EraExposure,
  prefs: EraValidatorPrefs | undefined,
  blockEventId: string
): ValidatorEra =>
  ValidatorEra.create({
    id: validatorEraId(eraIndex, exposure.stash),
    eraId: padId(eraIndex.toString()),
    eraIndex,
    validatorId: validator.id,
    identityId: validator.identityId,
    ownStake: exposure.own,
    totalStake: exposure.total,
    nominatorCount: exposure.nominatorCount,
    commission: prefs?.commission,
    blocked: prefs?.blocked,
    createdEventId: blockEventId,
    updatedEventId: blockEventId,
  });

export const handleEraPaid = async (event: SubstrateEvent): Promise<void> => {
  const { block, blockEventId, eventIdx, moduleId, eventId } = extractArgs(event);
  const {
    eraIndex: rawEraIndex,
    validatorPayout: rawPayout,
    remainder: rawRemainder,
  } = decodeEvent(event);

  const eraIndex = Number(getTextValue(rawEraIndex));
  const id = padId(eraIndex.toString());
  const era = (await Era.get(id)) ?? getOrCreateEra(eraIndex, blockEventId);

  era.endEventId = blockEventId;
  era.validatorPayout = getBigIntValue(rawPayout);
  era.remainder = getBigIntValue(rawRemainder);
  const [totals, elected] = await Promise.all([
    readOrAnomaly(
      { block, eventIdx, moduleId, eventId },
      `the stake and points of era ${eraIndex} were left as they were`,
      async () => {
        const [totalStaked, points] = await Promise.all([
          readEraTotalStake(eraIndex),
          readEraRewardPoints(eraIndex),
        ]);

        return { totalStaked, points };
      }
    ),
    getAllByFields<ValidatorEra>('ValidatorEra', [['eraIndex', '=', eraIndex]]),
  ]);

  if (totals) {
    era.totalStaked = totals.totalStaked;
    era.totalPoints = totals.points.total;

    // A validator that authored nothing has no entry, which is 0 points, not unknown.
    elected.forEach(row => {
      row.points = totals.points.individual.get(row.validatorId) ?? 0;
      row.updatedEventId = blockEventId;
    });
  }

  await Promise.all([era.save(), ...elected.map(row => row.save())]);
};
