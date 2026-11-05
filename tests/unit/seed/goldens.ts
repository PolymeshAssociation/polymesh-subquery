/** The former genesis handler's rows for a chain (`tests/fixtures/genesis/<chain>.golden.json.gz`) */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';

type Row = Record<string, unknown>;

export const golden = (chain: 'testnet' | 'mainnet'): Record<string, Row[]> =>
  JSON.parse(
    gunzipSync(
      readFileSync(join(__dirname, '..', '..', 'fixtures', 'genesis', `${chain}.golden.json.gz`))
    ).toString()
  );

/** Rows as comparable JSON, by id, without the fields named, and with bigints as strings */
export const byId = (rows: Row[], without: string[] = []): Record<string, Row> =>
  Object.fromEntries(
    rows.map(row => [
      row.id as string,
      JSON.parse(
        JSON.stringify(
          Object.fromEntries(
            Object.entries(row).filter(
              ([field, value]) => !without.includes(field) && value !== undefined
            )
          ),
          (_key, value) => (typeof value === 'bigint' ? value.toString() : value)
        )
      ),
    ])
  );
