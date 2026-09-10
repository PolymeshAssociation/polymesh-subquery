import { decodeAddress, encodeAddress } from '@polkadot/keyring';
import { Codec } from '@polkadot/types/types';
import { u8aToHex } from '@polkadot/util';
import { getAccountCache } from '../mappings/blockContext';
import { createIdentity, createPermissions } from '../mappings/entities/identities/mapIdentities';
import { createPortfolio } from '../mappings/entities/identities/mapPortfolio';
import { Attributes } from '../mappings/entities/common';
import { Account, EventIdEnum, Identity } from '../types';
import {
  extractString,
  getFirstKeyFromJson,
  getFirstValueFromJson,
  getTextValue,
  padId,
} from './common';
import { evmAddressFromSs58, isEthDerivedAddress } from './eth';
import { legacyQuery } from './legacyQuery';

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

/**
 * The DID an address is a key of, and whether it is the primary key.
 *
 * `identity.keyRecords` is a 5.x rename of `identity.keyToIdentityIds`; a genesis resync sees the
 * older name on early blocks. The legacy storage is `Option<IdentityId>` on both public chains
 * (Polymesh launched at v3, so there is no `LinkedKeyInfo` enum to unwrap), and primary vs
 * secondary is read from `identity.didRecords`.
 */
const resolveKeyIdentity = async (
  address: string
): Promise<{ did: string; type: 'primaryKey' | 'secondaryKey' } | undefined> => {
  if (typeof api.query.identity.keyRecords === 'function') {
    const raw = (await api.query.identity.keyRecords(address)) as unknown as Codec;

    if (raw.isEmpty) {
      return undefined;
    }

    return {
      did: getFirstValueFromJson(raw),
      type: getFirstKeyFromJson(raw) === 'primaryKey' ? 'primaryKey' : 'secondaryKey',
    };
  }

  const raw = (await legacyQuery(
    'identity',
    'keyToIdentityIds',
    [3000, 5_000_002]
  )(address)) as unknown as Codec;

  if (raw.isEmpty) {
    return undefined;
  }

  const did = getTextValue(raw);
  const record = (await api.query.identity.didRecords(did)).toJSON() as Record<string, unknown>;
  const primaryKey = extractString(record, 'primary_key');

  return { did, type: primaryKey === address ? 'primaryKey' : 'secondaryKey' };
};

/**
 * The `Account` an address belongs to, creating it and its identity when the chain knows of one.
 *
 * Resolution is cached for the block, negatives included. An address the chain has no key record
 * for produces no row and so no marker, and this is the hottest chain read in the indexer - it is
 * reached twice per asset movement on v8, from both sides of the transfer - so without a negative
 * cache a batch touching one unknown address N times issues N identical chain reads.
 *
 * Callers share the cached entity and must not mutate what they read back.
 */
export const getOrCreateAccount = async (
  address: string,
  blockId: string,
  datetime: Date
): Promise<Account | undefined> => {
  const cache = getAccountCache(blockId);

  if (cache.has(address)) {
    return cache.get(address);
  }

  let account = await Account.get(address);

  if (account) {
    cache.set(address, account);

    return account;
  }

  const keyIdentity = await resolveKeyIdentity(address);

  if (!keyIdentity) {
    cache.set(address, undefined);

    return;
  }

  const { did, type } = keyIdentity;

  const eventId = EventIdEnum.AccountCreated;

  const identity = await Identity.get(did);

  if (!identity) {
    await createIdentity(
      { did, eventId, datetime, primaryAccount: address, secondaryKeysFrozen: false },
      blockId
    );

    // The default portfolio, so a later `identity.DidCreated` for this DID finds it — its handler
    // only creates portfolio 0 when it creates the identity, and this path got there first.
    await createPortfolio(
      { identityId: did, number: 0, eventIdx: 0, createdEventId: `${blockId}/${padId('0')}` },
      blockId
    );
  } else if (type === 'primaryKey' && identity.primaryAccount !== address) {
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

  cache.set(address, account);

  return account;
};
