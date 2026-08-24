-- Support for indexing Ethereum transactions submitted through `revive.ethTransact`.
--
-- The `evm_transactions` and `evm_account_mappings` tables, along with the `EvmCallKindEnum` type,
-- are created by the node from `schema.graphql`. Only the two pre-existing tables need altering.

alter table "extrinsics" add column if not exists "eth_address" text;
alter table "extrinsics" add column if not exists "eth_tx_hash" text;

create index if not exists data_extrinsic_eth_address on extrinsics (eth_address);
create index if not exists data_extrinsic_eth_tx_hash on extrinsics (eth_tx_hash);

-- Every account indexed before this change was a substrate key. Ethereum keys were never
-- attributed, so there is nothing to reclassify.
alter table "accounts" add column if not exists "key_type" text;
update "accounts" set "key_type" = 'substrate' where "key_type" is null;
alter table "accounts" alter column "key_type" set not null;

-- `evm_address` needs keccak256 to derive for a substrate key, which postgres has no built in for.
-- Existing rows are left null and are populated as they are next updated.
alter table "accounts" add column if not exists "evm_address" text;

create index if not exists data_account_evm_address on accounts (evm_address);
