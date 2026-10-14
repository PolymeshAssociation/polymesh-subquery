-- Everything in this file is something `schema.graphql` cannot express. Plain and composite
-- indexes are declared with `@index` / `@compositeIndexes` in the schema instead, so that the
-- index set has one source of truth. Each block below says why it has to live here.

-- `data_block_datetime_timestamp` was an expression index on `((datetime)::timestamp(0) without
-- time zone)`. Nothing could use it: PostGraphile compares the bare column, and Postgres uses an
-- expression index only when the query repeats the expression exactly (defect A18, verified
-- against a live indexer). It is replaced with a plain btree on `datetime` — which the
-- block-range -> id-range time filter that serves "everything since <date>" queries after D13
-- removed `createdBlock` actually needs. `data_block_datetime` is an even older plain index an
-- ancient deployment may have left behind under a different name.
DROP INDEX IF EXISTS data_block_datetime;
DROP INDEX IF EXISTS data_block_datetime_timestamp;
CREATE INDEX IF NOT EXISTS data_block_datetime ON blocks (datetime);

-- Unique composite indexes. `@compositeIndexes` declares a composite index but has no `unique`
-- argument, so uniqueness across two columns can only be stated here.
CREATE UNIQUE INDEX IF NOT EXISTS data_extrinsic_id ON extrinsics (block_id, extrinsic_idx);
CREATE UNIQUE INDEX IF NOT EXISTS data_event_id ON events (block_id, event_idx);

-- Left behind by deployments from before the canonical argument encoding (plan 09 §9.10).
DROP INDEX IF EXISTS data_event_event_arg_0;
DROP INDEX IF EXISTS data_event_event_arg_1;
DROP INDEX IF EXISTS data_event_event_arg_2;
DROP INDEX IF EXISTS data_event_event_arg_3;
DROP INDEX IF EXISTS data_event_module_id_event_id_event_arg_2;
DROP INDEX IF EXISTS data_event_transfer_from;
ALTER TABLE events DROP COLUMN IF EXISTS attributes;
ALTER TABLE extrinsics DROP COLUMN IF EXISTS params;

-- (The denormalised `claim_type` / `claim_scope` / `claim_issuer` / `corporate_action_ticker` /
-- `fundraiser_offering_asset` / `transfer_to` columns on `events` and their indexes were dropped —
-- a carry-over from an older indexer, empty or wrong on the vast majority of events, and the same facts
-- live on the `Claim` / corporate-action / STO entities. See docs/implementation/09-infrastructure.md.)

-- Plain indexes that would otherwise be `@index` in schema.graphql but cannot be: `@subql/node`
-- caps an entity at 10 indexes (`indexCountLimit`, not configurable), and a declared index would be a
-- GiST under historical mode, which these lookups do not need. These three back the
-- counterparty ("movements touching X"), era (reward/slash-per-era) and day-bucket queries.
CREATE INDEX IF NOT EXISTS data_polyx_entry_counterparty_address ON polyx_entries (counterparty_address);
CREATE INDEX IF NOT EXISTS data_polyx_entry_era_index ON polyx_entries (era_index);
CREATE INDEX IF NOT EXISTS data_polyx_entry_date ON polyx_entries (date);

-- Chronological ordering key for `multi_sig_proposals` (D13 / §14b). The relation column SubQuery
-- auto-creates is GiST `(created_event_id, _block_range)` under historical mode and cannot return
-- rows in order; `MultiSigProposal.id` is `multisigAddress/proposalId`, which cannot carry
-- chronological order either. `multiSigProposals` is a portal-consumed connection, so it gets a
-- plain btree here. This is the one entity that needs it — every other consumed connection either
-- has a `padId(block)/padId(eventIdx)` id (order by `ID_DESC`, no index) or was zero-padded in
-- 7.2 (`Instruction` / `Venue` / `Proposal` / `Authorization`).
CREATE INDEX IF NOT EXISTS data_multi_sig_proposal_created_event_id ON multi_sig_proposals (created_event_id);

