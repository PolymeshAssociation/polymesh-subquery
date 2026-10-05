import { SubstrateEvent } from '@subql/types';
import { decodeEvent } from '../../../decode';
import { AnomalyKind, Era, Validator } from '../../../types';
import { blockTime, getAllByFields, getBigIntValue, getTextValue, padId } from '../../../utils';
import { recordAnomaly } from '../../../utils/anomaly';
import { readCurrentEraIndex, readEraTotalStake, readEraValidators } from '../../../utils/staking';
import { extractArgs } from '../common';
import { getOrCreateValidator } from './mapValidator';

/**
 * `StakersElected`/`EraPaid` — era boundaries. `StakersElected` carries no payload in either era
 * (`AugmentedEvent<ApiType, []>`), so the era index and the elected validator set are both
 * resolved from chain storage (`staking.currentEra()` / `staking.erasStakers(eraIndex)` keys, NOT
 * `activeEra()` / `session.validators()` — see `readCurrentEraIndex`/`readEraValidators` in
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

  const id = padId(eraIndex.toString());
  const era = (await Era.get(id)) ?? getOrCreateEra(eraIndex, blockEventId);

  await era.save();

  const validators = await readEraValidators(eraIndex);
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
    ...validators.map(async stash => {
      const validator = await getOrCreateValidator(stash, blockId, blockTime(block), blockEventId);
      validator.isActive = true;
      validator.updatedEventId = blockEventId;

      await validator.save();
    }),
  ]);
};

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
  era.totalStaked = await readEraTotalStake(eraIndex);

  await era.save();
};
