/**
 * Writes `src/seed/shapes.json`, the storage shapes the seeders read (`scripts/lib/seedShapes.ts`).
 * Run after adding a seeder, changing what one reads, or re-running the storage survey.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import history from '../tests/fixtures/storage-history.json';
import { SEEDERS } from '../src/seed/seeders';
import { seedShapes, StorageHistory } from './lib/seedShapes';

writeFileSync(
  join(__dirname, '..', 'src', 'seed', 'shapes.json'),
  `${JSON.stringify(seedShapes(SEEDERS, history as unknown as StorageHistory), null, 2)}\n`
);
