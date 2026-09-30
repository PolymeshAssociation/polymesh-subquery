-- Replaces the tables of the `confidentialAsset` (v1) pallet with those of `confidentialAssets` (v2).
--
-- The v2 entities reuse three v1 table names - `confidential_accounts`, `confidential_assets` and
-- `confidential_legs` - with incompatible columns. The node only creates tables that are missing,
-- so on a database created before v2 support those tables keep their v1 shape and the first v2
-- event fails its insert, halting the indexer.
--
-- The v1 pallet was never deployed to a production chain and its tables are empty on every hosted
-- network, so they are dropped and the node recreates them from `schema.graphql`. Each table is
-- only dropped while it still carries a v1-only column: migrations also run on the first restart of
-- a freshly synced database, where these tables already hold v2 data.
--
-- The v2 history before the upgrade is not recovered by this migration. On a network where the v2
-- pallet was live before the upgrade (testnet), reindex from the block before its first event once,
-- before starting the node - see "Upgrading" in the README.

DO $$
DECLARE
    v1_table record;
BEGIN
    FOR v1_table IN
        select table_name from information_schema.columns
        where table_schema = current_schema()
        and (table_name, column_name) in (
            ('confidential_accounts', 'frozen_for_asset'),
            ('confidential_assets', 'venue_filtering'),
            ('confidential_legs', 'transaction_id'))
    LOOP
        execute format('drop table %I', v1_table.table_name);
    END LOOP;
END
$$;

-- v1 only entities, with no v2 counterpart
drop table if exists "confidential_venues";
drop table if exists "confidential_asset_holders";
drop table if exists "confidential_transaction_affirmations";
drop table if exists "confidential_transactions";
drop table if exists "confidential_asset_histories";
drop table if exists "confidential_asset_movements";

-- ConfidentialTransactionStatusEnum, only used by `confidential_transactions`
drop type if exists "18daa4b954";
