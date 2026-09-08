-- Everything in this file is something `schema.graphql` cannot express. Plain and composite
-- indexes are declared with `@index` / `@compositeIndexes` in the schema instead, so that the
-- index set has one source of truth. Each block below says why it has to live here.

-- Generated columns. SubQuery writes the JSON payloads as text; these expose them as JSONB for
-- the query layer. There is no directive for a generated column.
ALTER TABLE events
ADD COLUMN IF NOT EXISTS attributes JSONB GENERATED ALWAYS AS (attributes_txt::jsonb) STORED NULL;

ALTER TABLE extrinsics
ADD COLUMN IF NOT EXISTS params JSONB GENERATED ALWAYS AS (params_txt::jsonb) STORED NULL;

-- A plain `datetime` index an older deployment may have left behind. The expression index below
-- is what serves the queries that used it.
DROP INDEX IF EXISTS data_block_datetime;

-- Expression index. `@index` indexes a column; this one indexes the value cast to a
-- second-resolution timestamp, which is what the query layer compares against.
CREATE INDEX IF NOT EXISTS data_block_datetime_timestamp ON blocks (((datetime)::timestamp(0) without time zone));

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

-- Denormalised filter columns on `events`. These would be `@index` in schema.graphql, but
-- `@subql/node` caps an entity at 10 indexes (`indexCountLimit`, not configurable) and Event is
-- already at the cap. Kept here, as `master` had them.
CREATE INDEX IF NOT EXISTS data_event_claim_type ON events (claim_type);
CREATE INDEX IF NOT EXISTS data_event_claim_scope ON events (claim_scope);
CREATE INDEX IF NOT EXISTS data_event_claim_issuer ON events (claim_issuer);
CREATE INDEX IF NOT EXISTS data_event_corporate_action_ticker ON events (corporate_action_ticker);
CREATE INDEX IF NOT EXISTS data_event_fundraiser_offering_asset ON events (fundraiser_offering_asset);

-- Plain indexes that would otherwise be `@index` in schema.graphql but cannot be: `@subql/node`
-- caps an entity at 10 indexes (`indexCountLimit`, not configurable), and PolyxEntry is already
-- at the cap with its foreign keys and the three `@compositeIndexes`. These three back the
-- counterparty ("movements touching X"), era (reward/slash-per-era) and day-bucket queries.
CREATE INDEX IF NOT EXISTS data_polyx_entry_counterparty_address ON polyx_entries (counterparty_address);
CREATE INDEX IF NOT EXISTS data_polyx_entry_era_index ON polyx_entries (era_index);
CREATE INDEX IF NOT EXISTS data_polyx_entry_date ON polyx_entries (date);

-- Legacy views, dropped if an older deployment left them behind.
DROP VIEW IF EXISTS data_block;
DROP VIEW IF EXISTS data_event;
DROP VIEW IF EXISTS data_extrinsic;
