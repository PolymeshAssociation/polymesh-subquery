/**
 * Lists the stretches of a sync where the indexer advanced slower than `--max-rate` blocks a second
 * (default 50) for at least `--min-seconds` (default 60), with each stretch's block and event
 * counts, its most common events and its most common signed calls. Compare two runs' output to
 * catch a throughput regression.
 *
 * `--samples` is a file of `time,height` lines (epoch seconds, then the indexed height), sampled at
 * a steady interval while the node syncs, for example every 10 s from `_metadata`'s
 * `lastProcessedHeight`.
 *
 *   DB_HOST=h DB_PORT=p DB_USER=u DB_PASS=p DB_DATABASE=d \
 *     yarn ts-node scripts/slow-blocks.ts --samples heights.csv [--max-rate 50] [--min-seconds 60]
 *       [--schema public]
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getPostgresDataSource } from '../db/utils';
import { argOf } from './lib/chain';
import { parseSamples, slowStretches } from './lib/slowStretches';

const padId = (n: number): string => String(n).padStart(10, '0');

const main = async (): Promise<void> => {
  const file = argOf('samples');
  if (!file) {
    console.error(
      'usage: slow-blocks.ts --samples <time,height file> [--max-rate 50] [--min-seconds 60] [--schema s]'
    );
    process.exit(2);
  }

  const stretches = slowStretches(
    // `yarn` runs scripts from the project root; a relative path means the caller's directory
    parseSamples(readFileSync(resolve(process.env.INIT_CWD ?? process.cwd(), file), 'utf8')),
    Number(argOf('max-rate') ?? 50),
    Number(argOf('min-seconds') ?? 60)
  );

  const db = await getPostgresDataSource();
  await db.query(`SET search_path TO ${argOf('schema') ?? 'public'}`);

  const reports = await Promise.all(
    stretches.map(async ({ from, to, seconds }) => {
      const range = [padId(from), padId(to)];
      const [counts, events, calls] = await Promise.all([
        db.query(
          'SELECT count(DISTINCT block_id) AS blocks, count(*) AS events FROM events WHERE block_id BETWEEN $1 AND $2',
          range
        ),
        db.query(
          `SELECT module_id || '.' || event_id AS name, count(*) AS n FROM events
            WHERE block_id BETWEEN $1 AND $2 GROUP BY 1 ORDER BY 2 DESC LIMIT 3`,
          range
        ),
        db.query(
          `SELECT module_id_text || '.' || call_id_text AS name, count(*) AS n FROM extrinsics
            WHERE signed = 1 AND block_id BETWEEN $1 AND $2 GROUP BY 1 ORDER BY 2 DESC LIMIT 2`,
          range
        ),
      ]);
      return [
        `== heights ${from}-${to}: slow for ${seconds}s`,
        `  ${counts[0].blocks} blocks, ${counts[0].events} events`,
        ...(events as { name: string; n: string }[]).map(e => `  ${e.name} x${e.n}`),
        ...(calls as { name: string; n: string }[]).map(c => `  call ${c.name} x${c.n}`),
      ];
    })
  );
  reports.flat().forEach(line => console.log(line));

  const total = stretches.reduce((sum, { seconds }) => sum + seconds, 0);
  console.log(`\n${stretches.length} slow stretches, ${Math.round(total / 60)} minutes in all`);
  await db.destroy();
};

main().catch(e => {
  console.error(e);
  process.exit(2);
});
