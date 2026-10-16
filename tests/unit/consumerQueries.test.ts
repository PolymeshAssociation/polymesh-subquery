import {
  ArgumentNode,
  DocumentNode,
  FieldNode,
  GraphQLEnumType,
  GraphQLNamedType,
  GraphQLObjectType,
  GraphQLSchema,
  Kind,
  ObjectFieldNode,
  ValueNode,
  buildASTSchema,
  getNamedType,
  isListType,
  isNonNullType,
  parse,
} from 'graphql';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The SDK and portal queries, as migrated to the redesigned schema. Only the GraphQL texts are
// kept. Each one is checked against schema.graphql offline: its entities, fields, filter keys,
// enum values and orderings must exist, and an `args` filter must come with the filters that
// keep it off a full table scan.

interface FixtureQuery {
  name: string;
  query: string;
}

const queries: FixtureQuery[] = JSON.parse(
  readFileSync(join(__dirname, '..', 'fixtures', 'consumerQueries.json'), 'utf8')
);

// SubQuery's own directives and scalars are not part of GraphQL, so the schema is built without
// validating them and with the scalars it uses declared here.
const schema: GraphQLSchema = buildASTSchema(
  parse(
    `scalar Date\nscalar BigInt\nscalar JSON\n${readFileSync(
      join(__dirname, '..', '..', 'schema.graphql'),
      'utf8'
    )}`
  ),
  { assumeValidSDL: true }
);

const entities = new Map<string, GraphQLObjectType>();
for (const type of Object.values(schema.getTypeMap())) {
  if (
    type instanceof GraphQLObjectType &&
    type.astNode?.directives?.some(d => d.name.value === 'entity')
  ) {
    entities.set(type.name, type);
  }
}

// PostGraphile names a collection after its entity: events, claims, polyxEntries
const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
const plural = (s: string) =>
  /y$/.test(s) ? `${s.slice(0, -1)}ies` : /(s|x)$/.test(s) ? `${s}es` : `${s}s`;
const collections = new Map<string, GraphQLObjectType>();
for (const entity of entities.values()) {
  collections.set(plural(lowerFirst(entity.name)), entity);
}

const upperSnake = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();

const LOGICAL = new Set(['and', 'or', 'not']);
const AGGREGATES = new Set(['groupedAggregates', 'aggregates', 'pageInfo', 'totalCount']);

const objectFields = (node: ValueNode): readonly ObjectFieldNode[] =>
  node.kind === Kind.OBJECT ? node.fields : [];

const keyOf = (node: ObjectFieldNode) => node.name.value;

const resolveEntity = (type: GraphQLNamedType): GraphQLObjectType | undefined =>
  entities.get(type.name);

interface Member {
  named: GraphQLNamedType;
  collection: boolean;
}

// What the generated API exposes on an entity beyond its declared fields: the id column behind each
// relation (`claim.issuerId`), the node id, and the collection each relation implies on the entity
// it points at. That collection is the child's plural when the column is named after the parent
// (`leg.offChainReceipts` for `OffChainReceipt.leg`), and is qualified by the column otherwise
// (`identity.claimsByTargetId` for `Claim.target`). A `@derivedFrom` field replaces it.
const memberCache = new Map<string, Map<string, Member>>();
const members = (entity: GraphQLObjectType): Map<string, Member> => {
  const cached = memberCache.get(entity.name);
  if (cached) return cached;
  const result = new Map<string, Member>();
  for (const [name, field] of Object.entries(entity.getFields())) {
    const wrapped = isNonNullType(field.type) ? field.type.ofType : field.type;
    const named = getNamedType(field.type);
    result.set(name, { named, collection: isListType(wrapped) });
    if (!isListType(wrapped) && resolveEntity(named)) {
      result.set(`${name}Id`, {
        named: schema.getType('String') as GraphQLNamedType,
        collection: false,
      });
    }
  }
  result.set('nodeId', { named: schema.getType('ID') as GraphQLNamedType, collection: false });
  const declared = new Set(
    Object.values(entity.getFields()).flatMap(field => {
      const derived = field.astNode?.directives?.find(d => d.name.value === 'derivedFrom');
      const column = derived?.arguments?.[0]?.value;
      return column?.kind === Kind.STRING
        ? [`${getNamedType(field.type).name}.${column.value}`]
        : [];
    })
  );
  for (const other of entities.values()) {
    for (const [name, field] of Object.entries(other.getFields())) {
      const wrapped = isNonNullType(field.type) ? field.type.ofType : field.type;
      if (
        !isListType(wrapped) &&
        getNamedType(field.type).name === entity.name &&
        !declared.has(`${other.name}.${name}`)
      ) {
        const collection = plural(lowerFirst(other.name));
        result.set(
          name === lowerFirst(entity.name)
            ? collection
            : `${collection}By${name.charAt(0).toUpperCase()}${name.slice(1)}Id`,
          { named: other, collection: true }
        );
      }
    }
  }
  memberCache.set(entity.name, result);
  return result;
};

