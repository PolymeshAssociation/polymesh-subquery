/**
 * Every store query in `src/` filters only on indexed fields.
 *
 * SubQuery's store rejects `getByField` / `getByFields` on a field no index covers, at runtime and
 * on the first block that reaches the query. The unit tests' store mocks accept any field, so
 * nothing else catches it before a sync does. This reads each call's entity and field names from
 * the source and checks them against the indexes SubQuery derives from `schema.graphql`, with the
 * node's own rule: a field counts if any index on the model lists it.
 *
 * The same queries also guard the GiST trim in `db/trimIndexes.ts`: that list drops indexes by table
 * and column list, and a drop must never take the index one of these queries, or one of the
 * SDK's and portal's queries, runs on.
 */
import { buildSchemaFromString, getAllEntitiesRelations } from '@subql/utils';
import { Utils } from '@subql/x-sequelize';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import * as ts from 'typescript';
import { TRIM_ENTRIES, TrimEntry } from '../../db/trimIndexes';

const ROOT = join(__dirname, '..', '..');
const QUERIES = new Set(['getAllByFields', 'getByFields', 'getByField', 'getOneByField']);

const camel = (name: string): string => name.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());

const indexedFields = (): Map<string, Set<string>> => {
  const schema = buildSchemaFromString(readFileSync(join(ROOT, 'schema.graphql'), 'utf8'));
  const { models } = getAllEntitiesRelations(schema);

  return new Map(
    models.map(model => [
      model.name,
      new Set(
        model.indexes.flatMap(index =>
          index.fields.map(field => camel(typeof field === 'string' ? field : String(field)))
        )
      ),
    ])
  );
};

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      return path.endsWith(join('src', 'types')) ? [] : sourceFiles(path);
    }
    return path.endsWith('.ts') ? [path] : [];
  });

interface Query {
  at: string;
  entity?: string;
  fields: string[];
  /** set when the call's entity or filter is not a literal the test can read */
  unreadable?: string;
}

const calleeName = (call: ts.CallExpression): string | undefined => {
  const { expression } = call;
  if (ts.isIdentifier(expression)) {
    return expression.text;
  }
  return ts.isPropertyAccessExpression(expression) ? expression.name.text : undefined;
};

/** `Entity.getByFields(...)`: the generated model method, whose receiver names the entity. */
const receiverEntity = (call: ts.CallExpression): string | undefined => {
  const { expression } = call;
  return ts.isPropertyAccessExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text !== 'store'
    ? expression.expression.text
    : undefined;
};

const filterFields = (filter: ts.Expression | undefined): string[] | undefined => {
  if (!filter || !ts.isArrayLiteralExpression(filter)) {
    return undefined;
  }
  const fields: string[] = [];
  for (const element of filter.elements) {
    if (!ts.isArrayLiteralExpression(element) || !ts.isStringLiteral(element.elements[0])) {
      return undefined;
    }
    fields.push(element.elements[0].text);
  }
  return fields;
};

