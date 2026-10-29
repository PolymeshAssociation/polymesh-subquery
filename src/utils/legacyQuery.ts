import { QueryableStorageEntry } from '@polkadot/api-base/types';

/**
 * A storage entry by name, or `undefined` when this block's metadata has none. The augmented
 * `api.query` names only the current metadata's entries, so it is read here as a plain index for
 * entries a runtime may or may not carry.
 */
export const findStorage = (
  section: string,
  method: string
): QueryableStorageEntry<'promise'> | undefined => {
  const pallet = (
    api.query as Record<
      string,
      Record<string, QueryableStorageEntry<'promise'> | undefined> | undefined
    >
  )[section];

  return pallet?.[method];
};

/**
 * `polymesh-types` augments one metadata snapshot — the current one. An indexer reads
 * historical storage across every spec version the chain has ever had, so a storage entry the
 * chain has since removed has no generated type at all.
 *
 * Use this instead of casting an `api.query.<section>.<method>` lookup to `any`: it keeps the
 * read greppable, states the spec range it applies to next to itself, and throws immediately
 * if the entry is genuinely absent from the block's metadata rather than surfacing `undefined`
 * later at the call site.
 *
 * The return is deliberately untyped beyond `QueryableStorageEntry` — there is no generated
 * type for storage that no longer exists.
 *
 * @param section the pallet name
 * @param method the storage entry name
 * @param specRange the inclusive `[from, to]` spec versions this entry exists on, for the
 *   reader's benefit — not enforced here
 */
export const legacyQuery = (
  section: string,
  method: string,
  specRange: [number, number]
): QueryableStorageEntry<'promise'> => {
  const entry = findStorage(section, method);

  if (!entry) {
    throw new Error(
      `legacyQuery: no storage entry "${section}.${method}" in this block's metadata ` +
        `(expected for spec versions ${specRange[0]}-${specRange[1]})`
    );
  }

  return entry;
};
