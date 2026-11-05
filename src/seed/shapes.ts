import { QueryableStorageEntry } from '@polkadot/api-base/types';
import { Registry } from '@polkadot/types/types';

/**
 * A storage item's shape, its key types, value type and key hashers, as the storage survey records
 * it in `tests/fixtures/storage-history.json`. A runtime-level type is named after its runtime
 * crate, which differs between chains, so that part of a name is normalised.
 */
export interface StorageShape {
  keys: string[];
  value: string;
  hashers: string[];
}

/** The shape of an item as described by `registry`, which is the block's for a live read */
export const shapeOfItem = (
  registry: Pick<Registry, 'lookup'>,
  type: QueryableStorageEntry<'promise'>['creator']['meta']['type']
): StorageShape => {
  const typeOf = (id: Parameters<Registry['lookup']['getTypeDef']>[0]): string =>
    registry.lookup
      .getTypeDef(id)
      .type.toString()
      .replace(/PolymeshRuntime(?:Mainnet|Testnet|Develop)Runtime/g, 'PolymeshRuntimeRuntime');

  if (type.isPlain) {
    return { keys: [], value: typeOf(type.asPlain), hashers: [] };
  }
  const { hashers, key, value } = type.asMap;
  const keyIds = hashers.length > 1 ? registry.lookup.getSiType(key).def.asTuple.toArray() : [key];
  return {
    keys: keyIds.map(typeOf),
    value: typeOf(value),
    hashers: hashers.map(hasher => hasher.type.toString()),
  };
};

/** A shape as one comparable string */
export const shapeKey = ({ keys, value, hashers }: StorageShape): string =>
  JSON.stringify([keys, value, hashers]);

/** An item's shape at the block being indexed, as a comparable string */
export const shapeOf = (storage: QueryableStorageEntry<'promise'>): string =>
  shapeKey(shapeOfItem(api.registry, storage.creator.meta.type));
