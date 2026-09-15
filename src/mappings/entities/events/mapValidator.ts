import { SubstrateEvent } from '@subql/types';
import { decodeEvent } from '../../../decode';
import { Validator } from '../../../types';
import { getAllByFields, getTextValue } from '../../../utils';
import { ledgerAccount } from '../../../utils/accounts';
import { extractArgs } from '../common';
import { getOrCreatePosition } from './mapStakingPosition';

export const getOrCreateValidator = async (
  stash: string,
  blockId: string,
  datetime: Date,
  blockEventId: string
): Promise<Validator> => {
  let validator = await Validator.get(stash);

  if (!validator) {
    const account = await ledgerAccount(stash, blockId, datetime);

    validator = Validator.create({
      id: stash,
      accountId: stash,
      identityId: account.identityId,
      blocked: false,
      isPermissioned: false,
      isActive: false,
      createdEventId: blockEventId,
      updatedEventId: blockEventId,
    });
  }

  return validator;
};

export const handleValidatorPrefsSet = async (event: SubstrateEvent): Promise<void> => {
  const { blockId, block, blockEventId } = extractArgs(event);
  const { stash: rawStash, prefs: rawPrefs } = decodeEvent(event);

  const stash = getTextValue(rawStash);

  if (!stash) {
    return;
  }

  const prefs = rawPrefs.toJSON() as { commission?: number; blocked?: boolean };
  const validator = await getOrCreateValidator(stash, blockId, block.timestamp, blockEventId);

  validator.commission = prefs.commission !== undefined ? BigInt(prefs.commission) : undefined;
  validator.blocked = Boolean(prefs.blocked);
  validator.updatedEventId = blockEventId;

  // `validate()` is on-chain proof the stash is a validator and actively participating again.
  const position = await getOrCreatePosition(stash, blockId, block.timestamp, blockEventId);
  position.isValidator = true;
  position.isChilled = false;
  position.updatedEventId = blockEventId;

  await Promise.all([validator.save(), position.save()]);
};

/**
 * `PermissionedIdentityAdded`/`Removed` name an Identity, not a stash, so `isPermissioned` can
 * only be set on `Validator` rows that already exist for that identity — see the schema docstring
 * on `Validator.isPermissioned` for the resulting caveat (a stash bonded after its identity is
 * permissioned doesn't retroactively pick up the flag until its own row is next touched).
 */
const setPermissioned = async (
  identity: string,
  isPermissioned: boolean,
  blockEventId: string
): Promise<void> => {
  const validators = await getAllByFields<Validator>('Validator', [['identityId', '=', identity]]);

  await Promise.all(
    validators.map(validator => {
      validator.isPermissioned = isPermissioned;
      validator.updatedEventId = blockEventId;

      return validator.save();
    })
  );
};

export const handlePermissionedIdentityAdded = async (event: SubstrateEvent): Promise<void> => {
  const { blockEventId } = extractArgs(event);
  const { validatorsIdentity: rawIdentity } = decodeEvent(event);

  const identity = getTextValue(rawIdentity);

  if (!identity) {
    return;
  }

  await setPermissioned(identity, true, blockEventId);
};

export const handlePermissionedIdentityRemoved = async (event: SubstrateEvent): Promise<void> => {
  const { blockEventId } = extractArgs(event);
  const { validatorsIdentity: rawIdentity } = decodeEvent(event);

  const identity = getTextValue(rawIdentity);

  if (!identity) {
    return;
  }

  await setPermissioned(identity, false, blockEventId);
};