-- `(id, _block_range)` for entities rewritten many times. Every save of a historical entity closes
-- its current row with `UPDATE ... WHERE id = $1 AND _block_range @> $2`, and the only index
-- SubQuery gives `id` is a plain btree: `addHistoricalIdIndex` runs after `_block_range` has been
-- appended to the declared indexes, so it never gets one. An account touched every block builds up
-- tens of thousands of row versions, and each close-out scanned all of them. On a testnet genesis
-- resync, `account_balances` and `staking_positions` held ~27,000 versions for busy ids, the
-- update took 3-12 s per batch with Postgres at 100% CPU, and this index took a lookup from
-- 157 ms to 0.8 ms and the sync from ~180 to ~1,280 heights/s.
--
-- Created only when the table has no such index already, under any name. On an existing database
-- this builds while holding writes back, so the node pauses until it is done; build it by hand
-- with `CREATE INDEX CONCURRENTLY` first to avoid that.
DO $$
DECLARE
  tbl TEXT;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['account_balances', 'staking_positions'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_indexes
      WHERE schemaname = current_schema() AND tablename = tbl
        AND indexdef LIKE '%USING gist (id, _block_range)%'
    ) THEN
      EXECUTE format('CREATE INDEX %I ON %I USING gist (id, _block_range)', tbl || '_id_block_range', tbl);
    END IF;
  END LOOP;
END $$;

-- Historical mode (`historical: 'height'`) turns every declared `@index` and every relation into a
-- composite GiST `(field, _block_range)`, and GiST is by far the most expensive index type to build
-- and to keep up on insert. About half of those serve no reader: not the indexer (it looks rows up
-- by `id`, through `(id, _block_range)` above, and through the handful of `getByFields` /
-- `getAllByFields` filters, whose fields keep their index), and not the queries the SDK and portal
-- run. Dropping them frees about 4.9 GB on testnet and about 12 GB on mainnet at full size, and
-- spares every insert the maintenance. Historical mode itself must stay on: unfinalized blocks and
-- reorg rewind need it. Rewind and the per-save close-out filter on `lower(_block_range)` and `id`,
-- never on these.
--
-- Two kinds of entry, told apart by the third column:
--   false  the index is no longer declared in schema.graphql, so SubQuery does not recreate it; it
--          is only there to clean up a database built before it was removed from the schema.
--   true   the index belongs to a relation, which SubQuery always indexes, so it is still declared.
--          The node runs `CREATE INDEX IF NOT EXISTS` for every declared index on EVERY start (it
--          treats each start as a fresh schema migration), so a plain drop is undone, and an
--          eleven-gigabyte rebuild is paid, at the next restart. It is replaced instead by an
--          empty stand-in under the same name (`WHERE false` indexes nothing and can never be
--          chosen by a query); the node then finds the name taken and skips it.
--
-- Entries match on the table and column list, not on a generated name, and only while the index
-- is still a GiST, so this is idempotent and safe on a database that never had them. Only indexes
-- of at least 1 MB on either chain are listed: the rest cost nothing worth a stand-in. To bring one
-- back, remove its row here and declare it in schema.graphql (or `DROP INDEX` the stand-in on an
-- existing database and restart, so the node recreates the real one).
DO $$
DECLARE
  spec RECORD;
  ix RECORD;
