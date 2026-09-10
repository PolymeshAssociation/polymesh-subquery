import { decodeAddress, encodeAddress } from '@polkadot/keyring';
import { Codec } from '@polkadot/types/types';
import { u8aToHex } from '@polkadot/util';
import { getKeyRecordCache } from '../mappings/blockContext';
import { createIdentity } from '../mappings/entities/identities/mapIdentities';
import { createPortfolio } from '../mappings/entities/identities/mapPortfolio';
import { Attributes } from '../mappings/entities/common';
import { Account, EventIdEnum, Identity, IdentityKey, KeyRole } from '../types';
import { extractString, getTextValue, padId } from './common';
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
 * What the chain's key record says an address is.
 *
 * A multisig signer resolves to no DID, deliberately. The signer is linked to the multisig, and
 * the multisig is separately linked to an identity that can be unlinked and joined to a different
 * one; `multiSig.adminDid` names the admin identity, which is not necessarily the one it is
 * joined to. Reading either through to a DID here would record a two-hop, point-in-time answer on
 * the `Account` row as though it were a durable fact about the key.
 */
export type KeyRecordResolution =
  | { kind: 'primaryKey'; did: string }
  | { kind: 'secondaryKey'; did: string }
  | { kind: 'multiSigSigner'; multiSig: string };

/**
 * What an address is a key of, per the chain's own key record.
 *
 * `identity.keyRecords` is a 5.x rename of `identity.keyToIdentityIds`; a genesis resync sees the
 * older name on early blocks. The legacy storage is `Option<IdentityId>` on both public chains
 * (Polymesh launched at v3, so there is no `LinkedKeyInfo` enum to unwrap), and primary vs
 * secondary is read from `identity.didRecords`. It predates multisig signer keys, so that variant
 * only arises on the current path.
 */
const resolveKeyIdentity = async (address: string): Promise<KeyRecordResolution | undefined> => {
  if (typeof api.query.identity.keyRecords === 'function') {
    const raw = await api.query.identity.keyRecords(address);

    if (raw.isEmpty) {
      return undefined;
    }

    const keyRecord = raw.unwrap();

    if (keyRecord.isPrimaryKey) {
      return { kind: 'primaryKey', did: keyRecord.asPrimaryKey.toString() };
    }

    if (keyRecord.isSecondaryKey) {
      return { kind: 'secondaryKey', did: keyRecord.asSecondaryKey.toString() };
    }

    return { kind: 'multiSigSigner', multiSig: keyRecord.asMultiSigSignerKey.toString() };
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

  return { kind: primaryKey === address ? 'primaryKey' : 'secondaryKey', did };
};

/**
 * The chain's key record for `address`, read at most once per block.
 *
 * `api` is bound to the block being indexed and serves its end-of-block state, so this answer is
 * the same for every event in the block - which is what makes caching it safe, and it is the read
 * worth caching: it is the hottest chain read in the indexer, reached twice per asset movement on
 * v8 from both sides of the transfer, so without it a batch touching one address N times issues N
 * identical reads. Addresses that resolve to nothing are cached too, or an unknown address would
 * cost a read every time it is seen.
 *
 * The `Account` row is deliberately NOT cached alongside it. A handler can link or unlink a key
 * partway through a block, so the row can change between events even though the key record cannot.
 */
const resolveKeyRecord = async (
  address: string,
  blockId: string
): Promise<KeyRecordResolution | undefined> => {
  const cache = getKeyRecordCache(blockId);

  if (cache.has(address)) {
    return cache.get(address);
  }

  const resolution = await resolveKeyIdentity(address);

  cache.set(address, resolution);

  return resolution;
};

/**
 * The `Account` an address belongs to, creating it from the chain's key record when it is absent.
 *
 * A primary or secondary key brings its identity with it, and that identity and its default
 * portfolio are created alongside. Every other address resolves to nothing, deliberately - an
 * `Account` is indexed once the chain attaches it to an identity, which is what `mapExtrinsic`
 * relies on when it indexes an extrinsic's sender. A multisig signer key is one of those: it has
 * no identity of its own (see `KeyRecordResolution`) and no permissions.
 *
 * The chain read is cached per block by `resolveKeyRecord`. The `Account` row is not: it is read
 * from the store on every call, so a row another handler wrote or unlinked earlier in the same
 * block is seen rather than shadowed by a stale cache entry.
 */
export const getOrCreateAccount = async (
  address: string,
  blockId: string,
  datetime: Date
): Promise<Account | undefined> => {
  const existing = await Account.get(address);

  if (existing) {
    return existing;
  }

  const resolution = await resolveKeyRecord(address, blockId);

  if (!resolution) {
    return;
  }

  // No `Account` row for a signer key: it has no identity and no permissions, so it would carry
  // only its key type, and `ledgerAccount` creates a bare one anyway if the address ever holds
  // POLYX. The signer itself belongs to `MultiSigSigner`, which the multisig event handlers and
  // the genesis/seed scan own - neither `status` nor `createdBlock` is derivable from a key
  // record, so writing one from here would be guessing at both.
  if (resolution.kind === 'multiSigSigner') {
    return;
  }

  const { did, kind } = resolution;

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
  } else if (kind === 'primaryKey' && identity.primaryAccount !== address) {
    await createIdentity(
      { did, eventId, datetime, primaryAccount: address, secondaryKeysFrozen: false },
      blockId
    );
  }

  const account = Account.create({
    id: address,
    eventId: EventIdEnum.AccountCreated,
    datetime,
    identityId: did,
    address,
    ...getAccountKeyType(address),
    createdBlockId: blockId,
    updatedBlockId: blockId,
  });

  await account.save();

  // The membership interval, so a key discovered lazily from chain state has the same
  // `IdentityKey` history as one seen through a `DidCreated` / `SecondaryKeysAdded` event.
  const existingKey = await IdentityKey.get(`${did}/${address}/${blockId}/${padId('0')}`);

  if (!existingKey) {
    await IdentityKey.create({
      id: `${did}/${address}/${blockId}/${padId('0')}`,
      identityId: did,
      accountId: address,
      role: kind === 'primaryKey' ? KeyRole.Primary : KeyRole.Secondary,
      validFromBlockId: blockId,
      addedReason: eventId,
      createdBlockId: blockId,
      updatedBlockId: blockId,
    }).save();
  }

  return account;
};

/**
 * The `Account` an address belongs to, falling back to a bare row when the chain has no key
 * record for it.
 *
 * `getOrCreateAccount` covers every address the chain attaches to an identity. An address that is
 * not a key — a multisig account, a pallet or system address (the treasury pot, the block-reward
 * pot, …) — still needs an `Account` row, because non-null relations point at one
 * (`MultiSig.account`, `PolyxEntry.account`, `AccountBalance.account`) and the account-page query
 * is keyed on it. The bare row carries only the address and its key type.
 */
export const ledgerAccount = async (
  address: string,
  blockId: string,
  datetime: Date
): Promise<Account> => {
  const resolved = await getOrCreateAccount(address, blockId, datetime);

  if (resolved) {
    return resolved;
  }

  const account = Account.create({
    id: address,
    address,
    eventId: EventIdEnum.AccountCreated,
    datetime,
    ...getAccountKeyType(address),
    createdBlockId: blockId,
    updatedBlockId: blockId,
  });

  await account.save();

  return account;
};
