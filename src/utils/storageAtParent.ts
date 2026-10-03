import { Option, StorageKey } from '@polkadot/types';
import { StorageEntryMetadataLatest } from '@polkadot/types/interfaces';
import { Codec } from '@polkadot/types/types';
import { SubstrateBlock } from '@subql/types';
import { ChainUpgrade } from '../types';
import { padId } from './common';

interface StorageItem {
  key: (...keys: unknown[]) => string;
  keyPrefix: () => string;
  creator: {
    meta: { type: { isMap: boolean; asMap?: { value: unknown }; asPlain?: unknown } };
  };
}

/**
 * Whether this block's registry describes the runtime that wrote its parent's state, decided once
 * per block.
 *
 * The parent's state was written by the runtime that executed the parent. On the first block after
 * an upgrade that is still the old runtime: the new one migrates the state only as it runs this
 * block. And on a block the dictionary mislabelled, the registry is a neighbouring runtime's.
 * Either way the bytes would be decoded with the wrong types, which can quietly yield a wrong
 * account rather than fail.
 *
 * Unless the parent carried a recorded upgrade (`ChainUpgrade.firstBlock`, the block with its
 * `system.CodeUpdated`), it ran the same runtime as this block, whose spec `ensureTrueSpecVersion`
 * has already set on the block, so no chain read is needed. Only on the block after an upgrade is
 * the runtime that wrote the parent's state read from the chain.
 */
const registryWroteParent = new WeakMap<SubstrateBlock, Promise<boolean>>();

const parentWriterSpec = async (block: SubstrateBlock): Promise<number> => {
  const parentId = padId(String(Number(block.block.header.number.toString()) - 1));
  const [upgradedInParent] = await store.getByFields<ChainUpgrade>(
    'ChainUpgrade',
    [['firstBlockId', '=', parentId]],
    { limit: 1 }
  );

  if (!upgradedInParent) {
    return block.specVersion;
  }

  const parent = await api.rpc.chain.getHeader(block.block.header.parentHash);
  return (await api.rpc.state.getRuntimeVersion(parent.parentHash)).specVersion.toNumber();
};

const parentReadable = (block: SubstrateBlock): Promise<boolean> => {
  let readable = registryWroteParent.get(block);

  if (!readable) {
    readable = (async () =>
      (await parentWriterSpec(block)) === api.runtimeVersion.specVersion.toNumber())();
    registryWroteParent.set(block, readable);
  }

  return readable;
};

/** `api.query[section][item]`, or `undefined` when this runtime has no such item. */
const storageItem = (section: string, item: string): StorageItem | undefined =>
  (api.query as unknown as Record<string, Record<string, StorageItem>>)[section]?.[item];

/** Reads one raw key at the parent hash and decodes it with this block's registry. */
const readAtParent = async (
  block: SubstrateBlock,
  storage: StorageItem,
  key: unknown
): Promise<Codec | undefined> => {
  const raw = (await api.rpc.state.getStorage(
    key as string,
    block.block.header.parentHash
  )) as unknown as Option<Codec>;

  if (raw.isNone) {
    return undefined;
  }

  const { type } = storage.creator.meta;
  const valueType = api.registry.createLookupType(
    (type.isMap ? type.asMap?.value : type.asPlain) as never
  );

  return api.registry.createType(valueType, raw.unwrap().toU8a(true)) as unknown as Codec;
};

/**
 * One storage value as it stood when `block` began: the state its extrinsics were checked against.
 *
 * `api.query` reads the state *after* the block being indexed, which is too late for anything the
 * runtime decided before a call ran: who pays its fee, say, or which slash an era start applies.
 * Read at the parent hash instead, as raw bytes decoded with this block's own registry, because a
 * decoded `getStorage` decodes with the connection's latest metadata, which misreads older
 * runtimes' types.
 *
 * `undefined` when nothing is stored, when this runtime has no such item, or when the parent's state
 * was written by a runtime other than the one this block's registry describes.
 */
export const storageAtParent = async (
  block: SubstrateBlock,
  section: string,
  item: string,
  ...keys: unknown[]
): Promise<Codec | undefined> => {
  const storage = storageItem(section, item);

  if (!storage || !(await parentReadable(block))) {
    return undefined;
  }

  return readAtParent(block, storage, storage.key(...keys));
};

/** How many keys one `state_getKeysPaged` call asks for. */
const KEYS_PER_PAGE = 1000;

/**
 * The arguments a map's storage key was built from, decoded with this block's registry as its value
 * is. Empty when they can't be: the key's hasher discards them (`Blake2_128`, say), or its bytes
 * don't fit the map's key type.
 *
 * Decoded by the API rather than sliced from the key here: inside the SubQuery sandbox the key's
 * bytes arrive proxied, and so does their `.buffer`, which a `DataView` over it rejects. Testnet
 * block 7,737,503 crashed the indexer 69 times reading a deferred slash's era that way.
 */
const keyArgs = (storage: StorageItem, key: { toHex: () => string }): Codec[] =>
  // hex, because `Bytes` reads a `Uint8Array` as length-prefixed, and a hashed key isn't
  (api.registry.createType('StorageKey', key.toHex()) as unknown as StorageKey).setMeta(
    storage.creator.meta as unknown as StorageEntryMetadataLatest
  ).args;

/**
 * Every entry of a storage map as it stood when `block` began, each with the arguments its key was
 * built from (see `keyArgs`). Empty when the map is; `undefined` when it can't be read, under the
 * same conditions as `storageAtParent`, so a caller can tell "nothing pending" from "couldn't
 * look".
 */
export const storageEntriesAtParent = async (
  block: SubstrateBlock,
  section: string,
  item: string
): Promise<{ args: Codec[]; value: Codec }[] | undefined> => {
  const storage = storageItem(section, item);

  if (!storage || !(await parentReadable(block))) {
    return undefined;
  }

  const prefix = storage.keyPrefix();
  const parentHash = block.block.header.parentHash;
  const entries: { args: Codec[]; value: Codec }[] = [];
  let after: unknown = prefix;

  for (;;) {
    const keys = await api.rpc.state.getKeysPaged(
      prefix,
      KEYS_PER_PAGE,
      after as string,
      parentHash
    );

    const values = await Promise.all(keys.map(key => readAtParent(block, storage, key)));

    keys.forEach((key, index) => {
      const value = values[index];
      if (value) {
        entries.push({ args: keyArgs(storage, key), value });
      }
    });

    if (keys.length < KEYS_PER_PAGE) {
      return entries;
    }

    after = keys[keys.length - 1];
  }
};
