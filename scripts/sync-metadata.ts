/**
 * Regenerates the hand-maintained chain enums in `schema.graphql` from runtime metadata, and
 * reports what changed.
 *
 * `ModuleIdEnum`, `EventIdEnum` and `CallIdEnum` are ~53% of `schema.graphql` and are maintained
 * by hand today, so an event the chain added is only noticed when something downstream breaks.
 * `TransferWithMemo` arrived at 7.4.0 and went unhandled; the drift report below is what would
 * have surfaced it the day it landed.
 *
 * Two reports, both printed on every run:
 *
 *   1. events added, removed or reshaped since each captured spec version;
 *   2. events the chain emits, whose pallet `project.ts` subscribes to, that no handler reads.
 *
 * Migration files are deliberately not generated. Decision D5 is a full resync from genesis, so
 * there is nothing to `ALTER TYPE` - migrations matter again only for changes made after that
 * reset.
 *
 * Usage:
 *
 *   yarn sync-metadata --endpoint wss://…            report only
 *   yarn sync-metadata --endpoint wss://… --write    also update the schema and the arity fixture
 *   yarn sync-metadata --metadata ./metadata.json    read a `state_getMetadata` dump instead
 *   yarn sync-metadata --endpoint wss://… --check    exit non-zero when the schema is behind
 */
import { Metadata, TypeRegistry } from '@polkadot/types';
import { readdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import project from '../project';

const ROOT = join(__dirname, '..');
const SCHEMA_PATH = join(ROOT, 'schema.graphql');
const ARITY_DIR = join(ROOT, 'tests', 'fixtures', 'event-arity');

/** The pallets whose event shapes the decode layer registers, and so the ones worth capturing */
const CAPTURED_MODULES = ['asset', 'externalAgents', 'identity', 'settlement'];

export interface RuntimeSnapshot {
  specName: string;
  specVersion: number;
  /** Lowercased pallet names, as `event.section.toLowerCase()` reports them */
  modules: string[];
  /** Pallet name (as the chain spells it) to event name to parameter count */
  events: Record<string, Record<string, number>>;
  /** Pallet name to snake_cased call names */
  calls: Record<string, string[]>;
}

export interface ArityFixture {
  specVersion: number;
  source: string;
  modules: Record<string, Record<string, number>>;
}

/** `camelToSnakeCase` from `src/utils/common`, repeated so this script pulls in no runtime code */
const snakeCase = (value: string): string =>
  value[0].toLowerCase() + value.slice(1).replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);

// ---------------------------------------------------------------------------------------------
// Reading metadata
// ---------------------------------------------------------------------------------------------

const variantsOf = (registry: TypeRegistry, lookupId: number) => {
  const type = registry.lookup.getSiType(lookupId as never);

  return type.def.isVariant ? type.def.asVariant.variants : [];
};

export const snapshotFromMetadata = (
  registry: TypeRegistry,
  metadata: Metadata,
  specName: string,
  specVersion: number
): RuntimeSnapshot => {
  const snapshot: RuntimeSnapshot = {
    specName,
    specVersion,
    modules: [],
    events: {},
    calls: {},
  };

  for (const pallet of metadata.asLatest.pallets) {
    const section = pallet.name.toString();

    snapshot.modules.push(section.toLowerCase());

    if (pallet.events.isSome) {
      snapshot.events[section] = Object.fromEntries(
        variantsOf(registry, pallet.events.unwrap().type.toNumber()).map(variant => [
          variant.name.toString(),
          variant.fields.length,
        ])
      );
    }

    if (pallet.calls.isSome) {
      snapshot.calls[section] = variantsOf(registry, pallet.calls.unwrap().type.toNumber()).map(
        variant => snakeCase(variant.name.toString())
      );
    }
  }

  snapshot.modules.sort();

  return snapshot;
};

