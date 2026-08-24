/**
 * Backfills the senders of historical `revive.ethTransact` extrinsics.
 *
 * These extrinsics are unsigned - the sender exists only inside the Ethereum style signature
 * carried by their call argument - so rows indexed before sender attribution was added have
 * `address = null`. The raw RLP payloads are still stored in `extrinsics.params_txt`, which makes
 * history recoverable offline, without touching the chain.
 *
 * For every affected row this script recovers the signer from the payload, then
 * - sets `extrinsics.address` to the SS58 encoding of the `0xEE` padded Ethereum derived account,
 *   alongside its `eth_address` and `eth_tx_hash`
 * - upserts an `accounts` row for that address (`key_type = 'ethereum'`) so joins against
 *   `extrinsics.address` resolve. The forward path only ever creates accounts through an Identity's
 *   key records; these keys have none, so an unattached row is inserted instead
 *
 * Only current revisions are read and written, and pagination runs on `_id` - see
 * `scripts/backfill/historical.ts` for why. Backfilled rows keep their raw
 * `module_id`/`call_id`/`params_txt`/`success` and get no `EvmTransaction` entity; the deployment
 * notes cover what that means for consumers.
 *
 * Usage (from the repo root):
 *   DB_HOST=h DB_PORT=p DB_USER=u DB_PASS=p DB_DATABASE=d \
 *     yarn ts-node scripts/backfill/eth-transact-senders.ts [--apply]
 *        [--batch-size=N] [--ss58-format=N] [--limit=N]
 *
 * Defaults to a dry run, which prints would-be updates and a summary without writing anything.
 * Connection details come from the DB_* environment variables used by `db/utils.ts`; setting them
 * inline keeps credentials out of argv.
 */

/**
 * `tsconfig.json` maps SubQuery's injected globals onto `src/**` only, so code running through
 * ts-node declares what it uses itself.
 */
declare global {
  const logger: {
    debug: (message: string) => void;
    error: (message: string) => void;
    info: (message: string) => void;
    warn: (message: string) => void;
  };
}

import { hexToU8a } from '@polkadot/util';
import { randomUUID } from 'node:crypto';
import { DataSource, EntityManager } from 'typeorm';

import { getPostgresDataSource } from '../../db/utils';
import { ss58FromEthAddress } from '../../src/utils/eth';
import {
  decodeEthTransaction,
  ethTxHash as computeEthTxHash,
  recoverEthSender,
} from '../../src/utils/ethTransaction';
import { CURRENT_REVISION, fetchCurrentBatch, updateCurrentRevisions } from './historical';

// `src/utils/ethTransaction.ts` logs through the injected `logger`; nothing calls it before this
(globalThis as any).logger = console;

/** Rows this script is responsible for: indexed as `revive.eth_transact`, never attributed */
const UNATTRIBUTED_ETH_TRANSACT =
  "module_id = 'revive' and call_id = 'eth_transact' and address is null";

/** Pinned rather than read from `registry.chainSS58` (as the forward path does) since this runs offline */
const DEFAULT_SS58_FORMAT = 12;

interface Args {
  apply: boolean;
  batchSize: number;
  limit?: number;
  ss58Format: number;
}

const parseArgs = (): Args => {
  const args: Args = { apply: false, batchSize: 500, ss58Format: DEFAULT_SS58_FORMAT };

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
      case 'ss58-format':
        args.ss58Format = Number(value);
        break;
      default:
        throw new Error(`Unknown argument "${arg}"`);
    }
  }

  return args;
};

/** Extracts the RLP payload hex from the `{"payload": "0x..."}` JSON stored in `params_txt` */
const extractPayload = (paramsTxt: string | null): string | undefined => {
  if (!paramsTxt) {
    return undefined;
  }

  try {
    const { payload } = JSON.parse(paramsTxt);

    return typeof payload === 'string' && payload.startsWith('0x') ? payload : undefined;
  } catch {
    return undefined;
  }
};

interface Recovered {
  ethAddress: string;
  ethTxHash: string;
  id: string;
  ss58: string;
}

interface RecoveryTotals {
  accountsInserted: number;
  accountsSkippedNoBlock: number;
  accountsUpdated: number;
  extrinsicsUpdated: number;
}

interface RecoveredBatch {
  failed: number;
  lastScannedId: string | null;
  recovered: Recovered[];
  scannedCount: number;
}

const recoverBatch = async (
  postgres: DataSource,
  args: Args,
  afterId: string | null,
  fetchSize: number
): Promise<RecoveredBatch> => {
  const rows = await fetchCurrentBatch<{ id: string; params_txt: string | null }>(
    postgres,
    { table: 'extrinsics', where: UNATTRIBUTED_ETH_TRANSACT },
    afterId,
    fetchSize
  );

  const recovered: Recovered[] = [];
  let lastScannedId = afterId;
  let failed = 0;

  for (const { _id, id, params_txt } of rows) {
    lastScannedId = _id;

    const payload = extractPayload(params_txt);
    const tx = payload ? decodeEthTransaction(hexToU8a(payload)) : undefined;
    const from = tx ? recoverEthSender(tx) : undefined;

    if (!payload || !tx || !from) {
      // malformed payloads are skipped exactly like the forward mapping handler skips them
      logger.warn(`Unable to recover the sender of ${id}, skipping`);
      failed += 1;

      continue;
    }

    recovered.push({
      id,
      ss58: ss58FromEthAddress(from, args.ss58Format),
      ethAddress: from,
      ethTxHash: computeEthTxHash(hexToU8a(payload)),
    });
  }

  return {
    failed,
    lastScannedId,
    recovered,
    scannedCount: rows.length,
  };
};

