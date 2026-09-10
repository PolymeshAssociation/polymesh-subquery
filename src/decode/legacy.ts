import { Codec } from '@polkadot/types/types';
import { getTextValue } from '../utils/common';

/**
 * `identity` pallet pre-5.0 payload shapes.
 *
 * At spec `5_000_000` the pallet dropped the `Signatory` / `SecondaryKey` wrappers around its
 * secondary-key parameters:
 *
 * ```
 * < 5.0   SecondaryKeysRemoved(IdentityId, Vec<Signatory<AccountId>>)
 * >= 5.0  SecondaryKeysRemoved(IdentityId, Vec<AccountId>)
 *
 * < 5.0   SecondaryKeyPermissionsUpdated(IdentityId, SecondaryKey<AccountId>, Permissions, Permissions)
 * >= 5.0  SecondaryKeyPermissionsUpdated(IdentityId, AccountId,               Permissions, Permissions)
 * ```
 *
 * and the entries in `SecondaryKeysAdded` carry `key` where they used to carry `signer`. Arity is
 * unchanged in every case, so the shape registry (`src/decode/shapes`) has nothing to say about
 * it — the unwrapping lives here instead of as inline `instanceof Map` / `'key' in rest` sniffs in
 * the handlers. The logic is unchanged from the handlers it was lifted out of; only its location.
 */

/** The spec version the wrappers were removed at, on the public chain's scale. */
export const SIGNATORY_WRAPPERS_REMOVED_AT = 5_000_000;

/** A `Signatory` serialises to `{ account }` (or `{ identity }`); a bare `AccountId` to a string. */
type LegacySignatory = string | { account?: string; identity?: string };

const signatoryAddress = (value: LegacySignatory): string =>
  typeof value === 'string' ? value : value.account ?? '';

/**
 * The address from a `SecondaryKeyPermissionsUpdated` key parameter, pre- or post-5.0.
 *
 * Pre-5.0 the parameter decodes to a `SecondaryKey` struct (`{ signer, permissions }`); a
 * polkadot `Struct` is a `Map`, which is what the version test keys off.
 */
export const legacyPermissionsUpdatedAddress = (raw: Codec): string => {
  if (raw instanceof Map) {
    const signer = (raw as Map<string, Codec>).get('signer');

    return signatoryAddress(JSON.parse(signer?.toString() ?? '""'));
  }

  return getTextValue(raw);
};

/** The addresses from a `SecondaryKeysRemoved` signer vector, pre- or post-5.0. */
export const legacyRemovedAddresses = (raw: Codec): string[] =>
  (raw.toJSON() as LegacySignatory[]).map(signatoryAddress);

/** The address from a `SignerLeft` signer parameter, pre- or post-5.0. */
export const legacySignerLeftAddress = (raw: Codec): string =>
  signatoryAddress(raw.toJSON() as LegacySignatory);

/** One `SecondaryKeysAdded` entry: its granted permissions plus the key it grants them to. */
export interface LegacySecondaryKeyEntry {
  address: string;
  permissions: Record<string, unknown>;
}

/**
 * The `(address, permissions)` pairs from a `SecondaryKeysAdded` vector.
 *
 * Each entry is a `{ permissions }` alongside either `key` (5.0+) or `signer` (pre-5.0, an
 * `{ account }` `Signatory`).
 */
export const legacySecondaryKeyEntries = (raw: Codec): LegacySecondaryKeyEntry[] => {
  const entries = JSON.parse(raw.toString()) as Record<string, any>[];

  return entries.map(({ permissions, ...rest }) => ({
    address: 'key' in rest ? rest.key : rest.signer.account,
    permissions,
  }));
};