/** Hex encoded metadata, from a `state_getMetadata` response or a bare hex string */
const metadataHexFrom = (raw: string): `0x${string}` => {
  const trimmed = raw.trim();
  const hex = trimmed.startsWith('0x')
    ? trimmed
    : JSON.parse(trimmed).result ?? JSON.parse(trimmed).metadata;

  if (typeof hex !== 'string' || !hex.startsWith('0x')) {
    throw new Error('Expected hex encoded metadata, or a JSON object with a hex `result`');
  }

  return hex as `0x${string}`;
};

const snapshotFromFile = (path: string, specVersion: number): RuntimeSnapshot => {
  const registry = new TypeRegistry();
  const metadata = new Metadata(registry, metadataHexFrom(readFileSync(path, 'utf-8')));

  registry.setMetadata(metadata);

  return snapshotFromMetadata(registry, metadata, 'unknown', specVersion);
};

const snapshotFromEndpoint = async (endpoint: string): Promise<RuntimeSnapshot> => {
  // Imported lazily so the pure helpers above stay importable without opening a connection
  const { ApiPromise, WsProvider } = await import('@polkadot/api');
  const api = await ApiPromise.create({ provider: new WsProvider(endpoint), noInitWarn: true });

  try {
    return snapshotFromMetadata(
      api.registry as unknown as TypeRegistry,
      api.runtimeMetadata,
      api.runtimeVersion.specName.toString(),
      api.runtimeVersion.specVersion.toNumber()
    );
  } finally {
    await api.disconnect();
  }
};

// ---------------------------------------------------------------------------------------------
// Schema enums
// ---------------------------------------------------------------------------------------------

export interface EnumBlock {
  name: string;
  /** Raw text between the braces, so comments, `@deprecated` and pallet headings survive */
  body: string;
  start: number;
  end: number;
}

/** Locates one `enum X { … }` block, brace matched so a nested `}` in a docstring cannot end it */
export const findEnumBlock = (schema: string, name: string): EnumBlock => {
  const header = `enum ${name} {`;
  const start = schema.indexOf(header);

  if (start < 0) {
    throw new Error(`schema.graphql has no ${name}`);
  }

  const bodyStart = start + header.length;
  const end = schema.indexOf('\n}', bodyStart);

  if (end < 0) {
    throw new Error(`${name} is not closed`);
  }

  return { name, body: schema.slice(bodyStart, end), start, end: end + 2 };
};

/** Member names declared in an enum body, ignoring comments, docstrings and directives */
export const enumMembers = (body: string): string[] =>
  body
    .split('\n')
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#') && !line.startsWith('"'))
    .map(line => line.split(/\s+/)[0]);

const ADDED_HEADING = '  ## added by scripts/sync-metadata.ts ##';

/**
 * Appends members the schema does not have yet, alphabetically, under a heading.
 *
 * Existing members are never reordered or removed. Their order is the Postgres enum's value
 * order, which decides how an enum column sorts, and a member the current runtime dropped is
 * still needed to index the history that emitted it.
 */
export const withAddedMembers = (body: string, additions: string[]): string => {
  if (additions.length === 0) {
    return body;
  }

  const [declared, ...previouslyAdded] = body.split(ADDED_HEADING);
  const carried = previouslyAdded
    .join('\n')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);

  const merged = [...new Set([...carried, ...additions])].sort((a, b) => a.localeCompare(b));

  return `${declared.replace(/\s*$/, '')}\n\n${ADDED_HEADING}\n${merged
    .map(member => `  ${member}`)
    .join('\n')}`;
};

export interface EnumUpdate {
  name: string;
  added: string[];
  /** Members the schema declares that this runtime does not emit. Reported, never removed */
  notInRuntime: string[];
}

