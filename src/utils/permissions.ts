/**
 * Extrinsic permissions in the one form the index stores, whatever runtime wrote them: 7.0's, a
 * map by pallet name of each pallet's extrinsics, names as text, in the chain's byte order.
 *
 * The chain holds the same names in every era; only their decoding changed. Before metadata v14
 * the type bundle gave a list of `{ pallet_name, dispatchable_names }` with text names, and from
 * v14 to 7.0 the metadata gave a list of `{ palletName, dispatchableNames }` with names as bytes,
 * in hex. Before 7.0 the chain held the list as a set ordered by pallet; 7.0 made it a map by
 * pallet name (`primitives::v6`, `from_old_pallets`), which is what this applies to an older list.
 * Names are kept as stored: the chain matches them exactly, so a padded, misspelt or unknown one
 * stays as it is.
 */

export type Subset = Record<string, unknown>;

/** A subset as the chain's `SubsetRestriction` gives it */
export type Restriction<T> = { whole: null } | { these: T } | { except: T };

/** Extrinsic permissions in the index's form */
export type ExtrinsicPermissionsJson = Restriction<
  Record<string, { extrinsics: Restriction<string[]> }>
>;

/** A field by name, whatever casing the decoding gave it */
const field = (record: Subset, name: string): unknown =>
  Object.entries(record).find(([key]) => key.replace(/_/g, '').toLowerCase() === name)?.[1];

/** In byte order, as a `BTreeSet` or `BTreeMap` holds its keys */
const byteOrder = (a: string, b: string): number => {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
};

/** A `SubsetRestriction` with `convert` applied to its members; `Whole` stays */
const mapSubset = (subset: Subset, convert: (members: unknown[]) => unknown): Subset =>
  Object.fromEntries(
    Object.entries(subset).map(([kind, members]) => [
      kind,
      Array.isArray(members) ? convert(members) : members,
    ])
  );

/** One pallet's entry of a pre-7.0 list, as `[name, permissions]` */
const palletEntry = (pallet: Subset): [string, unknown] => {
  // v14 decoded names as bytes beside camelCase fields; the type bundle, as text beside snake_case
  const asText = (name: string): string =>
    'palletName' in pallet ? Buffer.from(name.replace(/^0x/, ''), 'hex').toString('utf8') : name;
  const names = (field(pallet, 'dispatchablenames') ?? {}) as Subset;
  return [
    asText(field(pallet, 'palletname') as string),
    {
      extrinsics: mapSubset(names, members =>
        [...new Set((members as string[]).map(asText))].sort(byteOrder)
      ),
    },
  ];
};

/** Extrinsic permissions as the index stores them; a value already in that form is unchanged */
export const canonicalExtrinsicPermissions = (permissions: Subset): Subset =>
  mapSubset(permissions, pallets =>
    Object.fromEntries((pallets as Subset[]).map(palletEntry).sort(([a], [b]) => byteOrder(a, b)))
  );

/** The authorizations whose payload is a key's `Permissions` */
export const PERMISSION_AUTHORIZATIONS = new Set(['JoinIdentity', 'RotatePrimaryKeyToSecondary']);

/**
 * A key's `Permissions` (`asset`, `extrinsic`, `portfolio`) with its extrinsic permissions in the
 * index's form, the other members unchanged and in their order.
 */
export const canonicalPermissions = (permissions: Subset): Subset =>
  Object.fromEntries(
    Object.entries(permissions).map(([member, value]) => [
      member,
      member === 'extrinsic' && value ? canonicalExtrinsicPermissions(value as Subset) : value,
    ])
  );

/**
 * An authorization's payload as the index stores it: a key's `Permissions` with its extrinsic
 * permissions in the index's form; any other payload as the chain gives it.
 */
export const authorizationData = (type: string, payload: unknown): unknown =>
  PERMISSION_AUTHORIZATIONS.has(type) && payload && typeof payload === 'object'
    ? canonicalPermissions(payload as Subset)
    : payload;
