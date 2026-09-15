import { SubstrateEvent } from '@subql/types';
import { decodeEvent } from '../../../decode';
import { Era, Validator } from '../../../types';
import { getAllByFields, getBigIntValue, getTextValue, padId } from '../../../utils';
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
 */

const getOrCreateEra = (eraIndex: number, blockEventId: string): Era => {
  const id = padId(eraIndex.toString());

  return Era.create({ id, eraIndex, startEventId: blockEventId });
};

export const handleStakersElected = async (event: SubstrateEvent): Promise<void> => {
  const { blockId, block, blockEventId } = extractArgs(event);

  const eraIndex = await readCurrentEraIndex();

  if (eraIndex === undefined) {
    return;
  }

  const id = padId(eraIndex.toString());
  const era = (await Era.get(id)) ?? getOrCreateEra(eraIndex, blockEventId);

  await era.save();

  const validators = await readEraValidators(eraIndex);

  // A failed read means "unknown," not "nobody elected" — leaving the prior active set alone is
  // safer than deactivating every validator on a transient RPC error. The `Era` row above is
  // still worth recording even when this part can't be completed.
  if (validators === undefined) {
    return;
  }

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
      const validator = await getOrCreateValidator(stash, blockId, block.timestamp, blockEventId);
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
