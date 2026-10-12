import type { ApiDecoration } from '@polkadot/api/types';
import { Codec } from '@polkadot/types/types';
import { hexStripPrefix, stringToHex, u8aToHex } from '@polkadot/util';
import { blake2AsU8a } from '@polkadot/util-crypto';

const big = (value: string): bigint => BigInt(value);

/** The index's asset id for a storage key: an `AssetId` from v7, a `Ticker` before. */
export const assetIdOf = (raw: Codec, staging: boolean): string => {
  const hex = raw.toHex();

  if (hexStripPrefix(hex).length === 32) {
    return hex;
  }

  // the same derivation as `getAssetIdForLegacyTicker`
  const bytes = blake2AsU8a(
    `0x${hexStripPrefix(stringToHex('legacy_ticker'))}${hexStripPrefix(hex)}`,
    128
  );
  if (!staging) {
    bytes[6] = (bytes[6] & 0x0f) | 0x80;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
  }
  return u8aToHex(bytes);
};

/** Each asset's total supply on chain: `asset.assets` from v7, `asset.tokens` by ticker before */
export const chainSupplies = async (at: ApiDecoration<'promise'>, staging: boolean) => {
  const query = at.query.asset as unknown as Record<
    string,
    { entries?: () => Promise<[{ args: Codec[] }, Codec][]> } | undefined
  >;
  const source = query.assets?.entries ? query.assets : query.tokens;
  const supplies = new Map<string, bigint>();

  (await source?.entries?.())?.forEach(([key, value]) => {
    const details = value.toJSON() as { totalSupply?: unknown; total_supply?: unknown } | null;
    if (details) {
      supplies.set(
        assetIdOf(key.args[0], staging),
        big(String(details.totalSupply ?? details.total_supply ?? 0))
      );
    }
  });
  return supplies;
};

/** The identity each account is a key of, from `identity.keyRecords` */
export const identitiesOf = async (at: ApiDecoration<'promise'>, accounts: string[]) => {
  const records = await Promise.all(
    chunks(accounts, 300).map(part =>
      (
        at.query.identity as unknown as {
          keyRecords: { multi: (keys: string[]) => Promise<Codec[]> };
        }
      ).keyRecords.multi(part)
    )
  );
  const identities = new Map<string, string>();
  records.flat().forEach((record, index) => {
    const json = record.toJSON() as {
      primaryKey?: string;
      secondaryKey?: string | [string, unknown];
    } | null;
    const secondary = Array.isArray(json?.secondaryKey)
      ? json?.secondaryKey[0]
      : json?.secondaryKey;
    const did = json?.primaryKey ?? secondary;
    if (did) {
      identities.set(accounts[index], did);
    }
  });
  return identities;
};

export const chunks = <T>(items: T[], size: number): T[][] =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, i) =>
    items.slice(i * size, i * size + size)
  );
