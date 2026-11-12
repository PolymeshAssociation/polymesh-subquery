/**
 * No `@jsonField` type has a `BigInt` member.
 *
 * SubQuery writes a `bigint` inside a JSON column as the string `"<digits>n"`
 * (`@subql/node-core` `processSetJson`), and reads it back as a `bigint` in mappings, so nothing in
 * the indexer notices. GraphQL consumers receive the string with the `n`. Amounts inside JSON are
 * decimal strings instead.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const schema = readFileSync(join(__dirname, '..', '..', 'schema.graphql'), 'utf8');

describe('@jsonField types', () => {
  const types = [...schema.matchAll(/type (\w+) @jsonField[^{]*\{([\s\S]*?)\n\}/g)];

  it('finds them', () => {
    expect(types.length).toBeGreaterThan(15);
  });

  it('have no BigInt member', () => {
    const bigints = types.flatMap(([, name, body]) =>
      [...body.matchAll(/^\s*(\w+): \[?BigInt/gm)].map(([, field]) => `${name}.${field}`)
    );

    expect(bigints).toEqual([]);
  });
});
