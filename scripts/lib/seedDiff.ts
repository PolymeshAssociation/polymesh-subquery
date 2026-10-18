/**
 * The difference between a seed and the index it should equal, entity by entity: the rows only one
 * side holds and the fields they disagree on. Provenance (`*EventId`) and a seeder's `relative`
 * fields are not compared, and an indexed row the seed lacks is allowed when its seeder calls it
 * `terminal` or it belongs to an allowed `parent` row: finished, and pruned from the chain.
 */
import { Seeder } from '../../src/seed/seeder';

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

const ISO_DATE = /^\d{4}-\d\d-\d\dT\d\d:\d\d/;

/** A value as GraphQL renders it: big numbers as strings, times in UTC, keys sorted */
const canonical = (value: unknown): unknown => {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === 'string' && ISO_DATE.test(value)) {
    const zoned = /(Z|[+-]\d\d:?\d\d)$/.test(value) ? value : `${value}Z`;
    const time = new Date(zoned);
    return Number.isNaN(time.getTime()) ? value : time.toISOString();
  }
  if (Array.isArray(value)) {
    return value.map(canonical);
  }
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Row)
        .sort()
        .map(key => [key, canonical((value as Row)[key])])
    );
  }
  return value;
};

/** Whether a seeded value and an indexed one, as GraphQL returned it, are the same */
export const sameValue = (seeded: unknown, indexed: unknown): boolean => {
  const [a, b] = [canonical(seeded), canonical(indexed)];
  if (typeof a === 'number' || typeof b === 'number') {
    return a !== null && b !== null && String(a) === String(b);
  }
  return JSON.stringify(a) === JSON.stringify(b);
};

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

export const diffSeed = (
  seeded: Record<string, Row[]>,
  indexed: Record<string, Row[]>,
  seeders: Seeder[]
): EntityDiff[] => {
  const allowedIds = new Map<string, Set<string>>();

  return parentsFirst(seeders).map(seeder => {
    const { entity, relative = [], terminal, parent } = seeder;
    const ours = new Map((seeded[entity] ?? []).map(row => [row.id as string, row]));
    const theirs = new Map((indexed[entity] ?? []).map(row => [row.id as string, row]));
    const allowed = new Set<string>();
    const extra: string[] = [];
    const differing: FieldDiff[] = [];

    for (const [id, row] of theirs) {
      const ourRow = ours.get(id);
      if (!ourRow) {
        const pruned =
          terminal?.(row as never) ||
          (parent && allowedIds.get(parent.entity)?.has(row[parent.field] as string));
        if (pruned) {
          allowed.add(id);
        } else {
          extra.push(id);
        }
        continue;
      }
      const fields = new Set([...Object.keys(ourRow), ...Object.keys(row)]);
      for (const field of fields) {
        if (NOT_COMPARED.has(field) || field.endsWith('EventId') || relative.includes(field)) {
          continue;
        }
        if (!sameValue(ourRow[field], row[field])) {
          differing.push({ id, field, seeded: ourRow[field], indexed: row[field] });
        }
      }
    }
    allowedIds.set(entity, allowed);

    return {
      entity,
      seeded: ours.size,
      indexed: theirs.size,
      missing: [...ours.keys()].filter(id => !theirs.has(id)),
      extra,
      allowed: allowed.size,
      differing,
    };
  });
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
