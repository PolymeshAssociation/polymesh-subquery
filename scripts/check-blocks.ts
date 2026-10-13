/**
 * Checks that the index holds every block, extrinsic and event it should, against the chain, over a
 * range of blocks. `check-state.ts` compares the state the handlers build; this compares the raw
 * record they build it from, so a handler that silently drops an event shows up here.
 *
 * What the index should hold is worked out from `project.ts`: every event whose module (and, for
 * `system`, method) a `handleEvent` filter names, the extrinsic each of those came from, and a
 * `Block` row for a block with any of them. For each block:
 *
 *   - every expected event is indexed at its position in the block, under the chain's name;
 *   - every indexed event matches the chain's event at its position, and is either expected or an
 *     extrinsic's closing `ExtrinsicSuccess`/`ExtrinsicFailed`, which the index writes as the
 *     provenance of a change with no event of its own (a call handler's, or an unannounced fee's);
 *   - the extrinsic of every expected event is indexed, and so is the block, under the chain's hash.
 *
 *   DB_HOST=h DB_PORT=p DB_USER=u DB_PASS=p DB_DATABASE=d \
 *     yarn ts-node scripts/check-blocks.ts --rpc <archive node> --from N --to M [--step 1]
 *       [--schema public] [--show 20]
 *
 * Exits non-zero when anything differs.
 */
import { ApiPromise } from '@polkadot/api';
import { DataSource } from 'typeorm';
import { getPostgresDataSource } from '../db/utils';
import project from '../project';
import { argOf, atHeight, connect } from './lib/chain';
import { Filter, expectedEvents, isClosing } from './lib/expectedRecords';

/** Blocks checked at once: each is two RPC reads and three queries */
const CONCURRENCY = 4;

const padId = (n: number): string => String(n).padStart(10, '0');

/** The `handleEvent` filters every runtime datasource subscribes with */
const eventFilters = (): Filter[] =>
  (project.dataSources as { mapping: { handlers: { handler: string; filter?: Filter }[] } }[])
    .flatMap(source => source.mapping.handlers)
    .filter(handler => handler.handler === 'handleEvent' && handler.filter)
    .map(handler => handler.filter as Filter);

const checkBlock = async (
  api: ApiPromise,
  db: DataSource,
  filters: Filter[],
  height: number
): Promise<string[]> => {
  const { at, hash } = await atHeight(api, height);
  const blockId = padId(height);
  const [records, events, extrinsics, blocks] = await Promise.all([
    at.query.system.events() as unknown as Promise<
      {
        phase: { isApplyExtrinsic: boolean; asApplyExtrinsic: { toNumber(): number } };
        event: { section: string; method: string };
      }[]
    >,
    db.query('SELECT event_idx, module_id, event_id FROM events WHERE block_id = $1', [
      blockId,
    ]) as Promise<{ event_idx: number; module_id: string; event_id: string }[]>,
    db.query('SELECT extrinsic_idx FROM extrinsics WHERE block_id = $1', [blockId]) as Promise<
      { extrinsic_idx: number }[]
    >,
    db.query('SELECT id, hash FROM blocks WHERE id = $1', [blockId]) as Promise<
      { id: string; hash: string }[]
    >,
  ]);

  const chain = records.map(({ phase, event }) => ({
    section: event.section,
    method: event.method,
    extrinsic: phase.isApplyExtrinsic ? phase.asApplyExtrinsic.toNumber() : undefined,
  }));
  const expected = expectedEvents(chain, filters);
  const problems: string[] = [];

  const indexed = new Map(events.map(row => [Number(row.event_idx), row]));
  expected.forEach(idx => {
    if (!indexed.has(idx)) {
      problems.push(`event #${idx} ${chain[idx].section}.${chain[idx].method} not indexed`);
    }
  });
  indexed.forEach((row, idx) => {
    const onChain = chain[idx];
    const name = `${row.module_id}.${row.event_id}`;
    if (!onChain) {
      problems.push(`event #${idx} ${name} indexed, but the block has no event there`);
    } else if (`${onChain.section}.${onChain.method}`.toLowerCase() !== name.toLowerCase()) {
      problems.push(
        `event #${idx} indexed as ${name}, chain has ${onChain.section}.${onChain.method}`
      );
    } else if (!expected.has(idx) && !isClosing(onChain)) {
      problems.push(`event #${idx} ${name} indexed, but no handler subscribes to it`);
    }
  });

  const indexedExtrinsics = new Set(extrinsics.map(row => Number(row.extrinsic_idx)));
  new Set(Array.from(expected, idx => chain[idx].extrinsic)).forEach(extrinsic => {
    if (extrinsic !== undefined && !indexedExtrinsics.has(extrinsic)) {
      problems.push(`extrinsic ${extrinsic} not indexed`);
    }
  });

  if (expected.size > 0 && blocks.length === 0) {
    problems.push('block not indexed');
  }
  if (blocks[0] && blocks[0].hash !== hash) {
    problems.push(`block indexed with hash ${blocks[0].hash}, chain has ${hash}`);
  }

  return problems.map(problem => `${height}: ${problem}`);
};

const main = async (): Promise<void> => {
  const rpc = argOf('rpc');
  const from = Number(argOf('from'));
  const to = Number(argOf('to'));
  const step = Number(argOf('step') ?? 1);
  if (!rpc || [from, to, step].some(Number.isNaN) || from > to || step < 1) {
    console.error(
      'usage: check-blocks.ts --rpc <archive node> --from N --to M [--step 1] [--schema s] [--show n]'
    );
    process.exit(2);
  }

  const api = await connect(rpc);
  const db = await getPostgresDataSource();
  await db.query(`SET search_path TO ${argOf('schema') ?? 'public'}`);
  const filters = eventFilters();

  const queue = Array.from(
    { length: Math.floor((to - from) / step) + 1 },
    (_, i) => from + i * step
  );
  const problems: string[] = [];
  const work = async (): Promise<void> => {
    const height = queue.shift();
    if (height === undefined) {
      return;
    }
    problems.push(...(await checkBlock(api, db, filters, height)));
    return work();
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, work));

  const checked = Math.floor((to - from) / step) + 1;
  problems.sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10));
  problems.slice(0, Number(argOf('show') ?? 20)).forEach(problem => console.log(problem));
  console.log(
    problems.length === 0
      ? `${checked} blocks checked. No differences.`
      : `${checked} blocks checked. ${problems.length} differences.`
  );

  await api.disconnect();
  await db.destroy();
  process.exit(problems.length === 0 ? 0 : 1);
};

main().catch(e => {
  console.error(e);
  process.exit(2);
});
