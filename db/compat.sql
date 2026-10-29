-- Everything in this file is something `schema.graphql` cannot express. Plain and composite
-- indexes are declared with `@index` / `@compositeIndexes` in the schema instead, so that the
-- index set has one source of truth. Each block below says why it has to live here.

-- `data_block_datetime_timestamp` was an expression index on `((datetime)::timestamp(0) without
-- time zone)`. Nothing could use it: PostGraphile compares the bare column, and Postgres uses an
-- expression index only when the query repeats the expression exactly. It is replaced with a plain
-- btree on `datetime`, which the block-range -> id-range time filter for "everything since <date>"
-- queries needs. `data_block_datetime` is an even older plain index an ancient deployment may have
-- left behind under a different name.
DROP INDEX IF EXISTS data_block_datetime;
DROP INDEX IF EXISTS data_block_datetime_timestamp;
CREATE INDEX IF NOT EXISTS data_block_datetime ON blocks (datetime);

-- Unique composite indexes. `@compositeIndexes` declares a composite index but has no `unique`
-- argument, so uniqueness across two columns can only be stated here.
CREATE UNIQUE INDEX IF NOT EXISTS data_extrinsic_id ON extrinsics (block_id, extrinsic_idx);
CREATE UNIQUE INDEX IF NOT EXISTS data_event_id ON events (block_id, event_idx);

-- Left behind by deployments from before the canonical argument encoding.
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
-- live on the `Claim` / corporate-action / STO entities.)

-- Plain indexes that would otherwise be `@index` in schema.graphql but cannot be: `@subql/node`
-- caps an entity at 10 indexes (`indexCountLimit`, not configurable), and a declared index would be a
-- GiST under historical mode, which these lookups do not need. These three back the
-- counterparty ("movements touching X"), era (reward/slash-per-era) and day-bucket queries.
CREATE INDEX IF NOT EXISTS data_polyx_entry_counterparty_address ON polyx_entries (counterparty_address);
CREATE INDEX IF NOT EXISTS data_polyx_entry_era_index ON polyx_entries (era_index);
CREATE INDEX IF NOT EXISTS data_polyx_entry_date ON polyx_entries (date);

-- Chronological ordering key for `multi_sig_proposals`. The relation column SubQuery
-- auto-creates is GiST `(created_event_id, _block_range)` under historical mode and cannot return
-- rows in order; `MultiSigProposal.id` is `multisigAddress/proposalId`, which cannot carry
-- chronological order either. `multiSigProposals` is a portal-consumed connection, so it gets a
-- plain btree here. This is the one entity that needs it — every other consumed connection either
-- has a `padId(block)/padId(eventIdx)` id (order by `ID_DESC`, no index) or a zero-padded numeric
-- id (`Instruction` / `Venue` / `Proposal` / `Authorization`).
CREATE INDEX IF NOT EXISTS data_multi_sig_proposal_created_event_id ON multi_sig_proposals (created_event_id);

-- `(id, _block_range)` for entities rewritten many times. Every save of a historical entity closes
-- its current row with `UPDATE ... WHERE id = $1 AND _block_range @> $2`, and the only index
-- SubQuery gives `id` is a plain btree: `addHistoricalIdIndex` runs after `_block_range` has been
-- appended to the declared indexes, so it never gets one. An account touched every block builds up
-- tens of thousands of row versions, and without this each close-out scans all of them.
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

-- The GiST indexes that no reader uses (every relation index of the five big tables, and the event
-- and extrinsic stamps of the small ones; lookups to other entities on small tables stay) are
-- dropped by `db/trimIndexes.ts`, one at a time after this script has run: dropping ~100 of them
-- here would hold an exclusive lock on each table until the whole transaction commits, while the
-- node is writing to it.

-- `events.refs`, for `refs: { contains: [...] }`. Historical mode would make a declared index GiST,
-- which can't index a jsonb array.
CREATE INDEX IF NOT EXISTS data_event_refs ON events USING gin (refs jsonb_path_ops);

-- Legacy views, dropped if an older deployment left them behind.
DROP VIEW IF EXISTS data_block;
DROP VIEW IF EXISTS data_event;
DROP VIEW IF EXISTS data_extrinsic;
