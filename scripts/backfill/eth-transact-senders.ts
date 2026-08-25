/**
 * Backfills the senders of historical `revive.ethTransact` extrinsics.
 *
 * These extrinsics are unsigned - the sender exists only inside the Ethereum style signature
 * carried by their call argument - so rows indexed before sender attribution was added have
 * `address = null`. The raw RLP payloads are still stored in `extrinsics.params_txt`, which makes
 * history recoverable offline, without touching the chain.
 *
 * It runs two passes:
 *
 * 1. Account classification. Migration 20 defaults every pre-existing account to
 *    `key_type = 'substrate'` with a null `evm_address`, because postgres cannot decode an SS58
 *    address. Ethereum keys were attributed long before `eth_transact` was indexed - registering a
 *    DID or joining an identity emits the `0xEE` padded SS58 like any other key - so every account
 *    is decoded here: all of them get the `evm_address` `pallet_revive` addresses them by, and the
 *    `0xEE` padded ones get `key_type = 'ethereum'`.
 * 2. Sender recovery. For every unattributed `revive.eth_transact` row, recover the signer and
 *    - set `extrinsics.address` to the `0xEE` padded account it dispatched as, alongside its
 *      `eth_address` and `eth_tx_hash`
 *    - upsert an `accounts` row for that address so joins against `extrinsics.address` resolve. The
 *      forward path only ever creates accounts through an Identity's key records; these keys have
 *      none, so an unattached row is inserted instead
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
 * `--limit` caps each pass independently. Connection details come from the DB_* environment
 * variables used by `db/utils.ts`; setting them inline keeps credentials out of argv.
 */

import { hexToU8a } from '@polkadot/util';
import { randomUUID } from 'node:crypto';
import { DataSource, EntityManager } from 'typeorm';

import { getPostgresDataSource } from '../../db/utils';
import { evmAddressFromSs58, isEthDerivedAddress, ss58FromEthAddress } from '../../src/utils/eth';
import {
  decodeEthTransaction,
  ethTxHash as computeEthTxHash,
  recoverEthSender,
} from '../../src/utils/ethTransaction';
import {
  CURRENT_REVISION,
  fetchCurrentBatch,
  nextFetchSize,
  printDryRun,
  updateCurrentRevisions,
} from './historical';

// `src/utils/ethTransaction.ts` logs through the injected `logger`; nothing calls it before this
(globalThis as any).logger = console;

/** Rows this script is responsible for: indexed as `revive.eth_transact`, never attributed */
const UNATTRIBUTED_ETH_TRANSACT =
  "module_id = 'revive' and call_id = 'eth_transact' and address is null";

/**
 * Accounts predating the `key_type`/`evm_address` columns. `evm_address` is derived for every
 * account, so its absence is the marker - and skipping rows that already carry one keeps re-runs
 * cheap.
 */
const UNCLASSIFIED_ACCOUNTS = 'evm_address is null';

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

interface AccountRow {
  address: string;
  id: string;
}

interface ClassifyTotals {
  ethereum: number;
  resolved: number;
  scanned: number;
  undecodable: number;
  updated: number;
}

/**
 * Fills `key_type`/`evm_address` on accounts indexed before those columns existed.
 *
 * Every account has an H160 that `pallet_revive` addresses it by - Ethereum keys drop their `0xEE`
 * padding, substrate keys are hashed and truncated - so `evm_address` is filled for all of them,
 * matching what `getAccountKeyType` does on the forward path. `key_type` is only corrected for the
 * ones decoding as `0xEE` padded; migration 20's provisional `substrate` is already right for the
 * rest.
 *
 * This is deliberately independent of `EvmAccountMapping`, which tracks the *registered*
 * `revive.mapAccount` relationship and is revoked by `unmapAccount`. The address derived here
 * never stops being valid, so historical joins survive an unmapping.
 */
interface Classification {
  evmAddress: string;
  id: string;
  keyType: string;
}

/** Decodes one account, or `undefined` when its address is not 32 bytes under this prefix */
const classifyRow = (row: AccountRow, ss58Format: number): Classification | undefined => {
  const evmAddress = evmAddressFromSs58(row.address, ss58Format);

  if (!evmAddress) {
    return undefined;
  }

  return {
    id: row.id,
    evmAddress,
    keyType: isEthDerivedAddress(row.address, ss58Format) ? 'ethereum' : 'substrate',
  };
};

