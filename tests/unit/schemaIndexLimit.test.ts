/**
 * Every entity stays within the node's index limit.
 *
 * SubQuery refuses to create a table with more than `indexCountLimit` (10) indexes and stops the
 * indexer on its first start ("too many indexes on entity …"). Relations count, `@index` fields
 * count, composite indexes count, and the GiST trim in `db/trimIndexes.ts` runs too late to help.
 */
import { buildSchemaFromString, getAllEntitiesRelations } from '@subql/utils';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const INDEX_COUNT_LIMIT = 10;

describe('schema.graphql', () => {
  it('declares no entity with more indexes than the node allows', () => {
    const schema = buildSchemaFromString(
      readFileSync(join(__dirname, '..', '..', 'schema.graphql'), 'utf8')
    );
    const { models } = getAllEntitiesRelations(schema);

    const over = models
      .filter(model => model.indexes.length > INDEX_COUNT_LIMIT)
      .map(model => `${model.name}: ${model.indexes.length}`);

    expect(over).toEqual([]);
  });
});
