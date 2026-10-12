import { ApiPromise } from '@polkadot/api';
import type { ApiDecoration } from '@polkadot/api/types';
import { Option, Raw } from '@polkadot/types';
import { Codec } from '@polkadot/types/types';
import { compactFromU8a, hexToString, u8aToBn } from '@polkadot/util';
import { encodeAddress } from '@polkadot/util-crypto';

/** The index's `HoldReason` members: a hold is filed under its pallet's name, or `Unknown` */
const HOLD_REASONS = ['Staking', 'Session', 'Preimage', 'Revive'];

/** A hold entry's bytes: the pallet's index, its fieldless `HoldReason`, and a `u128` amount */
const HOLD_BYTES = 1 + 1 + 16;

/** How many keys one `state_getKeysPaged` returns, and one `state_queryStorageAt` asks for */
const KEYS_PER_PAGE = 1000;

/** Amounts by lock id or hold reason, per account */
export type Parts = Map<string, Map<string, bigint>>;

const add = (parts: Parts, account: string, part: string, amount: bigint): void => {
  const own = parts.get(account) ?? new Map<string, bigint>();
  own.set(part, (own.get(part) ?? BigInt(0)) + amount);
  parts.set(account, own);
};

/** A hold's reason as the index names it, from the name of the pallet that placed it */
export const holdReasonOf = (pallet: string | undefined): string =>
  HOLD_REASONS.find(reason => reason.toLowerCase() === pallet?.toLowerCase()) ?? 'Unknown';

/**
 * `balances.holds(who)` from its raw bytes: a compact count, then per entry the pallet's index, its
 * fieldless `HoldReason` and a `u128`. Read raw because a list holding a reason today's metadata no
 * longer has (testnet's `contracts` holds) fails the typed decode as a whole. Throws on bytes that
 * don't fit that layout.
 */
export const parseHolds = (
  raw: Uint8Array,
  pallets: Map<number, string>
): { reason: string; amount: bigint }[] => {
  const [offset, count] = compactFromU8a(raw);

  if (raw.length !== offset + count.toNumber() * HOLD_BYTES) {
    throw new Error(`${raw.length} bytes of holds don't fit ${count.toNumber()} entries`);
  }

  return Array.from({ length: count.toNumber() }, (_, index) => {
    const start = offset + index * HOLD_BYTES;
    return {
      reason: holdReasonOf(pallets.get(raw[start])),
      amount: BigInt(u8aToBn(raw.subarray(start + 2, start + HOLD_BYTES)).toString()),
    };
  });
};

/** Every account's locks on chain, by lock id (`staking `, `pips    `, …) */
export const chainLocks = async (at: ApiDecoration<'promise'>): Promise<Parts> => {
  const locks: Parts = new Map();
  (await at.query.balances.locks.entries()).forEach(([key, list]) =>
    (list as unknown as { id: Codec; amount: Codec }[]).forEach(lock =>
      add(
        locks,
        key.args[0].toString(),
        hexToString(lock.id.toHex()),
        BigInt(lock.amount.toString())
      )
    )
  );
  return locks;
};

/** Every key under `prefix` at `hash`, a page at a time */
const allKeys = async (
  api: ApiPromise,
  prefix: string,
  hash: string,
  after = prefix,
  found: string[] = []
): Promise<string[]> => {
  const page = (await api.rpc.state.getKeysPaged(prefix, KEYS_PER_PAGE, after, hash)).map(key =>
    key.toHex()
  );
  found.push(...page);
  return page.length < KEYS_PER_PAGE
    ? found
    : allKeys(api, prefix, hash, page[page.length - 1], found);
};

/**
 * Every account's holds on chain from v8, by reason; empty before v8, which has no holds. Each
 * value is read raw (see `parseHolds`), and each account taken from the last 32 bytes of its key
 * (`Blake2_128Concat` keeps the account after its hash).
 */
export const chainHolds = async (
  api: ApiPromise,
  at: ApiDecoration<'promise'>,
  hash: string
): Promise<Parts> => {
  const holds: Parts = new Map();
  const item = (at.query.balances as unknown as Record<string, unknown>).holds as
    | { keyPrefix: () => string }
    | undefined;
  if (!item) {
    return holds;
  }

  const pallets = new Map(
    at.registry.metadata.pallets.map(pallet => [pallet.index.toNumber(), pallet.name.toString()])
  );
  const keys = await allKeys(api, item.keyPrefix(), hash);
  const pages = Array.from({ length: Math.ceil(keys.length / KEYS_PER_PAGE) }, (_, i) =>
    keys.slice(i * KEYS_PER_PAGE, (i + 1) * KEYS_PER_PAGE)
  );
  const values = await Promise.all(
    pages.map(
      async page => (await api.rpc.state.queryStorageAt(page, hash)) as unknown as Option<Raw>[]
    )
  );

  pages.forEach((page, p) =>
    page.forEach((key, index) => {
      const value = values[p][index];
      if (value.isNone) {
        return;
      }
      const account = encodeAddress(`0x${key.slice(-64)}`, api.registry.chainSS58);
      parseHolds(value.unwrap().toU8a(true), pallets).forEach(({ reason, amount }) =>
        add(holds, account, reason, amount)
      );
    })
  );
  return holds;
};
