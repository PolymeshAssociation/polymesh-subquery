/**
 * Backfills `authorizations.data` for rows indexed before the chain migrated stored authorization
 * payloads from tickers to asset ids.
 *
 * The chain's v6 to v7 `ticker_migrations` rewrote each payload with `AssetId::from(ticker)`, which
 * is `blake2_128(("legacy_ticker", ticker))` normalised to a v8 UUID. That is reproducible from the
 * ticker already stored here, so this runs entirely against the database - no chain connection, and
 * no dependence on an archive node still holding the state.
 *
 * Rows repaired are still-pending `TransferAssetOwnership`/`BecomeAgent` current revisions whose
 * payload is a 12 byte ticker rather than a 16 byte asset id. Closed `_block_range` revisions are
 * never touched, so the pre-repair payload stays queryable at its own block height. Pagination runs
 * on `_id` because `id` is not unique under historical mode (see scripts/backfill/historical.ts).
 *
 * Usage (from the repo root):
 *   DB_HOST=h DB_PORT=p DB_USER=u DB_PASS=p DB_DATABASE=d \
 *     yarn ts-node scripts/backfill/authorization-payloads.ts [--apply]
 *        [--batch-size=N] [--limit=N]
 *
 * Defaults to a dry run, which prints would-be updates and a summary without writing anything.
 * Connection details come from the DB_* environment variables used by `db/utils.ts`; they can be
 * set inline for one invocation, keeping credentials out of argv (and out of `ps`).
 */
import { DataSource } from 'typeorm';

import { getPostgresDataSource } from '../../db/utils';
import {
  AUTHORIZATION_TYPES_MIGRATED_TO_ASSET_IDS,
  legacyTickerOf,
  withAssetId,
} from '../../src/mappings/entities/identities/repairAuthorizations';
import { getAssetIdForLegacyTicker } from '../../src/utils/assets';
import {
  fetchCurrentBatch,
  nextFetchSize,
  printDryRun,
  resumeFrom,
  updateCurrentRevisions,
} from './historical';

/** The `genesisBlock` row records the chain's genesis hash, which is what `chainId` holds */
const GENESIS_BLOCK_ID = '0000000000';

/** Candidates: pending rows of the two types the migration rewrote */
const REPAIRABLE_AUTHORIZATIONS = `status = 'Pending' and type in (${[
  ...AUTHORIZATION_TYPES_MIGRATED_TO_ASSET_IDS,
]
  .map(type => `'${type}'`)
  .join(', ')})`;

interface Args {
  apply: boolean;
  batchSize: number;
  limit?: number;
}

const parseArgs = (): Args => {
  const args: Args = { apply: false, batchSize: 500 };

  for (const arg of process.argv.slice(2)) {
    const [key, value] = arg.replace(/^--/, '').split('=');

    switch (key) {
      case 'apply':
        args.apply = true;
        break;
      case 'batch-size':
        args.batchSize = Number(value);
        break;
      case 'limit':
        args.limit = Number(value);
        break;
      default:
        throw new Error(`Unknown argument "${arg}"`);
    }
  }

  return args;
};

interface PendingRow {
  _id: string;
  data: string | null;
  id: string;
}

interface PlannedRepair {
  _id: string;
  data: string;
  id: string;
  ticker: string;
}

interface Summary {
  repaired: number;
  stale: number;
}

/**
 * `getAssetIdForLegacyTicker` reads the injected `chainId` to spot the one staging chain that
 * migrated without the UUID normalisation. Outside the indexer that global does not exist, so it is
 * taken from the genesis block row the genesis handler wrote it to.
 */
const loadChainId = async (postgres: DataSource): Promise<void> => {
  const [genesis] = await postgres.query('select hash from blocks where id = $1', [
    GENESIS_BLOCK_ID,
  ]);

  if (!genesis?.hash) {
    throw new Error(
      `No genesis block row (id ${GENESIS_BLOCK_ID}) to read the chain id from. This instance was ` +
        'indexed without the genesis handler, so asset ids cannot be derived safely.'
    );
  }

  (globalThis as any).chainId = genesis.hash;
  console.log(`Deriving asset ids for chain ${genesis.hash}`);
};

const planRepairs = async (rows: PendingRow[], summary: Summary): Promise<PlannedRepair[]> => {
  const repairs: PlannedRepair[] = [];

  for (const row of rows) {
    const ticker = legacyTickerOf(row.data);

    if (!ticker) {
      continue;
    }

    summary.stale += 1;
    repairs.push({
      _id: row._id,
      id: row.id,
      ticker,
      data: withAssetId(row.data, await getAssetIdForLegacyTicker(ticker)),
    });
  }

  return repairs;
};

const applyRepairs = async (
  postgres: DataSource,
  repairs: PlannedRepair[],
  summary: Summary
): Promise<void> => {
  for (const { _id, data } of repairs) {
    const updated = await updateCurrentRevisions(
      postgres,
      'authorizations',
      'data = $1',
      "_id = $2 and status = 'Pending'",
      [data, _id]
    );

    if (updated) {
      summary.repaired += 1;
    } else {
      logger.warn(`Authorization ${_id} was modified concurrently, skipping`);
    }
  }
};

const repairPass = async (postgres: DataSource, args: Args, summary: Summary): Promise<void> => {
  let afterId: string | null = null;
  let scanned = 0;

  // keyset pagination on _id; stops on a short batch or once the limit is hit exactly
  for (;;) {
    const fetchSize = nextFetchSize(args, scanned);

    if (fetchSize <= 0) {
      break;
    }

    // annotated to keep strict-mode's circularity checker out of the pagination loop
    const rows: PendingRow[] = await fetchCurrentBatch<PendingRow>(
      postgres,
      { table: 'authorizations', where: REPAIRABLE_AUTHORIZATIONS },
      afterId,
      fetchSize
    );

    afterId = resumeFrom(rows, afterId);
    scanned += rows.length;

    const repairs = await planRepairs(rows, summary);

    if (args.apply) {
      await applyRepairs(postgres, repairs, summary);
    } else {
      printDryRun(repairs, ({ id, ticker, data }) => `Would repair ${id}: ${ticker} -> ${data}`);
    }

    if (rows.length < fetchSize) {
      break;
    }
  }
};

const main = async (): Promise<void> => {
  const args = parseArgs();

  const postgres = await getPostgresDataSource();
  const summary: Summary = { repaired: 0, stale: 0 };

  try {
    await loadChainId(postgres);
    await repairPass(postgres, args, summary);

    console.log(
      `Done. ${summary.stale} rows still named a ticker, ` +
        `${
          args.apply ? `repaired ${summary.repaired}.` : 'nothing written. Pass --apply to write.'
        }`
    );
  } finally {
    await postgres.destroy();
  }
};

main()
  .then(() => process.exit(0))
  .catch(e => {
    console.error(e);
    process.exit(1);
  });
