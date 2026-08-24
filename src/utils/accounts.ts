import { decodeAddress, encodeAddress } from '@polkadot/keyring';
import { Codec } from '@polkadot/types/types';
import { u8aToHex } from '@polkadot/util';
import { createIdentity, createPermissions } from '../mappings/entities/identities/mapIdentities';
import { Attributes } from '../mappings/entities/common';
import { Account, EventIdEnum, Identity } from '../types';
import { getFirstKeyFromJson, getFirstValueFromJson } from './common';
import { evmAddressFromSs58, isEthDerivedAddress } from './eth';

export const serializeAccount = (item: Codec): string | undefined => {
  const s = item.toString();

  if (s.trim().length === 0) {
    return undefined;
  }
  return u8aToHex(decodeAddress(item.toString(), false, item.registry.chainSS58));
};

export const getAccountKey = (item: string, ss58Format?: number): string => {
  return encodeAddress(item.toString(), ss58Format);
};

/**
 * Classifies an account as belonging to a substrate or an Ethereum key, and resolves the H160
 * `pallet_revive` addresses it by
 */
export const getAccountKeyType = (
  address: string
): Pick<Attributes<Account>, 'keyType' | 'evmAddress'> => {
  const ss58Format = api.registry.chainSS58;

  return {
    keyType: isEthDerivedAddress(address, ss58Format) ? 'ethereum' : 'substrate',
    evmAddress: evmAddressFromSs58(address, ss58Format),
  };
};

export const getOrCreateAccount = async (
  address: string,
  blockId: string,
  datetime: Date
): Promise<Account | undefined> => {
  let account = await Account.get(address);

  if (account) {
    return account;
  }

  const rawKeyRecord = (await api.query.identity.keyRecords(address)) as unknown as Codec;

  if (rawKeyRecord.isEmpty) {
    return;
  }

  const did = getFirstValueFromJson(rawKeyRecord);
  const type = getFirstKeyFromJson(rawKeyRecord);

  const eventId = EventIdEnum.AccountCreated;

  const identity = await Identity.get(did);

  if (!identity || (type === 'primaryKey' && identity.primaryAccount !== address)) {
    await createIdentity(
      { did, eventId, datetime, primaryAccount: address, secondaryKeysFrozen: false },
      blockId
    );
  }

  await createPermissions(
    {
      datetime,
      transactionGroups: [],
    },
    address,
    blockId
  );

  account = Account.create({
    id: address,
    eventId: EventIdEnum.AccountCreated,
    datetime,
    identityId: did,
    permissionsId: address,
    address,
    ...getAccountKeyType(address),
    createdBlockId: blockId,
    updatedBlockId: blockId,
  });

  await account.save();

  return account;
};
