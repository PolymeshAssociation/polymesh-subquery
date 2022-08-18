import { env } from 'process';

/*
 * This function returns SQL statements to be inserted before processing of any blocks.
 *
 * For all the `Systematic Issuers` and GC identities, we need to insert a row in `identities` and its corresponding default portfolio entry in `portfolios` table.
 */
export const migrationQueries = (): string[] => {
  const genesisBlock = `INSERT INTO "public"."blocks" ("id", "block_id", "parent_id", "hash", "parent_hash", "state_root", "extrinsics_root", "count_extrinsics", "count_extrinsics_unsigned", "count_extrinsics_signed", "count_extrinsics_error", "count_extrinsics_success", "count_events", "datetime", "spec_version_id", "created_at", "updated_at") VALUES
  ('0', 0, 0, '${env.NETWORK_CHAIN_ID}', '', '', '', 0, 0, 0, 0, 0, 0, now(), '3000', now(), now()) ON CONFLICT(id) DO NOTHING;`;

  // List of all the systematic issuers can be found [here](https://github.com/PolymeshAssociation/Polymesh/blob/d45fd1a161990310242f21230ac8a1a5d15498eb/pallets/common/src/constants.rs#L23)
  const systematicIssuers = [
    '0x73797374656d3a676f7665726e616e63655f636f6d6d69747465650000000000', // Governance Committee
    '0x73797374656d3a637573746f6d65725f6475655f64696c6967656e6365000000', // CDD Providers
    '0x73797374656d3a74726561737572795f6d6f64756c655f646964000000000000', // Treasury
    '0x73797374656d3a626c6f636b5f7265776172645f726573657276655f64696400', // Block Reward Reserve
    '0x73797374656d3a736574746c656d656e745f6d6f64756c655f64696400000000', // Settlement Module
    '0x73797374656d3a706f6c796d6174685f636c61737369635f6d69670000000000', // Classic Migration
    '0x73797374656d3a666961745f7469636b6572735f7265736572766174696f6e00', // FIAT Tickers Reservation
    '0x73797374656d3a726577617264735f6d6f64756c655f64696400000000000000', // Rewards
  ];

  // There are special Identities specified in the chain's genesis block that need to be included in the DB.
  const gcIdentities = Array(17)
    .fill('')
    .map((_, index) => {
      const twoDigitNumber = `${index}`.padStart(2, '0');
      return `0x${twoDigitNumber}`.padEnd(66, '0');
    });

  /**
   * Get `identities` and `portfolios` inserts for a specific DID
   */
  const getInserts = (did: string): string[] => [
    `INSERT INTO "public"."identities" ("id", "did", "primary_account", "secondary_keys_frozen", "event_id", "created_block_id", "updated_block_id", "datetime", "created_at", "updated_at") VALUES
('${did}', '${did}', 'primaryAccount', 'f', 'DidCreated', 0, 0, now(), now(), now()) ON CONFLICT(id) DO NOTHING;`,

    `INSERT INTO "public"."portfolios" ("id", "identity_id", "number", "name", "custodian_id", "event_idx", "created_block_id", "updated_block_id", "created_at", "updated_at") VALUES
('${did}/0', '${did}', 0, NULL, NULL, 1, '0', '0', now(), now()) ON CONFLICT(id) DO NOTHING;`,
  ];

  const identityAndPortfolioInserts = [...systematicIssuers, ...gcIdentities]
    .map(getInserts)
    .flat();

  return [genesisBlock, ...identityAndPortfolioInserts];
};