interface FilterRoot {
  entity: string;
  fields: readonly ObjectFieldNode[];
}

const branchesOf = (field: ObjectFieldNode): readonly ValueNode[] =>
  field.value.kind === Kind.LIST ? field.value.values : [field.value];

/**
 * validates one `filter:` object against the entity it filters. Every object that filters an entity
 * in its own right (the argument itself, and each relation filter nested in it) is recorded in
 * `roots`; the branches of and/or/not stay part of the root that holds them.
 */
const validateFilter = (
  node: ValueNode,
  entity: GraphQLObjectType,
  problems: string[],
  path: string,
  roots: FilterRoot[],
  isRoot = true
): void => {
  const fields = objectFields(node);
  if (isRoot) roots.push({ entity: entity.name, fields });
  for (const field of fields) {
    const key = keyOf(field);
    if (LOGICAL.has(key)) {
      for (const branch of branchesOf(field)) {
        validateFilter(branch, entity, problems, `${path}.${key}`, roots, false);
      }
      continue;
    }
    // `fooExist` filters on whether a relation has any row
    const column = members(entity).get(key) ?? members(entity).get(key.replace(/Exists?$/, ''));
    if (!column) {
      problems.push(`${path}: no field '${key}' on ${entity.name}`);
      continue;
    }
    const { named } = column;
    if (named instanceof GraphQLEnumType) {
      const literals = objectFields(field.value).flatMap(op =>
        op.value.kind === Kind.ENUM
          ? [op.value.value]
          : op.value.kind === Kind.LIST
          ? op.value.values.flatMap(v => (v.kind === Kind.ENUM ? [v.value] : []))
          : []
      );
      for (const literal of literals) {
        if (!named.getValue(literal)) {
          problems.push(`${path}.${key}: '${literal}' is not a ${named.name}`);
        }
      }
    }
    const related = resolveEntity(named);
    if (related && !key.endsWith('Id')) {
      // a relation filter nests the related entity's own filter; a collection nests it under some/every/none
      for (const inner of objectFields(field.value)) {
        if (['some', 'every', 'none'].includes(keyOf(inner))) {
          validateFilter(inner.value, related, problems, `${path}.${key}.${keyOf(inner)}`, roots);
        }
      }
      if (!column.collection) {
        validateFilter(field.value, related, problems, `${path}.${key}`, roots);
      }
    }
  }
};

const argument = (field: FieldNode, name: string): ArgumentNode | undefined =>
  field.arguments?.find(a => a.name.value === name);

