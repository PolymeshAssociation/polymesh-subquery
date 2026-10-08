/**
 * Every store query in `src/` filters only on indexed fields.
 *
 * SubQuery's store rejects `getByField` / `getByFields` on a field no index covers, at runtime and
 * on the first block that reaches the query. The unit tests' store mocks accept any field, so
 * nothing else catches it before a sync does. This reads each call's entity and field names from
 * the source and checks them against the indexes SubQuery derives from `schema.graphql`, with the
 * node's own rule: a field counts if any index on the model lists it.
 */
import { buildSchemaFromString, getAllEntitiesRelations } from '@subql/utils';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import * as ts from 'typescript';

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