const tallyClassifications = (
  scanned: number,
  classifications: Classification[],
  totals: ClassifyTotals
): void => {
  totals.scanned += scanned;
  totals.resolved += classifications.length;
  totals.ethereum += classifications.filter(({ keyType }) => keyType === 'ethereum').length;
  // a wrong --ss58-format lands every row here, which the caller reports on
  totals.undecodable += scanned - classifications.length;
};

const applyClassifications = async (
  postgres: DataSource,
  classifications: Classification[],
  totals: ClassifyTotals
): Promise<void> => {
  if (!classifications.length) {
    return;
  }

  await postgres.transaction(async manager => {
    for (const { evmAddress, id, keyType } of classifications) {
      totals.updated += await updateCurrentRevisions(
        manager,
        'accounts',
        'key_type = $2, evm_address = $3',
        'id = $1',
        [id, keyType, evmAddress]
      );
    }
  });
};

const classifyAccounts = async (
  postgres: DataSource,
  args: Args,
  totals: ClassifyTotals
): Promise<void> => {
  let afterId: string | null = null;

  for (;;) {
    const fetchSize = nextFetchSize(args, totals.scanned);

    if (fetchSize <= 0) {
      break;
    }

    const rows = await fetchCurrentBatch<AccountRow>(
      postgres,
      { table: 'accounts', where: UNCLASSIFIED_ACCOUNTS },
      afterId,
      fetchSize
    );

    const classifications: Classification[] = [];

    for (const row of rows) {
      afterId = row._id;

      const classification = classifyRow(row, args.ss58Format);

      if (classification) {
        classifications.push(classification);
      }
    }

    tallyClassifications(rows.length, classifications, totals);

    if (args.apply) {
      await applyClassifications(postgres, classifications, totals);
    } else {
      printDryRun(
        classifications,
        ({ evmAddress, id, keyType }) => `Would set ${id} -> ${keyType} / ${evmAddress}`
      );
    }

    if (rows.length < fetchSize) {
      break;
    }
  }
};

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
  if (!batch.length) {
    return;
  }

  // a failure rolls back its batch and stops the run; re-running resumes, since rows repaired by
  // earlier batches no longer match `address is null`
  await postgres.transaction(async manager => {
    for (const recovery of batch) {
      await applyRecovery(manager, recovery, totals);
    }
  });
};

const recoveryOutcome = (args: Args, totals: RecoveryTotals): string =>
  args.apply
    ? `Updated ${totals.extrinsicsUpdated} extrinsics, reclassified ` +
      `${totals.accountsUpdated} and inserted ${totals.accountsInserted} accounts ` +
      `(${totals.accountsSkippedNoBlock} skipped for missing block datetime).`
    : 'No writes (dry run).';

/** Pass 2: attribute unsigned `revive.eth_transact` extrinsics to their recovered signer */
const recoverSenders = async (postgres: DataSource, args: Args): Promise<void> => {
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
    const fetchSize = nextFetchSize(args, scanned);

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
      await applyRecoveries(postgres, recovered, totals);
    } else {
      printDryRun(recovered, ({ id, ss58 }) => `Would attribute ${id} -> ${ss58}`);
    }

    afterId = lastScannedId;
    exhausted = scannedCount < fetchSize;
  }

  console.log(
    `Senders: scanned ${scanned} rows, recovered ${scanned - failed}, ` +
      `failed ${failed}. ${recoveryOutcome(args, totals)}`
  );
};

const main = async (): Promise<void> => {
  const args = parseArgs();

  const postgres = await getPostgresDataSource();

  try {
    console.log('Classifying accounts indexed before key_type existed...');

    const classified: ClassifyTotals = {
      ethereum: 0,
      resolved: 0,
      scanned: 0,
      undecodable: 0,
      updated: 0,
    };

    await classifyAccounts(postgres, args, classified);

    const written = args.apply
      ? `updated ${classified.updated}`
      : `would update ${classified.resolved}`;
    const undecodable = classified.undecodable ? `, ${classified.undecodable} undecodable` : '';

    console.log(
      `Accounts: scanned ${classified.scanned}, ${written} ` +
        `(${classified.ethereum} Ethereum keys)${undecodable}`
    );

    if (classified.undecodable && classified.undecodable === classified.scanned) {
      logger.warn(
        `No account decoded under SS58 prefix ${args.ss58Format} - check --ss58-format before trusting this run`
      );
    }

    await recoverSenders(postgres, args);

    if (!args.apply) {
      console.log('Dry run, nothing written. Pass --apply to write.');
    }
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