/** walks a selection set against the schema, collecting problems and the root of every filter */
const check = (document: DocumentNode): { problems: string[]; filtered: FilterRoot[] } => {
  const problems: string[] = [];
  const filtered: FilterRoot[] = [];

  const visitConnection = (field: FieldNode, entity: GraphQLObjectType, path: string) => {
    const filter = argument(field, 'filter');
    if (filter) {
      validateFilter(filter.value, entity, problems, `${path}(filter)`, filtered);
    }
    const orderBy = argument(field, 'orderBy');
    if (orderBy) {
      const values = orderBy.value.kind === Kind.LIST ? orderBy.value.values : [orderBy.value];
      const known = new Set<string>(['NATURAL', 'PRIMARY_KEY_ASC', 'PRIMARY_KEY_DESC']);
      for (const name of Object.keys(entity.getFields())) {
        known.add(`${upperSnake(name)}_ASC`);
        known.add(`${upperSnake(name)}_DESC`);
        known.add(`${upperSnake(name)}_ID_ASC`);
        known.add(`${upperSnake(name)}_ID_DESC`);
      }
      for (const value of values) {
        if (value.kind === Kind.ENUM && !known.has(value.value)) {
          problems.push(`${path}(orderBy): '${value.value}' is not an ordering of ${entity.name}`);
        }
      }
    }
    for (const selection of field.selectionSet?.selections ?? []) {
      if (selection.kind !== Kind.FIELD) continue;
      const name = selection.name.value;
      if (AGGREGATES.has(name)) continue;
      if (name === 'nodes') visitNode(selection, entity, `${path}.nodes`);
      else problems.push(`${path}: '${name}' is not part of a connection`);
    }
  };

  const visitNode = (field: FieldNode, entity: GraphQLObjectType, path: string) => {
    for (const selection of field.selectionSet?.selections ?? []) {
      if (selection.kind !== Kind.FIELD) continue;
      const name = selection.name.value;
      const column = members(entity).get(name);
      if (!column) {
        problems.push(`${path}: no field '${name}' on ${entity.name}`);
        continue;
      }
      const { named } = column;
      const related = resolveEntity(named);
      if (related) {
        if (column.collection) visitConnection(selection, related, `${path}.${name}`);
        else visitNode(selection, related, `${path}.${name}`);
      } else if (selection.selectionSet && named instanceof GraphQLObjectType) {
        visitNode(selection, named, `${path}.${name}`);
      }
    }
  };

  for (const definition of document.definitions) {
    if (definition.kind !== Kind.OPERATION_DEFINITION) continue;
    for (const selection of definition.selectionSet.selections) {
      if (selection.kind !== Kind.FIELD) continue;
      const name = selection.name.value;
      const entity = collections.get(name);
      if (entity) visitConnection(selection, entity, name);
      else if (name !== 'query' && !name.startsWith('_') && !entities.has(name)) {
        // entity lookups by id, and the schema's own utility roots, are not part of the migrated set
        problems.push(`no collection '${name}' in schema.graphql`);
      }
    }
  }
  return { problems, filtered };
};

// The operators that pin a column to given values; `notEqualTo` and the like leave the table wide open.
const PINNING = new Set(['equalTo', 'in']);
const REQUIRED: Record<string, string[]> = {
  Event: ['moduleId', 'eventId'],
  Extrinsic: ['moduleId', 'callId'],
};

const pins = (field: ObjectFieldNode): boolean =>
  objectFields(field.value).some(op => PINNING.has(keyOf(op)));

/**
 * What one filter object narrows to, counting its own keys and its `and` branches. An `or` branch
 * is another way to match, so it narrows nothing for the object; `not` narrows nothing either.
 */
const narrowing = (
  fields: readonly ObjectFieldNode[],
  keys: Set<string>,
  ors: ValueNode[]
): boolean => {
  let args = false;
  for (const field of fields) {
    const key = keyOf(field);
    if (key === 'args') args = true;
    else if (key === 'and') {
      for (const branch of branchesOf(field)) {
        args = narrowing(objectFields(branch), keys, ors) || args;
      }
    } else if (key === 'or') ors.push(...branchesOf(field));
    else if (key === 'not') continue;
    else if (pins(field)) keys.add(key);
  }
  return args;
};

