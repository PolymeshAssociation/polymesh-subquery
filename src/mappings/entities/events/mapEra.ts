import { SubstrateBlock, SubstrateEvent } from '@subql/types';
import { decodeEvent } from '../../../decode';
import { AnomalyKind, Era, Validator, ValidatorEra } from '../../../types';
import { blockTime, getAllByFields, getBigIntValue, getTextValue, padId } from '../../../utils';
import { recordAnomaly } from '../../../utils/anomaly';
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
 * `EraPayout(EraIndex, Balance, Balance)`, and both are routed here. Verified in
 * `pallets/staking/src/lib.rs` at v3.3.0 and v6.0.0: `new_era` increments `CurrentEra`, then
 * `select_and_update_validators` writes `ErasStakers` for it and only then deposits
 * `StakingElection` — the same storage state `StakersElected` sees, so the same reads apply. The
 * `ElectionCompute` payload is not needed. Without this, testnet had no `Era` or `Validator` row
 * until v7.
 */

const getOrCreateEra = (eraIndex: number, blockEventId: string): Era => {
  const id = padId(eraIndex.toString());

  return Era.create({ id, eraIndex, startEventId: blockEventId });
};

export const handleStakersElected = async (event: SubstrateEvent): Promise<void> => {
  const { blockId, block, blockEventId, eventIdx, moduleId, eventId } = extractArgs(event);
  const eraIndex = await readCurrentEraIndex();

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
  const [exposures, prefs] = await Promise.all([
    readEraExposures(eraIndex),
    readEraValidatorPrefs(eraIndex),
  ]);

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
        blockEventId
      );
      validator.isActive = true;
      validator.updatedEventId = blockEventId;

      await Promise.all([
        validator.save(),
        validatorEra(eraIndex, validator, exposure, prefs.get(exposure.stash), blockEventId).save(),
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
  const { blockEventId } = extractArgs(event);
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
  const [totalStaked, points, elected] = await Promise.all([
    readEraTotalStake(eraIndex),
    readEraRewardPoints(eraIndex),
    getAllByFields<ValidatorEra>('ValidatorEra', [['eraIndex', '=', eraIndex]]),
  ]);

  era.totalStaked = totalStaked;
  era.totalPoints = points.total;

  // A validator that authored nothing has no entry, which is 0 points, not unknown.
  elected.forEach(row => {
    row.points = points.individual.get(row.validatorId) ?? 0;
    row.updatedEventId = blockEventId;
  });

  await Promise.all([era.save(), ...elected.map(row => row.save())]);
};
