/**
 * Records the key and value types of every storage item a resolver reads, across every runtime a
 * chain has run, for the storage-history test: the spec versions over which each item kept one
 * shape, its key types and hashers, and its value type.
 *
 * Each chain's runtimes are the ones `survey-event-history.ts` recorded in `event-history.json`,
 * and each is read from the metadata at its first block. A chain whose head runs a runtime that
 * file doesn't list is refused: re-run the event survey first. Several chains are merged onto one
 * spec-version scale; a spec version two chains describe differently is a hard error.
 *
 *   yarn ts-node scripts/survey-storage-history.ts mainnet=<archive rpc> testnet=<archive rpc> …
 *
 * The rpc is HTTP JSON-RPC to an archive node. The output, `tests/fixtures/storage-history.json`, is
 * history: re-run it after a runtime upgrade, and review every changed range. Each item's `pruned`
 * note is written by hand from the pallet source and kept across runs.
 */
import { Metadata, TypeRegistry } from '@polkadot/types';
import { stringCamelCase } from '@polkadot/util';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import eventHistory from '../tests/fixtures/event-history.json';
import { byCodeUnit } from '../src/utils/order';
import { chainArgs, metadataAt, Runtime, rpc, SURVEYED_SECTIONS } from './lib/runtimeSurvey';

const OUT = join(__dirname, '..', 'tests', 'fixtures', 'storage-history.json');

/** The pallets whose storage a resolver or a start-block seed reads */

export interface StorageShape {
  /** each key's type, in order; empty for a plain value */
  keys: string[];
  value: string;
  hashers: string[];
}

export interface StorageRange extends StorageShape {
  from: number;
  /** `null` when the newest runtime surveyed still has this shape */
  to: number | null;
  /** The chains that ran a spec version in this range */
  chains: string[];
}

export interface StorageItemHistory {
  ranges: StorageRange[];
  /** When the chain removes an entry, read from the pallet source; absent when it never does */
  pruned?: string;
}

export type StorageHistory = Record<string, StorageItemHistory>;

/** `section.item` to its shape, for every item of the surveyed pallets */
const shapesOf = (hex: string): Map<string, StorageShape> => {
  const registry = new TypeRegistry();
  const metadata = new Metadata(registry, hex as `0x${string}`);
  registry.setMetadata(metadata);
  // a runtime-level type is named after its runtime crate, which differs between chains
  const typeOf = (id: Parameters<typeof registry.lookup.getTypeDef>[0]): string =>
    registry.lookup
      .getTypeDef(id)
      .type.toString()
      .replace(/PolymeshRuntime(?:Mainnet|Testnet|Develop)Runtime/g, 'PolymeshRuntimeRuntime');
  const shapes = new Map<string, StorageShape>();

  for (const pallet of metadata.asLatest.pallets) {
    const section = stringCamelCase(pallet.name.toString());
    if (pallet.storage.isNone || !SURVEYED_SECTIONS.includes(section)) {
      continue;
    }
    for (const item of pallet.storage.unwrap().items) {
      const name = `${section}.${stringCamelCase(item.name.toString())}`;
      if (item.type.isPlain) {
        shapes.set(name, { keys: [], value: typeOf(item.type.asPlain), hashers: [] });
        continue;
      }
      const { hashers, key, value } = item.type.asMap;
      const keyIds =
        hashers.length > 1 ? registry.lookup.getSiType(key).def.asTuple.toArray() : [key];
      shapes.set(name, {
        keys: keyIds.map(typeOf),
        value: typeOf(value),
        hashers: hashers.map(hasher => hasher.type.toString()),
      });
    }
  }

  return shapes;
};

const sameShape = (a: StorageShape, b: StorageShape): boolean =>
  JSON.stringify([a.keys, a.value, a.hashers]) === JSON.stringify([b.keys, b.value, b.hashers]);

type BySpec = Map<number, Map<string, Map<string, StorageShape>>>;

/** The spec ranges over which `name` kept one shape, noting where chains disagree */
const rangesOf = (
  name: string,
  specs: number[],
  bySpec: BySpec,
  conflicts: string[]
): StorageRange[] => {
  const ranges: StorageRange[] = [];
  let open: StorageRange | undefined;
  for (const spec of specs) {
    const perChain = bySpec.get(spec) as Map<string, Map<string, StorageShape>>;
    const seen = Array.from(perChain.entries()).filter(([, shapes]) => shapes.has(name));
    if (seen.length === 0) {
      open = undefined;
      continue;
    }
    const shape = seen[0][1].get(name) as StorageShape;
    if (seen.some(([, shapes]) => !sameShape(shapes.get(name) as StorageShape, shape))) {
      conflicts.push(`${name} at ${spec}`);
    }
    const chainsHere = seen.map(([chain]) => chain);
    if (open && sameShape(open, shape)) {
      open.to = spec;
      open.chains = Array.from(new Set([...open.chains, ...chainsHere])).sort(byCodeUnit);
    } else {
      chainsHere.sort(byCodeUnit);
      open = { from: spec, to: spec, ...shape, chains: chainsHere };
      ranges.push(open);
    }
  }
  const newest = specs.at(-1);
  ranges.forEach(range => {
    if (range.to === newest) {
      range.to = null;
    }
  });
  return ranges;
};

const main = async () => {
  const chains = chainArgs(process.argv.slice(2));
  if (chains.length === 0) {
    console.error('usage: survey-storage-history.ts <chain>=<archive rpc> …');
    process.exit(1);
  }

  const bySpec: BySpec = new Map();
  await Promise.all(
    chains.map(async ([chain, url]) => {
      const runtimes = (eventHistory.chains as Record<string, { runtimes: Runtime[] }>)[chain]
        ?.runtimes;
      if (!runtimes) {
        throw new Error(`event-history.json records no runtimes for ${chain}`);
      }
      const { specVersion } = await rpc<{ specVersion: number }>(
        url,
        'state_getRuntimeVersion',
        []
      );
      if (specVersion !== runtimes.at(-1)?.specVersion) {
        throw new Error(
          `${chain} runs spec ${specVersion}, which event-history.json doesn't list: re-run survey-event-history.ts`
        );
      }
      console.log(`${chain}: ${runtimes.length} runtimes`);
      const metadata = await Promise.all(runtimes.map(runtime => metadataAt(chain, url, runtime)));
      runtimes.forEach((runtime, index) => {
        const entry = bySpec.get(runtime.specVersion) ?? new Map();
        entry.set(chain, shapesOf(metadata[index]));
        bySpec.set(runtime.specVersion, entry);
      });
    })
  );

  const previous: StorageHistory = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : {};
  const conflicts: string[] = [];
  const specs = Array.from(bySpec.keys()).sort((a, b) => a - b);
  const names = new Set(
    Array.from(bySpec.values()).flatMap(perChain =>
      Array.from(perChain.values()).flatMap(shapes => Array.from(shapes.keys()))
    )
  );

  const history: StorageHistory = {};
  for (const name of Array.from(names).sort(byCodeUnit)) {
    const pruned = previous[name]?.pruned;
    history[name] = { ranges: rangesOf(name, specs, bySpec, conflicts), ...(pruned && { pruned }) };
  }

  if (conflicts.length) {
    console.error(`chains disagree about:\n  ${conflicts.join('\n  ')}`);
    process.exit(1);
  }

  writeFileSync(OUT, `${JSON.stringify(history, null, 1)}\n`);
  console.log(`${names.size} storage items over ${specs.length} spec versions -> ${OUT}`);
};

void main();