const queriesIn = (path: string): Query[] => {
  const source = ts.createSourceFile(
    path,
    readFileSync(path, 'utf8'),
    ts.ScriptTarget.Latest,
    true
  );
  const found: Query[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const name = calleeName(node);
      if (name && QUERIES.has(name) && !ts.isFunctionLike(node.parent)) {
        const { line } = source.getLineAndCharacterOfPosition(node.getStart());
        const at = `${relative(ROOT, path)}:${line + 1}`;
        const receiver = receiverEntity(node);
        const [first, second] = node.arguments;

        if (receiver) {
          // Model.getByFields(filter, options) / Model.getByField(field, value, options)
          const fields =
            name === 'getByFields'
              ? filterFields(first)
              : first && ts.isStringLiteral(first)
              ? [first.text]
              : undefined;
          found.push(
            fields
              ? { at, entity: receiver, fields }
              : { at, fields: [], unreadable: 'filter is not a literal' }
          );
        } else if (first && ts.isStringLiteral(first)) {
          const fields =
            name === 'getByField' || name === 'getOneByField'
              ? second && ts.isStringLiteral(second)
                ? [second.text]
                : undefined
              : filterFields(second);
          found.push(
            fields
              ? { at, entity: first.text, fields }
              : { at, entity: first.text, fields: [], unreadable: 'filter is not a literal' }
          );
        } else if (first) {
          found.push({ at, fields: [], unreadable: 'entity is not a string literal' });
        }
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(source);
  return found;
};

/** The helper's own pass-through call, which forwards whatever its caller gave it. */
const FORWARDERS = new Set(['src/utils/common.ts']);

describe('store queries', () => {
  const indexes = indexedFields();
  const queries = sourceFiles(join(ROOT, 'src'))
    .filter(path => !FORWARDERS.has(relative(ROOT, path)))
    .flatMap(queriesIn);

  it('finds the queries it checks', () => {
    expect(queries.length).toBeGreaterThan(15);
  });

  it('reads every query as literals, so its fields can be checked', () => {
    expect(queries.filter(query => query.unreadable)).toEqual([]);
  });

  it('filters only on fields an index covers', () => {
    const unindexed = queries.flatMap(({ at, entity, fields }) =>
      entity
        ? fields
            .filter(field => !indexes.get(entity)?.has(field))
            .map(field => `${at}: ${entity}.${field}`)
        : []
    );

    expect(unindexed).toEqual([]);
  });
});

/**
 * The GiST indexes the SDK's and portal's queries were measured to use, as `[table, columns]`
 * (columns in the order Postgres lists them, `_block_range` left off). None may be dropped.
 */
const CONSUMER_USED: Array<[string, string]> = [
  ['asset_agent_actions', 'asset_id'],
  ['asset_agent_histories', 'asset_id'],
  ['asset_agents', 'asset_id'],
  ['asset_agents', 'asset_id, identity_id'],
  ['asset_holders', 'identity_id'],
  ['asset_transactions', 'asset_id'],
  ['asset_transactions', 'from_identity_id'],
  ['asset_transactions', 'from_portfolio_id'],
  ['asset_transactions', 'to_identity_id'],
  ['asset_transactions', 'to_portfolio_id'],
  ['assets', 'funding_round'],
  ['authorizations', 'to_id'],
  ['blocks', 'block_id'],
  ['claims', 'target_id'],
  ['custom_claim_types', 'identity_id'],
  ['custom_claim_types', 'updated_event_id'],
  ['distribution_payments', 'created_event_id'],
  ['distribution_payments', 'distribution_id'],
  ['distribution_payments', 'target_id'],
  ['distributions', 'asset_id'],
  ['events', 'event_id, module_id'],
  ['events', 'module_id'],
  ['extrinsics', 'address'],
  ['extrinsics', 'call_id'],
  ['extrinsics', 'extrinsic_hash'],
  ['instruction_affirmations', 'instruction_id'],
  ['instruction_events', 'instruction_id'],
  ['instruction_parties', 'identity'],
  ['instructions', 'venue_id'],
  ['investments', 'updated_event_id'],
  ['legs', 'asset_id'],
  ['legs', 'from'],
  ['legs', 'instruction_id'],
  ['legs', 'to'],
  ['multi_sig_proposal_votes', 'proposal_id'],
  ['multi_sig_proposals', 'multisig_id'],
  ['multi_sig_proposals', 'proposal_id'],
  ['nft_holders', 'asset_id'],
  ['nft_holders', 'identity_id'],
  ['nft_holders', 'updated_event_id'],
  ['off_chain_receipts', 'updated_event_id'],
  ['polyx_entries', 'account_id'],
  ['polyx_entries', 'identity_id'],
  ['portfolios', 'identity_id'],
  ['staking_events', 'identity_id'],
  ['staking_events', 'stash_account'],
  ['trusted_claim_issuers', 'asset_id'],
  ['trusted_claim_issuers', 'issuer_id'],
];

const trims = (): TrimEntry[] => TRIM_ENTRIES;

describe('GiST trim in db/trimIndexes.ts', () => {
  const { models } = getAllEntitiesRelations(
    buildSchemaFromString(readFileSync(join(ROOT, 'schema.graphql'), 'utf8'))
  );
  const column = (field: string): string => Utils.underscoredIf(field, true);
  const key = (columns: string[]): string => [...columns].sort().join(',');

  /** Each model's declared indexes as column lists, keyed by table name. */
  const declared = new Map(
    models.map(model => [
      Utils.underscoredIf(Utils.pluralize(model.name), true),
      model.indexes.map(index => index.fields.map(field => column(String(field)))),
    ])
  );
  const trimmed = trims();
  const dropped = (table: string, columns: string[]): boolean =>
    trimmed.some(trim => trim.table === table && key(trim.columns) === key(columns));

  const queries = sourceFiles(join(ROOT, 'src'))
    .filter(path => !FORWARDERS.has(relative(ROOT, path)))
    .flatMap(queriesIn);

  it('reads the entries it checks', () => {
    expect(trimmed.length).toBeGreaterThan(50);
    expect(trimmed.filter(trim => !declared.has(trim.table))).toEqual([]);
  });

  it('keeps an index leading with every field a store query filters on', () => {
    const lost = queries.flatMap(({ entity, fields, at }) => {
      if (!entity) {
        return [];
      }
      const table = Utils.underscoredIf(Utils.pluralize(entity), true);
      return fields
        .filter(
          field =>
            !(declared.get(table) ?? []).some(
              columns => columns[0] === column(field) && !dropped(table, columns)
            )
        )
        .map(field => `${at}: ${entity}.${field}`);
    });

    expect(lost).toEqual([]);
  });

  it('keeps every index the SDK and portal queries use', () => {
    const lost = CONSUMER_USED.filter(([table, columns]) =>
      dropped(table, columns.split(', '))
    ).map(([table, columns]) => `${table} (${columns})`);

    expect(lost).toEqual([]);
  });

  it('keeps the id index of the entities rewritten many times', () => {
    expect(trimmed.filter(trim => key(trim.columns) === 'id')).toEqual([]);
  });

  it('replaces exactly the indexes the schema still declares, and no others', () => {
    const wrong = trimmed
      .filter(trim => {
        const isDeclared = (declared.get(trim.table) ?? []).some(
          columns => key(columns) === key(trim.columns)
        );
        return isDeclared !== trim.standIn;
      })
      .map(trim => `${trim.table} (${trim.columns.join(', ')}) standin=${trim.standIn}`);

    expect(wrong).toEqual([]);
  });

  it('drops the polyx_entries (account_id, kind) index that only the validation script reads', () => {
    expect(dropped('polyx_entries', ['account_id', 'kind'])).toBe(true);
    expect(declared.get('polyx_entries')).not.toContainEqual(['account_id', 'kind']);
  });
});
