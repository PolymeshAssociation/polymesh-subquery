import { ApiPromise, WsProvider } from '@polkadot/api';
import { Option } from '@polkadot/types-codec';
import { Codec } from '@polkadot/types-codec/types';
import { env } from 'process';
import { getAccountId, systematicIssuers } from '../src/mappings/consts';

type DidWithAccount = { did: string; accountId: string };
// Insert for genesis block id
const genesisBlock = `INSERT INTO "public"."blocks" ("id", "block_id", "parent_id", "hash", "parent_hash", "state_root", "extrinsics_root", "count_extrinsics", "count_extrinsics_unsigned", "count_extrinsics_signed", "count_extrinsics_error", "count_extrinsics_success", "count_events", "datetime", "spec_version_id", "created_at", "updated_at") VALUES
  ('0', 0, 0, '${env.NETWORK_CHAIN_ID}', '', '', '', 0, 0, 0, 0, 0, 0, now(), '3000', now(), now()) ON CONFLICT(id) DO NOTHING;`;

const getAccounts = ({ did, accountId }: DidWithAccount): string[] => {
  const permissionsInsert = `INSERT INTO "public"."permissions" ("id", "assets", "portfolios", "transactions", "transaction_groups", "created_block_id", "updated_block_id", "datetime", "created_at", "updated_at") VALUES
    ('${accountId}', null, null, null, '[]', '0', '0', now(), now(), now()) ON CONFLICT(id) DO NOTHING;`;
  const accountInsert = `INSERT INTO "public"."accounts"("id", "identity_id", "permissions_id", "event_id", "address", "created_block_id", "updated_block_id", "datetime", "created_at", "updated_at") VALUES 
    ('${accountId}', '${did}', '${accountId}', 'DidCreated', '${accountId}', '0', '0', now(), now(), now()) ON CONFLICT(id) DO NOTHING;`;

  return [permissionsInsert, accountInsert];
};

/**
 * Get `identities` and `portfolios` inserts for a specific DID
 */
const getInserts = ({ did, accountId }: DidWithAccount): string[] => {
  const insertQueries = [
    `INSERT INTO "public"."identities" ("id", "did", "primary_account", "secondary_keys_frozen", "event_id", "created_block_id", "updated_block_id", "datetime", "created_at", "updated_at") VALUES
('${did}', '${did}', '${accountId}', 'f', 'DidCreated', 0, 0, now(), now(), now()) ON CONFLICT(id) DO UPDATE SET
"primary_account" = excluded.primary_account;`,
    `INSERT INTO "public"."portfolios" ("id", "identity_id", "number", "name", "custodian_id", "event_idx", "created_block_id", "updated_block_id", "created_at", "updated_at") VALUES
('${did}/0', '${did}', 0, NULL, NULL, 1, '0', '0', now(), now()) ON CONFLICT(id) DO NOTHING;`,
  ];

  if (accountId) {
    insertQueries.push(...getAccounts({ did, accountId }));
  }

  return insertQueries;
};

/*
 * This function returns SQL statements to be inserted before processing of any blocks.
 *
 * For all the `Systematic Issuers` and GC identities, we need to insert a row in `identities` and its corresponding default portfolio entry in `portfolios` table.
 */
export const genesisMigrationQueries = async (): Promise<string[]> => {
  const wsProvider = new WsProvider(env.NETWORK_ENDPOINT);
  const api = await ApiPromise.create({ provider: wsProvider });
  // get the chain information to extract SS58Format
  const chainInfo = await api.registry.getChainProperties();

  const ss58Format = chainInfo?.ss58Format.unwrapOrDefault().toNumber();

  // There are special Identities specified in the chain's genesis block that need to be included in the DB.
  const gcDids = Array(33)
    .fill('')
    .map((_, index) => {
      const twoDigitNumber = index.toString(16).padStart(2, '0');
      return `0x${twoDigitNumber}`.padEnd(66, '0');
    });
  const rawGcAccountIds = await api.query.identity.didRecords.multi(gcDids);

  const gcIdentities = rawGcAccountIds.map((account, index) => {
    const rawAccount = account as Option<Codec>;
    return {
      did: gcDids[index],
      accountId: rawAccount.unwrapOrDefault().toJSON()?.['primaryKey'],
    };
  });

  const accountPromises = await Promise.all(
    gcIdentities
      .filter(({ accountId }) => accountId !== null)
      .map(({ did }) => api.query.identity.didKeys.entries(did))
  );

  const otherAccounts = accountPromises.reduce((result: string[], accountEntry) => {
    const accounts: string[] = accountEntry
      .map(
        ([
          {
            args: [rawDid, rawAccountId],
          },
        ]) =>
          getAccounts({
            did: rawDid.toString(),
            accountId: rawAccountId.toString(),
          })
      )
      .flat();
    return [...result, ...accounts];
  }, []);

  const systematicIssuerIdentities = Object.values(systematicIssuers).map(({ did, accountId }) => ({
    did,
    accountId: getAccountId(accountId, ss58Format),
  }));

  const identityAndPortfolioInserts = [...systematicIssuerIdentities, ...gcIdentities]
    .map(getInserts)
    .flat();

  await api.disconnect();

  return [genesisBlock, ...identityAndPortfolioInserts, ...otherAccounts];
};
