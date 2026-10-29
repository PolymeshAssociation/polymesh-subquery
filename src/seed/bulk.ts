import { Codec } from '@polkadot/types/types';
import { SubstrateBlock } from '@subql/types';
import { itemsOf } from '../utils/codec';
import { findStorage } from '../utils/legacyQuery';
import {
  decodeStored,
  keyArgs,
  parentStateReadable,
  UndecodableStateError,
} from '../utils/storageAtParent';

/**
 * Bulk reads of the state a block began from, for the start-block seed: a storage item read whole,
 * a page of 1,000 keys at a time with one request for the page's values, or known keys a batch of
 * 1,000 at a time. No more than `MAX_IN_FLIGHT` requests reach the endpoint at once, however many
 * scans run, so a seed doesn't overload it.
 */

const PAGE = 1000;
const MAX_IN_FLIGHT = 4;

/** Runs requests no more than `max` at once, the rest waiting their turn in order */
export const concurrencyLimit = (max: number) => {
  let running = 0;
  const waiting: (() => void)[] = [];
  return {
    max,
    run: async <T>(request: () => Promise<T>): Promise<T> => {
      if (running >= max) {
        await new Promise<void>(resolve => waiting.push(resolve));
      }
      running += 1;
      try {
        return await request();
      } finally {
        running -= 1;
        waiting.shift()?.();
      }
    },
  };
};

/** The requests the seed has in flight, shared by every scan */
const limiter = concurrencyLimit(MAX_IN_FLIGHT);

/** Test hook */
export const __limiter = limiter;

export interface ScannedEntry {
  /** the arguments the entry's key was built from */
  args: Codec[];
  /** the value, decoded with the block's registry; `undefined` when it doesn't decode */
  value: Codec | undefined;
  /** the stored value as the node returned it, for an entry whose value doesn't decode */
  raw: unknown;
}

const itemOf = (section: string, item: string) => findStorage(section, item);

const ensureReadable = async (block: SubstrateBlock): Promise<void> => {
  if (!(await parentStateReadable(block))) {
    throw new Error(
      `the state block ${block.block.header.number.toString()} began from was written by another runtime, which its registry can't read`
    );
  }
};

/** A stored value decoded, or `undefined` with its raw form kept when it doesn't decode */
const decoded = (storage: NonNullable<ReturnType<typeof itemOf>>, raw: unknown, name: string) => {
  try {
    return decodeStored(storage, raw, name);
  } catch (error) {
    if (error instanceof UndecodableStateError) {
      return undefined;
    }
    throw error;
  }
};

/** The node refused to return a response this large, so the request is to be made smaller */
const isTooBig = (error: unknown): boolean =>
  error instanceof Error && /Response is too big/.test(error.message);

/**
 * The stored values of `keys` at `at`, one request where the response fits the node's limit, and
 * halved until it does: a page of runtime-upgrade PIPs, each carrying a runtime, can exceed it.
 */
const valuesAt = async (keys: unknown[], at: unknown, what: string): Promise<unknown[]> => {
  try {
    return itemsOf(
      await limiter.run(() => api.rpc.state.queryStorageAt(keys as never, at as never)),
      what
    );
  } catch (error) {
    if (!isTooBig(error) || keys.length < 2) {
      throw error;
    }
    const half = Math.ceil(keys.length / 2);
    return [
      ...(await valuesAt(keys.slice(0, half), at, what)),
      ...(await valuesAt(keys.slice(half), at, what)),
    ];
  }
};

/**
 * Every entry of a storage item as it stood when `block` began, a page at a time, or only those
 * under leading key arguments `prefix`. Nothing for an item the runtime lacks; an error for a block
 * whose parent another runtime wrote.
 */
export async function* scanAtParent(
  block: SubstrateBlock,
  section: string,
  item: string,
  ...prefix: unknown[]
): AsyncGenerator<ScannedEntry[]> {
  const storage = itemOf(section, item);
  if (!storage) {
    return;
  }
  await ensureReadable(block);

  const name = `${section}.${item}`;
  const keyPrefix = storage.keyPrefix(...prefix);
  const parentHash = block.block.header.parentHash;
  let after: unknown = keyPrefix;

  for (;;) {
    const keys = await limiter.run(() =>
      api.rpc.state.getKeysPaged(keyPrefix, PAGE, after as string, parentHash)
    );
    // the node answers an empty key list with no result at all, so an empty page isn't asked for
    if (keys.length === 0) {
      return;
    }
    const raws = await valuesAt([...keys], parentHash, `the stored page of ${name}`);

    yield keys.map((key, index) => ({
      args: keyArgs(storage, key),
      value: decoded(storage, raws[index], name),
      raw: raws[index],
    }));

    if (keys.length < PAGE) {
      return;
    }
    after = keys[keys.length - 1];
  }
}

/** The key under which a snapshot's `map` files an entry: its key arguments, joined by `/` */
export const entryKey = (args: Codec[]): string => args.map(arg => arg.toString()).join('/');