export const planEnumUpdates = (
  schema: string,
  snapshot: RuntimeSnapshot
): Record<string, EnumUpdate> => {
  const runtimeValues: Record<string, string[]> = {
    ModuleIdEnum: snapshot.modules,
    EventIdEnum: [
      ...new Set(Object.values(snapshot.events).flatMap(events => Object.keys(events))),
    ],
    CallIdEnum: [...new Set(Object.values(snapshot.calls).flat())],
  };

  return Object.fromEntries(
    Object.entries(runtimeValues).map(([name, values]) => {
      const declared = new Set(enumMembers(findEnumBlock(schema, name).body));

      return [
        name,
        {
          name,
          added: values.filter(value => !declared.has(value)).sort((a, b) => a.localeCompare(b)),
          notInRuntime: [...declared]
            .filter(member => !values.includes(member))
            .sort((a, b) => a.localeCompare(b)),
        },
      ];
    })
  );
};

export const applyEnumUpdates = (schema: string, updates: Record<string, EnumUpdate>): string =>
  Object.values(updates).reduce((current, update) => {
    const block = findEnumBlock(current, update.name);

    return (
      current.slice(0, block.start) +
      `enum ${update.name} {${withAddedMembers(block.body, update.added)}\n}` +
      current.slice(block.end)
    );
  }, schema);

// ---------------------------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------------------------

export interface EventDrift {
  againstSpecVersion: number;
  added: string[];
  removed: string[];
  reshaped: string[];
}

/**
 * What changed between a captured spec version and this one, for the pallets that were captured.
 *
 * `reshaped` is the entry that matters most: an event that kept its name and changed its
 * parameter count is the failure mode positional decoding cannot see.
 */
export const eventDrift = (fixture: ArityFixture, snapshot: RuntimeSnapshot): EventDrift => {
  const added: string[] = [];
  const removed: string[] = [];
  const reshaped: string[] = [];

  for (const [moduleId, events] of Object.entries(fixture.modules)) {
    const current = snapshot.events[moduleId] ?? {};

    for (const [eventId, arity] of Object.entries(events)) {
      if (!(eventId in current)) {
        removed.push(`${moduleId}.${eventId}`);
      } else if (current[eventId] !== arity) {
        reshaped.push(`${moduleId}.${eventId}: ${arity} -> ${current[eventId]}`);
      }
    }

    for (const eventId of Object.keys(current)) {
      if (!(eventId in events)) {
        added.push(`${moduleId}.${eventId}`);
      }
    }
  }

  return {
    againstSpecVersion: fixture.specVersion,
    added: added.sort(),
    removed: removed.sort(),
    reshaped: reshaped.sort(),
  };
};

/** `moduleId.eventId` pairs a handler is bound to, read from the built project manifest */
export const handledEvents = (): Set<string> => {
  const handled = new Set<string>();

  for (const dataSource of project.dataSources) {
    for (const handler of dataSource.mapping.handlers) {
      const filter = (handler as { filter?: { module?: string; method?: string } }).filter;

      if (filter?.module && filter.method && handler.handler !== 'handleEvent') {
        handled.add(`${filter.module.toLowerCase()}.${filter.method}`);
      }
    }
  }

  return handled;
};

/** Pallets `project.ts` subscribes to at all */
export const subscribedModules = (): Set<string> => {
  const modules = new Set<string>();

  for (const dataSource of project.dataSources) {
    for (const handler of dataSource.mapping.handlers) {
      const filter = (handler as { filter?: { module?: string } }).filter;

      if (filter?.module) {
        modules.add(filter.module.toLowerCase());
      }
    }
  }

  return modules;
};

/**
 * Events the chain emits, in a pallet the indexer subscribes to, that no handler reads.
 *
 * Roughly 150 of these sit in `project.ts` as `[]` today with nothing surfacing them. Being on
 * this list is not a defect by itself - most are deliberately out of scope - but the list should
 * be a decision, not an accident.
 */
