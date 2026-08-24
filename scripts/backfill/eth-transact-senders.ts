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
 * - upserts an `accounts` row for that address (`key_type = 'ethereum'`), so joins against
 *   `extrinsics.address` behave. Existing rows are reclassified rather than duplicated
 *
 * The stored `module_id`/`call_id`/`params_txt`/`success` values are deliberately left untouched:
 * they stay consistent with the historical event rows built from them.
 *
 * Usage (from the repo root):
 *   yarn ts-node scripts/backfill/eth-transact-senders.ts [--apply]
 *        [--db-host=h] [--db-port=p] [--db-user=u] [--db-pass=p] [--db-name=d]
 *        [--batch-size=N] [--ss58-format=N] [--limit=N]
 *
 * Defaults to a dry run, which prints would-be updates and a summary without writing anything.
 * Connection details fall back to the DB_* environment variables used by `db/utils.ts`.
 */
/**
 * Ambient declaration for the SubQuery injected `logger` global that this script's imports rely
 * on.
 *
 * `tsconfig.json` only maps SubQuery's globals onto `src/**`, so code running through ts-node
 * declares what it uses itself. At runtime the value only exists inside the SubQuery node; the
 * shim below provides it before any module that touches it is called
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
import { DataSource } from 'typeorm';

// `src/utils/ethTransaction.ts` reports failures through the sandbox injected global `logger`
(globalThis as any).logger = console;

import { getPostgresDataSource } from '../../db/utils';
import { ss58FromEthAddress } from '../../src/utils/eth';
import { decodeEthTransaction, ethTxHash, recoverEthSender } from '../../src/utils/ethTransaction';

interface Args {
  apply: boolean;
  batchSize: number;
  dbHost?: string;
  dbName?: string;
  dbPass?: string;
  dbPort?: number;
  dbUser?: string;
  limit?: number;
  ss58Format: number;
}

const parseArgs = (): Args => {
  const args: Args = { apply: false, batchSize: 500, ss58Format: 12 };

  for (const arg of process.argv.slice(2)) {
    const [key, value] = arg.replace(/^--/, '').split('=');

    switch (key) {
      case 'apply':
        args.apply = true;
        break;
      case 'batch-size':
        args.batchSize = Number(value);
        break;
      case 'db-host':
        args.dbHost = value;
        break;
      case 'db-name':
        args.dbName = value;
        break;
      case 'db-pass':
        args.dbPass = value;
        break;
      case 'db-port':
        args.dbPort = Number(value);
        break;
      case 'db-user':
        args.dbUser = value;
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

const recoverBatch = async (
  postgres: DataSource,
  args: Args,
  lastId: string
): Promise<{
  failed: number;
  lastScannedId: string;
  recovered: Recovered[];
  scannedCount: number;
}> => {
  const rows: { id: string; params_txt: string | null }[] = await postgres.query(
    `select id, params_txt
       from extrinsics
      where module_id = 'revive'
        and call_id = 'eth_transact'
        and address is null
        and id > $1
      order by id
      limit $2`,
    [lastId, args.batchSize]
  );

  const recovered: Recovered[] = [];
  let failed = 0;
  let lastScannedId = lastId;

  for (const { id, params_txt } of rows) {
    lastScannedId = id;

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
      ethTxHash: ethTxHash(hexToU8a(payload)),
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
 * Repairs one extrinsic row and its account row.
 *
 * The account upsert reclassifies an existing row, or inserts one when the key was never attached
 * to an Identity and was therefore never indexed. An inserted row carries no identity or
 * permissions links, mirroring how the forward path leaves unattached keys alone
 */
const applyRecovery = async (
  postgres: DataSource,
  { ethAddress, ethTxHash, id, ss58 }: Recovered
): Promise<number> =>
  postgres.transaction(async manager => {
    await manager.query(
      `update extrinsics
          set address = $1, eth_address = $2, eth_tx_hash = $3
        where id = $4`,
      [ss58, ethAddress, ethTxHash, id]
    );

    const enrichment = await manager.query(
      `update accounts
          set key_type = 'ethereum', evm_address = $2
        where id = $1
          and (key_type is distinct from 'ethereum' or evm_address is distinct from $2)`,
      [ss58, ethAddress]
    );

    if (enrichment[1] > 0) {
      return 1;
    }

    // `event_id` is the hashed Postgres enum; `'AccountCreated'` is an existing label of it
    const insertion = await manager.query(
      `insert into accounts
             (id, address, key_type, evm_address, event_id, datetime, created_block_id,
              updated_block_id)
      select $1, $1, 'ethereum', $2, 'AccountCreated', b.datetime, e.block_id, e.block_id
        from extrinsics e
        join blocks b on b.id = e.block_id
       where e.id = $1
         and b.datetime is not null
      on conflict (id) do nothing`,
      [ss58, ethAddress]
    );

    return insertion[1];
  });

const main = async (): Promise<void> => {
  const args = parseArgs();

  const postgres =
    args.dbHost || args.dbName || args.dbPass || args.dbPort || args.dbUser
      ? await new DataSource({
          type: 'postgres',
          host: args.dbHost ?? process.env.DB_HOST,
          port: args.dbPort ?? Number(process.env.DB_PORT ?? 5432),
          username: args.dbUser ?? process.env.DB_USER,
          password: args.dbPass ?? process.env.DB_PASS,
          database: args.dbName ?? process.env.DB_DATABASE,
          name: 'postgres-backfill',
        }).initialize()
      : await getPostgresDataSource();

  try {
    const [{ count }] = await postgres.query(
      `select count(*)::int as count
         from extrinsics
        where module_id = 'revive'
          and call_id = 'eth_transact'
          and address is null`
    );
    console.log(`Found ${count} revive.eth_transact extrinsics without an address`);

    if (Number(count) === 0) {
      return;
    }

    let scanned = 0;
    let failed = 0;
    let updated = 0;
    let accountsUpserted = 0;
    let lastId = '';
    let exhausted = false;

    while (!exhausted && !(args.limit && scanned >= args.limit)) {
      const {
        failed: batchFailed,
        lastScannedId,
        recovered,
        scannedCount,
      } = await recoverBatch(postgres, args, lastId);

      scanned += scannedCount;
      failed += batchFailed;

      if (args.apply) {
        for (const row of recovered) {
          updated += 1;
          accountsUpserted += await applyRecovery(postgres, row);
        }
      } else if (recovered.length) {
        console.log('Would update:');
        recovered.forEach(({ id, ss58 }) => console.log(`  ${id} -> ${ss58}`));
      }

      lastId = lastScannedId;
      exhausted = scannedCount < args.batchSize;
    }

    console.log(
      `Done. Scanned ${scanned} rows, recovered ${scanned - failed}, failed ${failed}. ` +
        (args.apply
          ? `Updated ${updated} extrinsics and ${accountsUpserted} accounts.`
          : 'Dry run, nothing written. Pass --apply to write.')
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
