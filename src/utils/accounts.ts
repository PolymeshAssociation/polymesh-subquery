import { decodeAddress, encodeAddress } from '@polkadot/keyring';
import { Codec } from '@polkadot/types/types';
import { u8aToHex } from '@polkadot/util';
import { createIdentity, createPermissions } from '../mappings/entities/identities/mapIdentities';
import { Account, EventIdEnum, Identity } from '../types';
import { getFirstValueFromJson } from './common';

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

export const getOrCreateAccount = async (
  address: string,
  blockId: string,
  datetime: Date
): Promise<Account | undefined> => {
  const account = await Account.get(address);
  if (!account) {
    const rawKeyRecord = (await api.query.identity.keyRecords(address)) as unknown as Codec;

    const did = getFirstValueFromJson(rawKeyRecord);
    const type = getFirstValueFromJson(rawKeyRecord);

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

    const account = Account.create({
      id: address,
      eventId: EventIdEnum.AccountCreated,
      datetime,
      identityId: did,
      permissionsId: address,
      address,
      createdBlockId: blockId,
      updatedBlockId: blockId,
    });

    await account.save();

    return account;
  }
  return account;
};
