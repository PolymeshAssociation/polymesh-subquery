/**
 * Records a chain's genesis state for the pallets the seed reads, so the seed's tests run on a real
 * genesis without a node: every key and raw value of those pallets at block 0, and the runtime's
 * metadata to decode them with.
 *
 *   yarn ts-node scripts/record-genesis.ts testnet=https://… mainnet=https://…
 *
 * Writes `tests/fixtures/genesis/<chain>.json.gz`.
 */
import { Metadata, TypeRegistry } from '@polkadot/types';
import { stringCamelCase } from '@polkadot/util';
import { xxhashAsHex } from '@polkadot/util-crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { chainArgs, rpc, SURVEYED_SECTIONS } from './lib/runtimeSurvey';

const OUT = join(__dirname, '..', 'tests', 'fixtures', 'genesis');
const PAGE = 1000;

export interface GenesisFixture {
  specVersion: number;
  metadata: string;
  /** `section.item` to its entries, each a raw key and value */
  storage: Record<string, [string, string][]>;
}

/** Every entry stored under `keyPrefix` at block `at`, a page of keys at a time */
const entriesUnder = async (
  url: string,
  keyPrefix: string,
  at: string
): Promise<[string, string][]> => {
  const entries: [string, string][] = [];
  let after = keyPrefix;
  for (;;) {
    const keys = await rpc<string[]>(url, 'state_getKeysPaged', [keyPrefix, PAGE, after, at]);
    if (keys.length) {
      const [{ changes }] = await rpc<{ changes: [string, string | null][] }[]>(
        url,
        'state_queryStorageAt',
        [keys, at]
      );
      changes.forEach(([key, value]) => value !== null && entries.push([key, value]));
    }
    const last = keys.at(-1);
    if (!last || keys.length < PAGE) {
      return entries;
    }
    after = last;
  }
};

const record = async (url: string): Promise<GenesisFixture> => {
  const at = await rpc<string>(url, 'chain_getBlockHash', [0]);
  const metadata = await rpc<string>(url, 'state_getMetadata', [at]);
  const { specVersion } = await rpc<{ specVersion: number }>(url, 'state_getRuntimeVersion', [at]);
  const registry = new TypeRegistry();
  const decoded = new Metadata(registry, metadata as `0x${string}`);
  const items = decoded.asLatest.pallets.flatMap(pallet => {
    const section = stringCamelCase(pallet.name.toString());
    if (pallet.storage.isNone || !SURVEYED_SECTIONS.includes(section)) {
      return [];
    }
    const { prefix, items: palletItems } = pallet.storage.unwrap();
    return palletItems.map(item => ({
      name: `${section}.${stringCamelCase(item.name.toString())}`,
      keyPrefix: `${xxhashAsHex(prefix.toString(), 128)}${xxhashAsHex(
        item.name.toString(),
        128
      ).slice(2)}`,
    }));
  });
  const read = await Promise.all(
    items.map(
      async ({ name, keyPrefix }) => [name, await entriesUnder(url, keyPrefix, at)] as const
    )
  );
  const storage: GenesisFixture['storage'] = Object.fromEntries(
    read.filter(([, entries]) => entries.length)
  );
  return { specVersion, metadata, storage };
};

const main = async () => {
  mkdirSync(OUT, { recursive: true });
  await Promise.all(
    chainArgs(process.argv.slice(2)).map(async ([chain, url]) => {
      const fixture = await record(url);
      writeFileSync(join(OUT, `${chain}.json.gz`), gzipSync(JSON.stringify(fixture)));
      const counts = Object.entries(fixture.storage).map(
        ([item, entries]) => `${item} ${entries.length}`
      );
      console.log(chain, fixture.specVersion, counts.join(', '));
    })
  );
};

void main();
