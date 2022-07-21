-- This file consists of queries to be run before processing of any block.
-- Generally would consist of 
--     * inserting entries for identities such as Alice, Bob etc. or any such entry that would be used as an attribute for any entity and is not created in any block
--     * Adding default block -1 in order to map any pre-populated entity

-- NOTE - This file would only be executed when NODE_ENV is set to local

--Insert a default block
INSERT INTO "public"."blocks" ("id", "block_id", "parent_id", "hash", "parent_hash", "state_root", "extrinsics_root", "count_extrinsics", "count_extrinsics_unsigned", "count_extrinsics_signed", "count_extrinsics_error", "count_extrinsics_success", "count_events", "datetime", "spec_version_id", "created_at", "updated_at") VALUES
('-1', -1, -1, '0x2', '0x6', '0xc', '0xb0', 1, 1, 0, 0, 1, 1, now(), '3000', now(), now()) ON CONFLICT(id) DO NOTHING;

-- --Add entry for 0x0000
INSERT INTO "public"."identities" ("id", "did", "primary_account", "secondary_keys_frozen", "event_id", "created_block_id", "updated_block_id", "datetime", "created_at", "updated_at") VALUES
('0x0000000000000000000000000000000000000000000000000000000000000000', '0x0000000000000000000000000000000000000000000000000000000000000000', 'primaryAccount', 'f', 'DidCreated', -1, -1, now(), now(), now()) ON CONFLICT(id) DO NOTHING;
INSERT INTO "public"."portfolios" ("id", "identity_id", "number", "name", "custodian_id", "event_idx", "created_block_id", "updated_block_id", "created_at", "updated_at") VALUES
('0x0000000000000000000000000000000000000000000000000000000000000000/0', '0x0000000000000000000000000000000000000000000000000000000000000000', 0, NULL, NULL, 1, '-1', '-1', now(), now()) ON CONFLICT(id) DO NOTHING;
--Add entry for 0x0100
INSERT INTO "public"."identities" ("id", "did", "primary_account", "secondary_keys_frozen", "event_id", "created_block_id", "updated_block_id", "datetime", "created_at", "updated_at") VALUES
('0x0100000000000000000000000000000000000000000000000000000000000000', '0x0100000000000000000000000000000000000000000000000000000000000000', 'primaryAccount', 'f', 'DidCreated', -1, -1, now(), now(), now()) ON CONFLICT(id) DO NOTHING;
INSERT INTO "public"."portfolios" ("id", "identity_id", "number", "name", "custodian_id", "event_idx", "created_block_id", "updated_block_id", "created_at", "updated_at") VALUES
('0x0100000000000000000000000000000000000000000000000000000000000000/0', '0x0100000000000000000000000000000000000000000000000000000000000000', 0, NULL, NULL, 1, '-1', '-1', now(), now()) ON CONFLICT(id) DO NOTHING;
--Add entry for 0x0400
INSERT INTO "public"."identities" ("id", "did", "primary_account", "secondary_keys_frozen", "event_id", "created_block_id", "updated_block_id", "datetime", "created_at", "updated_at") VALUES
('0x0400000000000000000000000000000000000000000000000000000000000000', '0x0400000000000000000000000000000000000000000000000000000000000000', 'primaryAccount', 'f', 'DidCreated', -1, -1, now(), now(), now()) ON CONFLICT(id) DO NOTHING;
INSERT INTO "public"."portfolios" ("id", "identity_id", "number", "name", "custodian_id", "event_idx", "created_block_id", "updated_block_id", "created_at", "updated_at") VALUES
('0x0400000000000000000000000000000000000000000000000000000000000000/0', '0x0400000000000000000000000000000000000000000000000000000000000000', 0, NULL, NULL, 1, '-1', '-1', now(), now()) ON CONFLICT(id) DO NOTHING;
--Add entry for 0x0500
INSERT INTO "public"."identities" ("id", "did", "primary_account", "secondary_keys_frozen", "event_id", "created_block_id", "updated_block_id", "datetime", "created_at", "updated_at") VALUES
('0x0500000000000000000000000000000000000000000000000000000000000000', '0x0500000000000000000000000000000000000000000000000000000000000000', 'primaryAccount', 'f', 'DidCreated', -1, -1, now(), now(), now()) ON CONFLICT(id) DO NOTHING;
INSERT INTO "public"."portfolios" ("id", "identity_id", "number", "name", "custodian_id", "event_idx", "created_block_id", "updated_block_id", "created_at", "updated_at") VALUES
('0x0500000000000000000000000000000000000000000000000000000000000000/0', '0x0500000000000000000000000000000000000000000000000000000000000000', 0, NULL, NULL, 1, '-1', '-1', now(), now()) ON CONFLICT(id) DO NOTHING;