export const unhandledEvents = (snapshot: RuntimeSnapshot): string[] => {
  const handled = handledEvents();
  const subscribed = subscribedModules();

  return Object.entries(snapshot.events)
    .filter(([section]) => subscribed.has(section.toLowerCase()))
    .flatMap(([section, events]) =>
      Object.keys(events)
        .map(eventId => `${section.toLowerCase()}.${eventId}`)
        .filter(key => !handled.has(key))
    )
    .sort();
};

const readFixtures = (): ArityFixture[] =>
  readdirSync(ARITY_DIR)
    .filter(name => name.endsWith('.json'))
    .map(name => JSON.parse(readFileSync(join(ARITY_DIR, name), 'utf-8')) as ArityFixture)
    .sort((a, b) => a.specVersion - b.specVersion);

export const arityFixtureFor = (snapshot: RuntimeSnapshot): ArityFixture => ({
  specVersion: snapshot.specVersion,
  source: `runtime metadata, ${snapshot.specName} ${snapshot.specVersion}`,
  modules: Object.fromEntries(
    CAPTURED_MODULES.filter(moduleId => snapshot.events[moduleId]).map(moduleId => [
      moduleId,
      Object.fromEntries(
        Object.entries(snapshot.events[moduleId]).sort(([a], [b]) => a.localeCompare(b))
      ),
    ])
  ),
});

// ---------------------------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------------------------

const argOf = (argv: string[], name: string): string | undefined => {
  const index = argv.indexOf(`--${name}`);

  return index >= 0 ? argv[index + 1] : undefined;
};

const printList = (title: string, items: string[]): void => {
  console.log(`\n${title} (${items.length})`);
  items.forEach(item => console.log(`  ${item}`));
};

export const main = async (argv: string[] = process.argv.slice(2)): Promise<number> => {
  const endpoint = argOf(argv, 'endpoint') ?? process.env.NETWORK_ENDPOINT;
  const metadataFile = argOf(argv, 'metadata');
  const write = argv.includes('--write');
  const check = argv.includes('--check');

  if (!endpoint && !metadataFile) {
    console.error('Pass --endpoint <ws url> or --metadata <file>, or set NETWORK_ENDPOINT');

    return 1;
  }

  const snapshot = metadataFile
    ? snapshotFromFile(metadataFile, Number(argOf(argv, 'spec-version') ?? 0))
    : await snapshotFromEndpoint(endpoint as string);

  console.log(`Runtime ${snapshot.specName} spec ${snapshot.specVersion}`);

  for (const fixture of readFixtures()) {
    const drift = eventDrift(fixture, snapshot);

    console.log(`\n=== drift against spec ${drift.againstSpecVersion} ===`);
    printList('added', drift.added);
    printList('removed', drift.removed);
    printList('reshaped', drift.reshaped);
  }

  const schema = readFileSync(SCHEMA_PATH, 'utf-8');
  const updates = planEnumUpdates(schema, snapshot);

  console.log('\n=== schema enums ===');
  for (const update of Object.values(updates)) {
    printList(`${update.name}: missing from the schema`, update.added);
    printList(`${update.name}: declared but not in this runtime`, update.notInRuntime);
  }

  printList('\n=== in enum, subscribed, not handled ===', unhandledEvents(snapshot));

  const behind = Object.values(updates).some(update => update.added.length > 0);

  if (write) {
    writeFileSync(SCHEMA_PATH, applyEnumUpdates(schema, updates));
    writeFileSync(
      join(ARITY_DIR, `${snapshot.specVersion}.json`),
      `${JSON.stringify(arityFixtureFor(snapshot), null, 2)}\n`
    );
    console.log('\nUpdated schema.graphql and the event arity fixture');

    return 0;
  }

  if (check && behind) {
    console.error('\nschema.graphql is missing enum members this runtime emits');

    return 1;
  }

  return 0;
};

if (require.main === module) {
  main()
    .then(code => process.exit(code))
    .catch(error => {
      console.error(error);
      process.exit(1);
    });
}
