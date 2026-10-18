/**
 * The difference between a seed and the index it should equal, entity by entity: the rows only one
 * side holds and the fields they disagree on, matched by id or a seeder's natural `key`. Provenance
 * (`*EventId`, `*BlockId`) and a seeder's `relative` fields are not compared, and an indexed row the
 * seed lacks is allowed when its seeder calls it `terminal` or it belongs to an allowed `parent`
 * row: finished, and pruned from the chain.
 */
import { sameValue } from '../../src/seed/sameValue';
import { Seeder } from '../../src/seed/seeder';

export { sameValue };

type Row = Record<string, unknown>;

export interface FieldDiff {
  id: string;
  field: string;
  seeded: unknown;
  indexed: unknown;
}

export interface EntityDiff {
  entity: string;
  seeded: number;
  indexed: number;
  /** seeded rows the index lacks */
  missing: string[];
  /** indexed rows the seed lacks and that are not allowed */
  extra: string[];
  /** indexed rows the seed lacks because the chain pruned them */
  allowed: number;
  differing: FieldDiff[];
}

/** GraphQL's fields that no seeder writes */
const NOT_COMPARED = new Set(['id', 'nodeId', '__typename', '_id', '_blockRange']);

/** Seeders in an order where each `parent` comes before the seeders naming it */
const parentsFirst = (seeders: Seeder[]): Seeder[] => {
  const ordered: Seeder[] = [];
  const visit = (seeder: Seeder) => {
    if (ordered.includes(seeder)) {
      return;
    }
    const parent = seeders.find(({ entity }) => entity === seeder.parent?.entity);
    if (parent) {
      visit(parent);
    }
    ordered.push(seeder);
  };
  seeders.forEach(visit);
  return ordered;
};

/** Whether `field` of an index's row is compared: not provenance, nor counted from the start */
const isCompared = (field: string, relative: string[]): boolean =>
  !NOT_COMPARED.has(field) &&
  !field.endsWith('EventId') &&
  !field.endsWith('BlockId') &&
  !relative.includes(field);

/** The compared fields a seeded row and the index's disagree on */
const fieldDiffs = (id: string, ours: Row, theirs: Row, relative: string[]): FieldDiff[] =>
  Object.keys(theirs)
    .filter(field => isCompared(field, relative) && !sameValue(ours[field], theirs[field]))
    .map(field => ({ id, field, seeded: ours[field], indexed: theirs[field] }));

/** One entity's diff; `allowedIds` holds each parent entity's rows the chain pruned */
const diffEntity = (
  seeder: Seeder,
  seededRows: Row[],
  indexedRows: Row[],
  allowedIds: Map<string, Set<string>>
): EntityDiff => {
  const { entity, relative = [], terminal, parent, key } = seeder;
  const keyOf = (row: Row): string => (key ? key(row as never) : (row.id as string));
  const ours = new Map(seededRows.map(row => [keyOf(row), row]));
  const matched = new Set<string>();
  const allowed = new Set<string>();
  const extra: string[] = [];
  const differing: FieldDiff[] = [];
  // a finished row the chain prunes, or one whose parent it pruned
  const isPruned = (row: Row, isTerminal: boolean): boolean =>
    isTerminal ||
    Boolean(parent && allowedIds.get(parent.entity)?.has(row[parent.field] as string));

  for (const row of indexedRows) {
    const id = row.id as string;
    const isTerminal = Boolean(terminal?.(row as never));
    // a finished interval shares its natural key with the one open now
    const ourRow = key && isTerminal ? undefined : ours.get(keyOf(row));
    if (ourRow) {
      matched.add(keyOf(row));
      // the index's columns: a field its schema lacks isn't compared
      differing.push(...fieldDiffs(id, ourRow, row, relative));
    } else if (isPruned(row, isTerminal)) {
      allowed.add(id);
    } else {
      extra.push(id);
    }
  }
  allowedIds.set(entity, allowed);

  return {
    entity,
    seeded: ours.size,
    indexed: indexedRows.length,
    missing: [...ours.entries()]
      .filter(([k]) => !matched.has(k))
      .map(([, row]) => row.id as string),
    extra,
    allowed: allowed.size,
    differing,
  };
};

export const diffSeed = (
  seeded: Record<string, Row[]>,
  indexed: Record<string, Row[]>,
  seeders: Seeder[]
): EntityDiff[] => {
  const allowedIds = new Map<string, Set<string>>();
  return parentsFirst(seeders).map(seeder =>
    diffEntity(seeder, seeded[seeder.entity] ?? [], indexed[seeder.entity] ?? [], allowedIds)
  );
};

interface TypeRef {
  kind?: string;
  name?: string | null;
  ofType?: TypeRef | null;
}

/** The part of a GraphQL introspection `__schema` that names the query's connections */
export interface ConnectionSchema {
  queryType: { fields: { name: string; type: TypeRef }[] };
  types: { name: string; fields?: { name: string; type: TypeRef }[] | null }[];
}

const named = (type: TypeRef | null | undefined): string | undefined =>
  type ? type.name ?? named(type.ofType) : undefined;

/** The query field listing each entity's rows, by the type of its connection's `nodes` */
export const connectionNames = (schema: ConnectionSchema): Record<string, string> => {
  const types = new Map(schema.types.map(type => [type.name, type]));
  return Object.fromEntries(
    schema.queryType.fields.flatMap(({ name, type }) => {
      const connection = types.get(named(type) ?? '');
      const nodes = connection?.name.endsWith('Connection')
        ? connection.fields?.find(field => field.name === 'nodes')
        : undefined;
      const entity = named(nodes?.type);
      return entity ? [[entity, name]] : [];
    })
  );
};
