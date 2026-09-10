-- Everything in this file is something `schema.graphql` cannot express. Plain and composite
-- indexes are declared with `@index` / `@compositeIndexes` in the schema instead, so that the
-- index set has one source of truth. Each block below says why it has to live here.

-- Generated columns. SubQuery writes the JSON payloads as text; these expose them as JSONB for
-- the query layer. There is no directive for a generated column.
ALTER TABLE events
ADD COLUMN IF NOT EXISTS attributes JSONB GENERATED ALWAYS AS (attributes_txt::jsonb) STORED NULL;

ALTER TABLE extrinsics
ADD COLUMN IF NOT EXISTS params JSONB GENERATED ALWAYS AS (params_txt::jsonb) STORED NULL;

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

-- Expression indexes over the event argument columns. Each is indexed on its first 100
-- characters to keep the entry inside Postgres' btree row limit, which no directive can say.
CREATE INDEX IF NOT EXISTS data_event_event_arg_0 ON events (left(event_arg_0, 100));
CREATE INDEX IF NOT EXISTS data_event_event_arg_1 ON events (left(event_arg_1, 100));
CREATE INDEX IF NOT EXISTS data_event_event_arg_2 ON events (left(event_arg_2, 100));
CREATE INDEX IF NOT EXISTS data_event_event_arg_3 ON events (left(event_arg_3, 100));
CREATE INDEX IF NOT EXISTS data_event_module_id_event_id_event_arg_2 ON events (module_id, event_id, left(event_arg_2, 100));

-- JSONB path index, over the generated column above. Neither the path expression nor the column
-- it reads exists in `schema.graphql`.
CREATE INDEX IF NOT EXISTS data_event_transfer_from ON events (trim( '"' from attributes #>> '{2,value,did}'));

-- (The denormalised `claim_type` / `claim_scope` / `claim_issuer` / `corporate_action_ticker` /
-- `fundraiser_offering_asset` / `transfer_to` columns on `events` and their indexes were dropped —
-- a harvester-era carry-over, empty or wrong on the vast majority of events, and the same facts
-- live on the `Claim` / corporate-action / STO entities. See docs/implementation/09-infrastructure.md.)

-- Plain indexes that would otherwise be `@index` in schema.graphql but cannot be: `@subql/node`
-- caps an entity at 10 indexes (`indexCountLimit`, not configurable), and PolyxEntry is already
-- at the cap with its foreign keys and the three `@compositeIndexes`. These three back the
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

-- Legacy views, dropped if an older deployment left them behind.
DROP VIEW IF EXISTS data_block;
DROP VIEW IF EXISTS data_event;
DROP VIEW IF EXISTS data_extrinsic;