BEGIN
  FOR spec IN
    SELECT * FROM (VALUES
      ('account_balances', 'account_id', true),
      ('account_balances', 'identity_id', true),
      ('account_balances', 'updated_event_id', true),
      ('accounts', 'created_event_id', true),
      ('accounts', 'identity_id', true),
      ('accounts', 'updated_event_id', true),
      ('asset_agent_actions', 'caller_id', true),
      ('asset_agent_actions', 'created_event_id', true),
      ('asset_agent_actions', 'pallet_name', false),
      ('asset_agent_actions', 'updated_event_id', true),
      ('asset_holders', 'asset_id', true),
      ('asset_transactions', 'created_event_id', true),
      ('asset_transactions', 'instruction_id', true),
      ('assets', 'name', false),
      ('assets', 'owner_id', true),
      ('assets', 'ticker', false),
      ('assets', 'type', false),
      ('assets', 'updated_event_id', true),
      ('authorizations', 'from_id', true),
      ('authorizations', 'to_key', false),
      ('blocks', 'parent_hash', false),
      ('claims', 'created_event_id', true),
      ('claims', 'filter_expiry', false),
      ('claims', 'issuer_id', true),
      ('claims', 'updated_event_id', true),
      ('eras', 'end_event_id', true),
      ('eras', 'start_event_id', true),
      ('events', 'block_id', true),
      ('events', 'event_id', false),
      ('events', 'event_idx', false),
      ('events', 'extrinsic_id', true),
      ('events', 'extrinsic_idx', false),
      ('events', 'spec_version_id', false),
      ('extrinsics', 'extrinsic_idx', false),
      ('extrinsics', 'module_id', false),
      ('extrinsics', 'signed', false),
      ('extrinsics', 'success', false),
      ('holdings', 'account_id', true),
      ('holdings', 'asset_id', true),
      ('holdings', 'identity_id', true),
      ('holdings', 'portfolio_id', true),
      ('identities', 'primary_account', false),
      ('identity_keys', 'created_event_id', true),
      ('identity_keys', 'identity_id', true),
      ('identity_keys', 'identity_id, role', false),
      ('identity_keys', 'updated_event_id', true),
      ('identity_keys', 'valid_from_block_id', true),
      ('instruction_affirmations', 'created_event_id', true),
      ('instruction_affirmations', 'identity', false),
      ('instruction_affirmations', 'off_chain_receipt_id', true),
      ('instruction_affirmations', 'party_id', true),
      ('instruction_affirmations', 'updated_event_id', true),
      ('instruction_events', 'created_event_id', true),
      ('instruction_events', 'event', false),
      ('instruction_events', 'identity', false),
      ('instruction_events', 'off_chain_receipt_id', true),
      ('instruction_parties', 'created_event_id', true),
      ('instruction_parties', 'instruction_id', true),
      ('instruction_parties', 'updated_event_id', true),
      ('instructions', 'created_event_id', true),
      ('instructions', 'updated_event_id', true),
      ('legs', 'created_event_id', true),
      ('legs', 'ticker', false),
      ('legs', 'updated_event_id', true),
      ('multi_sig_proposal_votes', 'created_event_id', true),
      ('multi_sig_proposal_votes', 'signer_id', true),
      ('multi_sig_proposal_votes', 'updated_event_id', true),
      ('multi_sig_proposals', 'created_event_id', true),
      ('multi_sig_proposals', 'creator_id', true),
      ('multi_sig_proposals', 'extrinsic_id', true),
      ('multi_sig_proposals', 'updated_event_id', true),
      ('nfts', 'account_id', true),
      ('nfts', 'asset_id', true),
      ('nfts', 'burned_event_id', true),
      ('nfts', 'created_event_id', true),
      ('nfts', 'identity_id', true),
      ('nfts', 'portfolio_id', true),
      ('nfts', 'updated_event_id', true),
      ('nominations', 'era_index, position_id', false),
      ('nominations', 'valid_from_event_id', true),
      ('nominations', 'validator_id', true),
      ('polyx_entries', 'account_id, date', false),
      ('polyx_entries', 'account_id, kind', false),
      ('polyx_entries', 'block_id', false),
      ('polyx_entries', 'counterparty_identity_id', true),
      ('polyx_entries', 'created_event_id', true),
      ('polyx_entries', 'date, kind', false),
      ('polyx_entries', 'extrinsic_id', true),
      ('polyx_entries', 'movement_id', false),
      ('portfolios', 'created_event_id', true),
      ('portfolios', 'updated_event_id', true),
      ('staking_events', 'created_event_id', true),
      ('staking_events', 'era_index', false),
      ('staking_events', 'position_id', true),
      ('staking_events', 'validator_id', true),
      ('staking_positions', 'controller_id', true),
      ('staking_positions', 'created_event_id', true),
      ('staking_positions', 'identity_id', true),
      ('staking_positions', 'reward_destination_account_id', true),
      ('staking_positions', 'stash_id', true),
      ('staking_positions', 'updated_event_id', true),
      ('ticker_reservations', 'identity_id', true),
      ('validator_eras', 'created_event_id', true),
      ('validator_eras', 'era_id', true),
      ('validator_eras', 'identity_id', true),
      ('validator_eras', 'updated_event_id', true),
      ('validator_eras', 'validator_id', true),
      ('validators', 'account_id', true)
    ) AS t(tbl, cols, standin)
  LOOP
    FOR ix IN
      SELECT indexname FROM pg_indexes
      WHERE schemaname = current_schema() AND tablename = spec.tbl
        AND regexp_replace(indexdef, '^.* USING ', '') = format('gist (%s, _block_range)', spec.cols)
    LOOP
      EXECUTE format('DROP INDEX %I.%I', current_schema(), ix.indexname);
      IF spec.standin THEN
        EXECUTE format('CREATE INDEX %I ON %I.%I USING btree (id) WHERE false', ix.indexname, current_schema(), spec.tbl);
      END IF;
    END LOOP;
  END LOOP;
END $$;

-- `events.refs`, for `refs: { contains: [...] }`. Historical mode would make a declared index GiST,
-- which can't index a jsonb array.
CREATE INDEX IF NOT EXISTS data_event_refs ON events USING gin (refs jsonb_path_ops);

-- Legacy views, dropped if an older deployment left them behind.
DROP VIEW IF EXISTS data_block;
DROP VIEW IF EXISTS data_event;
DROP VIEW IF EXISTS data_extrinsic;
