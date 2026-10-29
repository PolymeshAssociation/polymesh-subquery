/**
 * Records every event's parameters across every runtime a chain has run, for the shape-history
 * test: the spec versions over which each event kept the same fields, their names when the
 * metadata gives them, and their types.
 *
 * Each runtime is found by bisecting the chain for the blocks where the spec version changes, and
 * read from the metadata at its first block, so the record does not depend on any event having
 * been emitted. Several chains are merged onto the one spec-version scale the shape table uses;
 * a spec version two chains report differently is a hard error.
 *
 *   yarn ts-node scripts/survey-event-history.ts mainnet=<archive rpc> testnet=<archive rpc> …
 *
 * The rpc is HTTP JSON-RPC to an archive node. The output, `tests/fixtures/event-history.json`,
 * is history: re-run it after a runtime upgrade, and review every changed range.
 */
import { Metadata, TypeRegistry } from '@polkadot/types';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chainArgs, headOf, metadataAt, Runtime, runtimesOf } from './lib/runtimeSurvey';

const OUT = join(__dirname, '..', 'tests', 'fixtures', 'event-history.json');

interface Signature {
  /** Field names, camelCased; `null` for a field the metadata does not name */
  fields: (string | null)[];
  types: string[];
}

export interface EventRange extends Signature {
  from: number;
  to: number;
  /** The chains that ran a spec version in this range */
  chains: string[];
}

export interface EventHistory {
  chains: Record<string, { head: number; runtimes: Runtime[] }>;
  events: Record<string, EventRange[]>;
}

const camelCase = (name: string): string =>
  name.replace(/_([a-zA-Z0-9])/g, (_match, c: string) => c.toUpperCase());

const sectionId = (name: string): string => name[0].toLowerCase() + name.slice(1);

/** `section.Event` to its signature, for every event the runtime declares */
const signaturesOf = (hex: string): Map<string, Signature> => {
  const registry = new TypeRegistry();
  const metadata = new Metadata(registry, hex as `0x${string}`);
  registry.setMetadata(metadata);
  const signatures = new Map<string, Signature>();

  for (const pallet of metadata.asLatest.pallets) {
    if (pallet.events.isNone) {
      continue;
    }
    const type = registry.lookup.getSiType(pallet.events.unwrap().type);
    if (!type.def.isVariant) {
      continue;
    }
    for (const variant of type.def.asVariant.variants) {
      signatures.set(`${sectionId(pallet.name.toString())}.${variant.name.toString()}`, {
        fields: variant.fields.map(({ name }) =>
          name.isSome ? camelCase(name.unwrap().toString()) : null
        ),
        types: variant.fields.map(({ type, typeName }) =>
          typeName.isSome
            ? typeName.unwrap().toString()
            : registry.lookup.getTypeDef(type).type.toString()
        ),
      });
    }
  }

  return signatures;
};

/** Code-unit order, as a plain `sort()` gives, so the fixture's order doesn't depend on locale */
const byCodeUnit = (a: string, b: string): number => {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
};

const sameSignature = (a: Signature, b: Signature): boolean =>
  JSON.stringify([a.fields, a.types]) === JSON.stringify([b.fields, b.types]);

type BySpec = Map<number, Map<string, Map<string, Signature>>>;

/** Every runtime of one chain, and each one's event signatures, filed by spec version */
const surveyChain = async (
  chain: string,
  url: string,
  history: EventHistory,
  bySpec: BySpec
): Promise<void> => {
  const head = await headOf(url);
  const runtimes = await runtimesOf(url, head);
  history.chains[chain] = { head, runtimes };
  console.log(`${chain}: ${runtimes.length} runtimes to block ${head}`);

  const metadata = await Promise.all(runtimes.map(runtime => metadataAt(chain, url, runtime)));
  runtimes.forEach((runtime, index) => {
    const entry = bySpec.get(runtime.specVersion) ?? new Map();
    entry.set(chain, signaturesOf(metadata[index]));
    bySpec.set(runtime.specVersion, entry);
  });
};

/** The spec ranges over which `name` kept one signature, noting where chains disagree */
const rangesOf = (
  name: string,
  specs: number[],
  bySpec: BySpec,
  conflicts: string[]
): EventRange[] => {
  const ranges: EventRange[] = [];
  let open: EventRange | undefined;
  for (const spec of specs) {
    const perChain = bySpec.get(spec) as Map<string, Map<string, Signature>>;
    const seen = Array.from(perChain.entries()).filter(([, signatures]) => signatures.has(name));
    if (seen.length === 0) {
      open = undefined;
      continue;
    }
    const signature = seen[0][1].get(name) as Signature;
    if (
      seen.some(([, signatures]) => !sameSignature(signatures.get(name) as Signature, signature))
    ) {
      conflicts.push(`${name} at ${spec}`);
    }
    const chainsHere = seen.map(([chain]) => chain);
    if (open && sameSignature(open, signature)) {
      open.to = spec;
      open.chains = Array.from(new Set([...open.chains, ...chainsHere])).sort(byCodeUnit);
    } else {
      chainsHere.sort(byCodeUnit);
      open = { from: spec, to: spec, ...signature, chains: chainsHere };
      ranges.push(open);
    }
  }
  return ranges;
};

const main = async () => {
  const chains = chainArgs(process.argv.slice(2));
  if (chains.length === 0) {
    console.error('usage: survey-event-history.ts <chain>=<archive rpc> …');
    process.exit(1);
  }

  const history: EventHistory = { chains: {}, events: {} };
  const bySpec: BySpec = new Map();
  await Promise.all(chains.map(([chain, url]) => surveyChain(chain, url, history, bySpec)));

  const conflicts: string[] = [];
  const specs = Array.from(bySpec.keys()).sort((a, b) => a - b);
  const names = new Set(
    Array.from(bySpec.values()).flatMap(perChain =>
      Array.from(perChain.values()).flatMap(signatures => Array.from(signatures.keys()))
    )
  );

  for (const name of Array.from(names).sort(byCodeUnit)) {
    history.events[name] = rangesOf(name, specs, bySpec, conflicts);
  }

  if (conflicts.length) {
    console.error(`chains disagree about:\n  ${conflicts.join('\n  ')}`);
    process.exit(1);
  }

  writeFileSync(OUT, `${JSON.stringify(history, null, 1)}\n`);
  console.log(`${names.size} events over ${specs.length} spec versions -> ${OUT}`);
};

void main();
