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

-- Legacy views, dropped if an older deployment left them behind.
DROP VIEW IF EXISTS data_block;
DROP VIEW IF EXISTS data_event;
DROP VIEW IF EXISTS data_extrinsic;
