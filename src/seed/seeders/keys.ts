import { Codec } from '@polkadot/types/types';
import { AccountKeyRole } from '../../types';
import { extractString, getTextValue } from '../../utils/common';
import { ChainSnapshot } from '../snapshot';

/** What the chain's key record makes an address */
export interface StoredKey {
  address: string;
  /** the identity it is a key of; none for a multisig signer's key */
  did?: string;
  role: AccountKeyRole;
  /** a 5.x–6.x secondary key's permissions, kept in its key record */
  permissions?: unknown;
}

/** `identity.keyRecords`'s JSON; until 7.0 a secondary key's record is the pair `(did, permissions)` */
type KeyRecordJson =
  | { primaryKey: string }
  | { secondaryKey: string | [string, unknown] }
  | { multiSigSignerKey: string };

const keyOf = (address: string, json: unknown): StoredKey | undefined => {
  const record = json as KeyRecordJson | null;
  if (!record) {
    return undefined;
  }
  if ('primaryKey' in record) {
    return { address, did: record.primaryKey, role: AccountKeyRole.PrimaryKey };
  }
  if ('secondaryKey' in record) {
    const secondary = record.secondaryKey;
    return Array.isArray(secondary)
      ? {
          address,
          did: secondary[0],
          role: AccountKeyRole.SecondaryKey,
          permissions: secondary[1],
        }
      : { address, did: secondary, role: AccountKeyRole.SecondaryKey };
  }
  if ('multiSigSignerKey' in record) {
    return { address, role: AccountKeyRole.MultiSigSigner };
  }
  return undefined;
};

/** A 3.x identity record's primary key */
export const primaryKeyOf = (record: Codec | undefined): string | undefined =>
  extractString(record?.toJSON(), 'primary_key') || undefined;

/**
 * Every key the chain records, by address: `identity.keyRecords` from 5.0, and before it
 * `identity.keyToIdentityIds`, with the role read from the identity's record, and
 * `multiSig.keyToMultiSig` for a multisig signer's key, which 5.0 moved into the key records.
 */
export const storedKeys = (snap: ChainSnapshot): Promise<ReadonlyMap<string, StoredKey>> =>
  snap.derive('storedKeys', async () => {
    const keys = new Map<string, StoredKey>();
    if (snap.has('identity.keyRecords')) {
      for await (const page of snap.pages('identity.keyRecords')) {
        page.forEach(({ args, value }) => {
          const key = value && keyOf(args[0].toString(), value.toJSON());
          if (key) {
            keys.set(key.address, key);
          }
        });
      }
      return keys;
    }
    const records = await snap.map('identity.didRecords');
    for await (const page of snap.pages('identity.keyToIdentityIds')) {
      page.forEach(({ args, value }) => {
        const address = args[0].toString();
        const did = value && getTextValue(value);
        if (did) {
          const primary = primaryKeyOf(records.get(did)?.value) === address;
          keys.set(address, {
            address,
            did,
            role: primary ? AccountKeyRole.PrimaryKey : AccountKeyRole.SecondaryKey,
          });
        }
      });
    }
    // a key is an identity's or a multisig's signer, never both (`unsafe_accept_multisig_signer`)
    for await (const page of snap.pages('multiSig.keyToMultiSig')) {
      page.forEach(({ args, value }) => {
        const address = args[0].toString();
        if (value && !keys.has(address)) {
          keys.set(address, { address, role: AccountKeyRole.MultiSigSigner });
        }
      });
    }
    return keys;
  });
