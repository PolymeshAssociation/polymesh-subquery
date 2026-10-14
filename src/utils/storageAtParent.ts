import { QueryableStorageEntry } from '@polkadot/api-base/types';
import { Codec } from '@polkadot/types/types';
import { SubstrateBlock } from '@subql/types';
import { ChainUpgrade } from '../types';
import { itemsOf, optionOf } from './codec';
import { padId } from './common';
import { findStorage } from './legacyQuery';

type StorageItem = QueryableStorageEntry<'promise'>;

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

/**
 * A storage key or value this block's registry cannot encode or decode. Unlike a failed read, it
 * fails the same way on every retry, so callers handle it rather than fail the block.
 */
export class UndecodableStateError extends Error {
  constructor(what: string, cause: unknown) {
    super(cause instanceof Error ? `${what}: ${cause.message}` : what, { cause });
    this.name = 'UndecodableStateError';
  }
}

/**
 * The messages polkadot-js gives a value its types can't hold: `createType(<type>):: …` wraps every
 * codec construction, with `Struct: failed on …`, `Tuple: failed on …` and `decodeU8a…` naming the
 * member, `Unable to create Enum via index …` for an unknown variant, and `Unable to decode
 * storage …` from the RPC layer's own decode of a query result.
 */
const DECODE_FAILURE =
  /createType\(|Unable to decode|Unable to create Enum|decodeU8a|(?:Struct|Tuple|Enum): failed on|Cannot construct unknown type|Expected input with \d+ bytes/;

/**
 * Whether `error` is a stored value failing to decode with the registry, as opposed to the read
 * failing (a dropped connection, a timeout, a node error such as `1006: Abnormal Closure` or
 * `-32000`). The first fails the same way on every retry; the second may not.
 */
export const isDecodeFailure = (error: unknown): boolean =>
  error instanceof Error && DECODE_FAILURE.test(error.message);

/**
 * Runs a storage read, `what` naming the item and account for the message. A value that doesn't
 * decode becomes an `UndecodableStateError`, which callers record and carry on from, since retrying
 * the block would fail identically; any other error propagates unchanged so the block still fails
 * and is retried.
 */
export const readStorage = async <T>(what: string, run: () => Promise<T> | T): Promise<T> => {
  try {
    return await run();
  } catch (cause) {
    if (isDecodeFailure(cause) && !(cause instanceof UndecodableStateError)) {
      throw new UndecodableStateError(`could not decode ${what}`, cause);
    }
    throw cause;
  }
};

const decoding = <T>(what: string, run: () => T): T => {
  try {
    return run();
  } catch (cause) {
    throw new UndecodableStateError(what, cause);
  }
};

/** A stored value's raw bytes decoded with this block's registry; `undefined` when nothing is stored */
const decodeStored = (storage: StorageItem, raw: unknown, name: string): Codec | undefined => {
  const stored = optionOf(raw, `the stored ${name}`);

  if (!stored) {
    return undefined;
  }

  return decoding(`could not decode ${name}`, () => {
    const { type } = storage.creator.meta;
    const valueType = api.registry.createLookupType(
      (type.isMap ? type.asMap?.value : type.asPlain) as never
    );

    // the host's bytes, for the host's registry
    // eslint-disable-next-line no-restricted-syntax
    return api.registry.createType(valueType, stored.toU8a(true));
  });
};

/** Reads one raw key at the parent hash and decodes it with this block's registry. */
const readAtParent = async (
  block: SubstrateBlock,
  storage: StorageItem,
  key: unknown,
  name: string
): Promise<Codec | undefined> =>
  decodeStored(
    storage,
    await api.rpc.state.getStorage(key as string, block.block.header.parentHash),
    name
  );

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
 * was written by a runtime other than the one this block's registry describes. Throws
 * `UndecodableStateError` when the keys or the value don't fit the item's types.
 */
export const storageAtParent = async (
  block: SubstrateBlock,
  section: string,
  item: string,
  ...keys: unknown[]
): Promise<Codec | undefined> => {
  const storage = findStorage(section, item);

  if (!storage || !(await parentReadable(block))) {
    return undefined;
  }

  const name = `${section}.${item}`;
  const key = decoding(`could not encode a key for ${name}`, () => storage.key(...keys));

  return readAtParent(block, storage, key, name);
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
const keyArgs = (storage: StorageItem, key: { toHex: () => string }): Codec[] => {
  // hex, because `Bytes` reads a `Uint8Array` as length-prefixed, and a hashed key isn't
  const storageKey = api.registry.createType('StorageKey', key.toHex());
  return storageKey.setMeta(storage.creator.meta).args;
};

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
  const storage = findStorage(section, item);

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

    // an empty page has nothing to fetch, and the node answers an empty key list with no
    // result at all, which the RPC layer cannot map
    if (keys.length === 0) {
      return entries;
    }

    // one round trip for the page, rather than one per key
    const raws = itemsOf(await api.rpc.state.queryStorageAt(keys, parentHash), 'the stored page');

    keys.forEach((key, index) => {
      const value = decodeStored(storage, raws[index], `${section}.${item}`);
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
