/**
 * What every seeder owes the rest of the seed: reads the storage survey knows, shapes the snapshot
 * can check them against, and the Account fields the account closure covers.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import history from '../../fixtures/storage-history.json';
import shapes from '../../../src/seed/shapes.json';
import { SEEDERS } from '../../../src/seed/seeders';
import { seedShapes, StorageHistory } from '../../../scripts/lib/seedShapes';

const surveyed = history as unknown as StorageHistory;

/** Each entity's fields that relate to `Account`, as model attribute names (`<field>Id`) */
const accountRelations = (): Record<string, string[]> => {
  const schema = readFileSync(join(__dirname, '..', '..', '..', 'schema.graphql'), 'utf8');
  const relations: Record<string, string[]> = {};
  for (const [, entity, body] of schema.matchAll(/type (\w+) @entity[^{]*\{([^}]*)\}/g)) {
    relations[entity] = [...body.matchAll(/^\s*(\w+): Account!?\s*(@index[^\n]*)?$/gm)].map(
      ([, field]) => `${field}Id`
    );
  }
  return relations;
};

describe('the seeders', () => {
  it('read storage the survey records', () => {
    const reads = SEEDERS.flatMap(({ reads }) => reads);

    expect(reads.filter(item => !(item in surveyed))).toEqual([]);
  });

  it('name only surveyed ranges as the old shapes they read', () => {
    const unknown = SEEDERS.flatMap(({ oldShapes = {} }) =>
      Object.entries(oldShapes).flatMap(([item, froms = []]) =>
        froms
          .filter(from => !surveyed[item]?.ranges.some(range => range.from === from))
          .map(from => `${item}@${from}`)
      )
    );

    expect(unknown).toEqual([]);
  });

  it('have their shapes in src/seed/shapes.json, as yarn seed:shapes writes them', () => {
    expect(shapes).toEqual(seedShapes(SEEDERS, surveyed));
  });

  it('list every field naming an Account, so the account closure covers it', () => {
    const relations = accountRelations();
    const unlisted = SEEDERS.flatMap(({ entity, accounts = [] }) =>
      (relations[entity] ?? [])
        .filter(field => !accounts.includes(field))
        .map(field => `${entity}.${field}`)
    );

    expect(unlisted).toEqual([]);
  });
});
