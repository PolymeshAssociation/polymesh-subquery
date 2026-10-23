import { SubstrateBlock, SubstrateEvent } from '@subql/types';
import { decodeEvent } from '../../../decode';
import { Validator } from '../../../types';
import { blockTime, getAllByFields, getTextValue } from '../../../utils';
import { ledgerAccount } from '../../../utils/accounts';
import { readOrAnomaly } from '../../../utils/anomaly';
import { readPermissionedIdentity } from '../../../utils/staking';
import { extractArgs } from '../common';

/**
 * A `permissionedIdentity` that doesn't decode with the block's metadata is recorded as an anomaly
 * against `block` and leaves the new row not permissioned, as for an unknown one.
 */
export const getOrCreateValidator = async (
  stash: string,
  blockId: string,
  datetime: Date,
  blockEventId: string,
  block: SubstrateBlock | undefined,
  eventIdx?: number
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
        ? (await readOrAnomaly(
            { block, eventIdx },
            `${stash} is recorded as not permissioned`,
            () => readPermissionedIdentity(account.identityId as string)
          )) ?? false
        : false,
      isActive: false,
      createdEventId: blockEventId,
      updatedEventId: blockEventId,
    });
  }

  return validator;
};

export const handleValidatorPrefsSet = async (event: SubstrateEvent): Promise<void> => {
  const { blockId, block, blockEventId, eventIdx } = extractArgs(event);
  const { stash: rawStash, prefs: rawPrefs } = decodeEvent(event);

  const stash = getTextValue(rawStash);

  if (!stash) {
    return;
  }

  const prefs = rawPrefs.toJSON() as { commission?: number; blocked?: boolean };
  const validator = await getOrCreateValidator(
    stash,
    blockId,
    blockTime(block),
    blockEventId,
    block,
    eventIdx
  );

  validator.commission = prefs.commission !== undefined ? BigInt(prefs.commission) : undefined;
  validator.blocked = Boolean(prefs.blocked);
  validator.updatedEventId = blockEventId;

  await validator.save();
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