/**
 * Repairs one extrinsic row and its account row inside an open transaction.
 *
 * An existing account is reclassified in place. Where none exists - the forward path only creates
 * accounts through an Identity's key records, and these keys have none - a minimal unattached row
 * is inserted so `extrinsics.address` joins resolve.
 */
const applyRecovery = async (
  manager: EntityManager,
  { ethAddress, ethTxHash, id, ss58 }: Recovered,
  totals: RecoveryTotals
): Promise<void> => {
  totals.extrinsicsUpdated += await updateCurrentRevisions(
    manager,
    'extrinsics',
    'address = $1, eth_address = $2, eth_tx_hash = $3',
    'id = $4',
    [ss58, ethAddress, ethTxHash, id]
  );

  totals.accountsUpdated += await updateCurrentRevisions(
    manager,
    'accounts',
    "key_type = 'ethereum', evm_address = $2",
    "id = $1 and (key_type is distinct from 'ethereum' or evm_address is distinct from $2)",
    [ss58, ethAddress]
  );

  // `id` carries no unique constraint under historical mode, so existence must be checked
  // explicitly instead of relying on ON CONFLICT
  const existing = await manager.query(
    `select 1
       from accounts
      where ${CURRENT_REVISION}
        and id = $1
      limit 1`,
    [ss58]
  );

  if (existing.length) {
    return;
  }

  // `_id` and `_block_range` are NOT NULL with no DB default under historical mode and must be
  // supplied explicitly (see migration 11); `returning id` doubles as the insertion count, as
  // TypeORM carries no affected-rows tuple for INSERT
  const inserted: unknown[][] = await manager.query(
    `insert into accounts
           (id, address, key_type, evm_address, event_id, datetime, created_block_id,
            updated_block_id, _id, _block_range)
    select $1, $1, 'ethereum', $2, 'AccountCreated', b.datetime, e.block_id, e.block_id,
           $3::uuid, int8range(e.block_id::bigint, NULL::bigint)
      from extrinsics e
      left join blocks b on b.id = e.block_id and upper(b._block_range) is null
     where upper(e._block_range) is null
       and e.id = $4
       and b.datetime is not null
     returning id`,
    [ss58, ethAddress, randomUUID(), id]
  );

  if (inserted.length) {
    totals.accountsInserted += 1;
  } else {
    totals.accountsSkippedNoBlock += 1;
    logger.warn(`No block datetime found for ${id}, account row not created`);
  }
};

const applyRecoveries = async (
  postgres: DataSource,
  batch: Recovered[],
  totals: RecoveryTotals
): Promise<void> => {
  // a failure rolls back its batch and stops the run; re-running resumes, since rows repaired by
  // earlier batches no longer match `address is null`
  await postgres.transaction(async manager => {
    for (const recovery of batch) {
      await applyRecovery(manager, recovery, totals);
    }
  });
};

const main = async (): Promise<void> => {
  const args = parseArgs();

  const postgres = await getPostgresDataSource();

  try {
    const [{ count }] = await postgres.query(
      `select count(*)::int as count
         from extrinsics
        where ${CURRENT_REVISION}
          and ${UNATTRIBUTED_ETH_TRANSACT}`
    );
    console.log(`Found ${count} revive.eth_transact extrinsics without an address`);

    if (Number(count) === 0) {
      return;
    }

    const totals: RecoveryTotals = {
      accountsInserted: 0,
      accountsSkippedNoBlock: 0,
      accountsUpdated: 0,
      extrinsicsUpdated: 0,
    };

    let scanned = 0;
    let failed = 0;
    let afterId: string | null = null;
    let exhausted = false;

    while (!exhausted) {
      // honor the limit precisely instead of overshooting to the next batch boundary
      const fetchSize =
        args.limit === undefined ? args.batchSize : Math.min(args.batchSize, args.limit - scanned);

      if (fetchSize <= 0) {
        break;
      }

      const {
        failed: batchFailed,
        lastScannedId,
        recovered,
        scannedCount,
      } = await recoverBatch(postgres, args, afterId, fetchSize);

      scanned += scannedCount;
      failed += batchFailed;

      if (args.apply) {
        if (recovered.length) {
          await applyRecoveries(postgres, recovered, totals);
        }
      } else if (recovered.length) {
        console.log('Would update:');
        recovered.forEach(({ id, ss58 }) => console.log(`  ${id} -> ${ss58}`));
      }

      afterId = lastScannedId;
      exhausted = scannedCount < fetchSize;
    }

    const outcome = args.apply
      ? `Updated ${totals.extrinsicsUpdated} extrinsics, reclassified ` +
        `${totals.accountsUpdated} and inserted ${totals.accountsInserted} accounts ` +
        `(${totals.accountsSkippedNoBlock} skipped for missing block datetime).`
      : 'Dry run, nothing written. Pass --apply to write.';

    console.log(
      `Done. Scanned ${scanned} rows, recovered ${scanned - failed}, failed ${failed}. ${outcome}`
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
