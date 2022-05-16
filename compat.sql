ALTER TABLE events
ADD COLUMN IF NOT EXISTS attributes JSONB GENERATED ALWAYS AS (attributes_txt::jsonb) STORED NULL;

ALTER TABLE extrinsics
ADD COLUMN IF NOT EXISTS params JSONB GENERATED ALWAYS AS (params_txt::jsonb) STORED NULL;

DROP INDEX IF EXISTS data_block_datetime;

CREATE UNIQUE INDEX IF NOT EXISTS data_block_id ON blocks (block_id);
CREATE UNIQUE INDEX IF NOT EXISTS data_block_hash ON blocks (hash);
CREATE INDEX IF NOT EXISTS data_block_datetime_timestamp ON blocks (((datetime)::timestamp(0) without time zone));
CREATE INDEX IF NOT EXISTS data_block_parent_hash ON blocks (parent_hash);
  
CREATE UNIQUE INDEX IF NOT EXISTS data_extrinsic_id ON extrinsics (block_id, extrinsic_idx);
CREATE INDEX IF NOT EXISTS data_extrinsic_block_id ON extrinsics (block_id);
CREATE INDEX IF NOT EXISTS data_extrinsic_extrinsic_idx ON extrinsics (extrinsic_idx);
CREATE INDEX IF NOT EXISTS data_extrinsic_call_id ON extrinsics (call_id);
CREATE INDEX IF NOT EXISTS data_extrinsic_address ON extrinsics (address);
CREATE INDEX IF NOT EXISTS data_extrinsic_module_id ON extrinsics (module_id);
CREATE INDEX IF NOT EXISTS data_extrinsic_signed ON extrinsics (signed);

CREATE UNIQUE INDEX IF NOT EXISTS data_event_id ON events (block_id, event_idx);
CREATE INDEX IF NOT EXISTS data_event_block_id ON events (block_id);
CREATE INDEX IF NOT EXISTS data_event_event_idx ON events (event_idx);
CREATE INDEX IF NOT EXISTS data_event_extrinsic_idx ON events (extrinsic_idx);
CREATE INDEX IF NOT EXISTS data_event_module_id ON events (module_id);
CREATE INDEX IF NOT EXISTS data_event_event_id ON events (event_id);
CREATE INDEX IF NOT EXISTS data_event_event_arg_0 ON events (left(event_arg_0, 100));
CREATE INDEX IF NOT EXISTS data_event_event_arg_1 ON events (left(event_arg_1, 100));
CREATE INDEX IF NOT EXISTS data_event_event_arg_2 ON events (left(event_arg_2, 100));
CREATE INDEX IF NOT EXISTS data_event_event_arg_3 ON events (left(event_arg_3, 100));
CREATE INDEX IF NOT EXISTS data_event_claim_type ON events (claim_type);
CREATE INDEX IF NOT EXISTS data_event_claim_scope ON events (claim_scope);
CREATE INDEX IF NOT EXISTS data_event_claim_issuer ON events (claim_issuer);
CREATE INDEX IF NOT EXISTS data_event_corporate_action_ticker ON events (corporate_action_ticker);
CREATE INDEX IF NOT EXISTS data_event_fundraiser_offering_asset ON events (fundraiser_offering_asset);
CREATE INDEX IF NOT EXISTS data_event_spec_version_id ON events (spec_version_id);
CREATE INDEX IF NOT EXISTS data_event_module_id_event_id ON events (module_id, event_id);
CREATE INDEX IF NOT EXISTS data_event_module_id_event_id_event_arg_2 ON events (module_id, event_id, left(event_arg_2, 100));
CREATE INDEX IF NOT EXISTS data_event_transfer_from ON events (trim( '"' from attributes #>> '{2,value,did}'));

DROP VIEW IF EXISTS data_block;
DROP VIEW IF EXISTS data_event;
DROP VIEW IF EXISTS data_extrinsic;

-- Queries to add identities for ALICE

-- Insert a default block
-- INSERT INTO "public"."blocks" ("id", "block_id", "parent_id", "hash", "parent_hash", "state_root", "extrinsics_root", "count_extrinsics", "count_extrinsics_unsigned", "count_extrinsics_signed", "count_extrinsics_error", "count_extrinsics_success", "count_events", "datetime", "spec_version_id", "created_at", "updated_at") VALUES
-- ('-1', -1, -1, '0x2', '0x6', '0xc', '0xb0', 1, 1, 0, 0, 1, 1, now(), '3000', now(), now()) ON CONFLICT(id) DO NOTHING;

-- Add entry for 0x0100
-- INSERT INTO "public"."identities" ("id", "did", "primary_account", "secondary_keys_frozen", "event_id", "created_block_id", "updated_block_id", "datetime", "created_at", "updated_at") VALUES
-- ('0x0100000000000000000000000000000000000000000000000000000000000000', '0x0100000000000000000000000000000000000000000000000000000000000000', 'primaryAccount', 'f', 'DidCreated', -1, -1, '2022-05-16 05:33:28.059957', '2022-05-16 05:33:28.059957+00', '2022-05-16 05:33:28.059957+00') ON CONFLICT(id) DO NOTHING;