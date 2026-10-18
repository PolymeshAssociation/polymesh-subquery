/**
 * Checks the seed against an index that ran from genesis: seeds at `height` from the chain, reads
 * every seeded entity from the index's GraphQL as of `height - 1`, and reports what differs. An
 * index that equals its own seed at any height is one the seed could have started.
 *
 *   yarn verify-seed --endpoint wss://… --gql http://… --height 26326409 [--entities A,B] [--out diff.json]
 *
 * Needs the index's historical queries (`blockHeight`). Exits non-zero on any difference.
 */
import { writeFileSync } from 'node:fs';
import { connectionNames, ConnectionSchema, diffSeed, EntityDiff } from './lib/seedDiff';
import { connect, seedLive } from './lib/liveSeed';

type Row = Record<string, unknown>;

const arg = (name: string): string | undefined => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
};

const PAGE = 1000;

const gql = async <T>(url: string, query: string): Promise<T> => {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  const { data, errors } = (await response.json()) as { data: T; errors?: unknown[] };
  if (errors?.length) {
    throw new Error(`GraphQL: ${JSON.stringify(errors).slice(0, 500)}`);
  }
  return data;
};

const TYPE_REF = 'kind name ofType { kind name ofType { kind name ofType { kind name } } }';

interface Introspected extends ConnectionSchema {
  types: { name: string; fields?: { name: string; type: { kind?: string } & object }[] | null }[];
}

/** A field's innermost type kind */
const kindOf = (type: { kind?: string; ofType?: unknown } | null | undefined): string | undefined =>
  type?.ofType ? kindOf(type.ofType as never) : type?.kind;

/** The columns of an entity's node type: its scalar and enum fields, relations as their ids */
const columns = (schema: Introspected, entity: string): string[] =>
  (schema.types.find(({ name }) => name === entity)?.fields ?? [])
    .filter(({ name, type }) => {
      const kind = kindOf(type as never);
      return (kind === 'SCALAR' || kind === 'ENUM') && name !== 'nodeId';
    })
    .map(({ name }) => name);

/** Every row of `connection` as of `atHeight` */
const indexedRows = async (
  url: string,
  connection: string,
  fields: string[],
  atHeight: number
): Promise<Row[]> => {
  const rows: Row[] = [];
  let after: string | null = null;
  for (;;) {
    const page: Record<
      string,
      { nodes: Row[]; pageInfo: { hasNextPage: boolean; endCursor: string } }
    > = await gql(
      url,
      `{ ${connection}(first: ${PAGE}, orderBy: ID_ASC, blockHeight: "${atHeight}"${
        after ? `, after: "${after}"` : ''
      }) { nodes { ${fields.join(' ')} } pageInfo { hasNextPage endCursor } } }`
    );
    const { nodes, pageInfo } = page[connection];
    rows.push(...nodes);
    if (!pageInfo.hasNextPage) {
      return rows;
    }
    after = pageInfo.endCursor;
  }
};

const summary = ({ entity, seeded, indexed, missing, extra, allowed, differing }: EntityDiff) => {
  const fields = [...new Set(differing.map(({ field }) => field))];
  return `${entity.padEnd(32)} seeded ${String(seeded).padStart(7)}  indexed ${String(
    indexed
  ).padStart(7)}  missing ${missing.length}  extra ${
    extra.length
  } (+${allowed} pruned)  differing ${differing.length}${
    fields.length ? ` [${fields.join(', ')}]` : ''
  }`;
};

const main = async () => {
  const endpoint = arg('endpoint');
  const url = arg('gql');
  const height = Number(arg('height'));
  if (!endpoint || !url || !height) {
    throw new Error(
      'usage: verify-seed --endpoint <ws> --gql <url> --height <n> [--entities A,B] [--out file]'
    );
  }
  const entities = arg('entities')?.split(',');

  const api = await connect(endpoint);
  const live = await seedLive(api, height, entities);
  await api.disconnect();
  console.log(`seeded at ${height} (spec ${live.specVersion}) in ${live.ms} ms`);

  const { __schema: schema } = await gql<{ __schema: Introspected }>(
    url,
    `{ __schema { queryType { fields { name type { ${TYPE_REF} } } } types { name fields { name type { ${TYPE_REF} } } } } }`
  );
  const connections = connectionNames(schema);

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { SEEDERS } = require('../src/seed/seeders');
  const seeders = (SEEDERS as { entity: string }[]).filter(
    ({ entity }) => !entities || entities.includes(entity)
  );
  const indexed: Record<string, Row[]> = {};
  for (const { entity } of seeders) {
    const connection = connections[entity];
    if (!connection) {
      throw new Error(`the index has no connection for ${entity}`);
    }
    indexed[entity] = await indexedRows(url, connection, columns(schema, entity), height - 1);
  }

  const diffs = diffSeed(live.rows, indexed, seeders as never);
  diffs.forEach(diff => console.log(summary(diff)));
  const out = arg('out');
  if (out) {
    writeFileSync(
      out,
      JSON.stringify(
        diffs,
        (_key, value) => (typeof value === 'bigint' ? value.toString() : value),
        1
      )
    );
  }
  const clean = diffs.every(
    ({ missing, extra, differing }) => !missing.length && !extra.length && !differing.length
  );
  console.log(clean ? 'seed equals the index' : 'seed differs from the index');
  process.exit(clean ? 0 : 1);
};

main().catch(error => {
  console.error(error);
  process.exit(2);
});