/** the problems of one filter object, given the keys its enclosing objects already pin */
const argsProblems = (
  entity: string,
  fields: readonly ObjectFieldNode[],
  inherited: ReadonlySet<string>
): string[] => {
  const problems: string[] = [];
  const keys = new Set(inherited);
  const ors: ValueNode[] = [];
  if (narrowing(fields, keys, ors)) {
    for (const key of REQUIRED[entity]) {
      if (!keys.has(key)) problems.push(`${entity} filters on args without ${key}`);
    }
  }
  // each `or` branch matches on its own, on top of whatever the enclosing object pins
  for (const branch of ors) {
    problems.push(...argsProblems(entity, objectFields(branch), keys));
  }
  return problems;
};

/** a filter on `args` must be pinned to one event or call by the filter that holds it */
const argsFilterProblems = (filtered: FilterRoot[]): string[] =>
  filtered.flatMap(({ entity, fields }) =>
    REQUIRED[entity] ? argsProblems(entity, fields, new Set()) : []
  );

const usesArgs = (fields: readonly ObjectFieldNode[]): boolean =>
  fields.some(
    f =>
      keyOf(f) === 'args' ||
      (LOGICAL.has(keyOf(f)) && branchesOf(f).some(b => usesArgs(objectFields(b))))
  );

