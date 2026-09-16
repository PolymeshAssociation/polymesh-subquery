import { SubstrateEvent } from '@subql/types';
import { decodeEvent } from '../../../decode';
import { Validator } from '../../../types';
import { getAllByFields, getTextValue } from '../../../utils';
import { ledgerAccount } from '../../../utils/accounts';
import { readPermissionedIdentity } from '../../../utils/staking';
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
      // Read from chain rather than defaulted: `PermissionedIdentityAdded` usually fires *before*
      // this row exists (rows are created by `StakersElected`, later), so `setPermissioned` finds
      // nothing to update and the flag was silently lost — 12 such events on a testnet genesis
      // resync left all 9,054 validators with `isPermissioned: false`. Reading it here covers that
      // ordering; `setPermissioned` still covers the reverse.
      isPermissioned: account.identityId
        ? (await readPermissionedIdentity(account.identityId)) ?? false
        : false,
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
 * `PermissionedIdentityAdded`/`Removed` name an Identity, not a stash, so this can only update
 * `Validator` rows that already exist for that identity. The opposite ordering — the identity
 * permissioned before any of its stashes has a row, which is the usual one — is covered by
 * `getOrCreateValidator` reading the flag from chain when it creates the row.
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