describe('the migrated consumer queries', () => {
  it('holds the queries it claims to', () => {
    expect(queries.length).toBeGreaterThanOrEqual(55);
    expect(new Set(queries.map(q => q.name)).size).toBe(queries.length);
  });

  describe.each(queries.map(q => [q.name, q.query]))('%s', (_name, query) => {
    const result = check(parse(query));

    it('uses only entities, fields, filter keys and orderings that schema.graphql defines', () => {
      expect(result.problems).toEqual([]);
    });

    it('pairs an args filter with moduleId and eventId (events) or callId (extrinsics)', () => {
      expect(argsFilterProblems(result.filtered)).toEqual([]);
    });
  });

  it('covers an args filter on events and on extrinsics', () => {
    const entities = queries.flatMap(q =>
      check(parse(q.query)).filtered.filter(f => usesArgs(f.fields))
    );
    expect(new Set(entities.map(f => f.entity))).toEqual(new Set(['Event', 'Extrinsic']));
  });

  describe('the checks themselves', () => {
    const run = (text: string) => check(parse(text));

    it('rejects an events args filter without eventId', () => {
      const { filtered } = run(
        '{ events(filter: {moduleId: {equalTo: asset}, args: {contains: {a: "1"}}}) { nodes { id } } }'
      );
      expect(argsFilterProblems(filtered)).toEqual(['Event filters on args without eventId']);
    });

    it('rejects an extrinsics args filter without a call', () => {
      const { filtered } = run(
        '{ extrinsics(filter: {args: {contains: {a: "1"}}}) { nodes { id } } }'
      );
      expect(argsFilterProblems(filtered)).toEqual([
        'Extrinsic filters on args without moduleId',
        'Extrinsic filters on args without callId',
      ]);
    });

    it.each([
      [
        'accepts the pair inside an and branch',
        '{ events(filter: {and: [{moduleId: {equalTo: asset}, eventId: {equalTo: Transfer}}, {args: {contains: {a: "1"}}}]}) { nodes { id } } }',
      ],
      [
        'accepts in as well as equalTo',
        '{ events(filter: {moduleId: {in: [asset]}, eventId: {in: [Transfer]}, args: {contains: {a: "1"}}}) { nodes { id } } }',
      ],
      [
        'accepts an or of args filters under a pinned event',
        '{ events(filter: {moduleId: {equalTo: asset}, eventId: {equalTo: Transfer}, or: [{args: {contains: {a: "1"}}}, {args: {contains: {a: "2"}}}]}) { nodes { id } } }',
      ],
      [
        'accepts a nested event filter that pins its own pair',
        '{ polyxEntries(filter: {createdEvent: {moduleId: {equalTo: asset}, eventId: {equalTo: Transfer}, args: {contains: {a: "1"}}}}) { nodes { id } } }',
      ],
    ])('%s', (_title, text) => {
      expect(argsFilterProblems(run(text).filtered)).toEqual([]);
    });

    it.each([
      [
        'rejects a pair that only an or branch supplies',
        '{ events(filter: {args: {contains: {a: "1"}}, or: [{moduleId: {equalTo: asset}, eventId: {equalTo: Transfer}}]}) { nodes { id } } }',
      ],
      [
        'rejects an or branch that filters args without pinning the event itself',
        '{ events(filter: {or: [{moduleId: {equalTo: asset}, eventId: {equalTo: Transfer}, args: {contains: {a: "1"}}}, {args: {contains: {a: "2"}}}]}) { nodes { id } } }',
      ],
      [
        'rejects a pair that a not branch or notEqualTo only excludes',
        '{ events(filter: {moduleId: {notEqualTo: asset}, not: {eventId: {equalTo: Transfer}}, args: {contains: {a: "1"}}}) { nodes { id } } }',
      ],
    ])('%s', (_title, text) => {
      expect(argsFilterProblems(run(text).filtered)).toEqual([
        'Event filters on args without moduleId',
        'Event filters on args without eventId',
      ]);
    });

    it('rejects a pair that the parent entity supplies to a nested event filter', () => {
      const { filtered } = run(
        '{ polyxEntries(filter: {createdEvent: {args: {contains: {a: "1"}}}, moduleId: {equalTo: asset}, eventId: {equalTo: Transfer}}) { nodes { id } } }'
      );
      expect(filtered.map(f => f.entity)).toEqual(['PolyxEntry', 'Event']);
      expect(argsFilterProblems(filtered)).toEqual([
        'Event filters on args without moduleId',
        'Event filters on args without eventId',
      ]);
    });

    it('rejects a reverse relation named after the field rather than the column', () => {
      const { problems } = run('{ instructions { nodes { legByInstruction { nodes { id } } } } }');
      expect(problems).toEqual(["instructions.nodes: no field 'legByInstruction' on Instruction"]);
    });

    it('names a generated backward relation after a column not named after its parent', () => {
      const { problems } = run('{ assets { nodes { stosByRaisingAssetId { nodes { id } } } } }');
      expect(problems).toEqual([]);
    });

    it('names it plainly when the column is named after its parent', () => {
      expect(run('{ legs { nodes { offChainReceipts { nodes { id } } } } }').problems).toEqual([]);
      expect(
        run('{ legs { nodes { offChainReceiptsByLegId { nodes { id } } } } }').problems
      ).toEqual(["legs.nodes: no field 'offChainReceiptsByLegId' on Leg"]);
    });

    it('drops the generated name of a backward relation declared with @derivedFrom', () => {
      const { problems } = run(
        '{ accounts { nodes { assetTransactionsByFromAccountId { nodes { id } } } } }'
      );
      expect(problems).toEqual([
        "accounts.nodes: no field 'assetTransactionsByFromAccountId' on Account",
      ]);
    });

    it('reports a field, a filter key, an enum value and an ordering the schema lacks', () => {
      const { problems } = run(
        '{ events(filter: {eventArg0: {equalTo: "x"}, moduleId: {equalTo: nonsense}}, orderBy: [NOPE_ASC]) { nodes { paramsTxt } } }'
      );
      expect(problems).toEqual([
        "events(filter): no field 'eventArg0' on Event",
        "events(filter).moduleId: 'nonsense' is not a ModuleIdEnum",
        "events(orderBy): 'NOPE_ASC' is not an ordering of Event",
        "events.nodes: no field 'paramsTxt' on Event",
      ]);
    });
  });
});
