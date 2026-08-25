-- Support for indexing Ethereum transactions submitted through `revive.ethTransact`.
--
-- The `evm_transactions` and `evm_account_mappings` tables, along with the `EvmCallKindEnum` type,
-- are created by the node from `schema.graphql`. Only the two pre-existing tables need altering.

alter table "extrinsics" add column if not exists "eth_address" text;
alter table "extrinsics" add column if not exists "eth_tx_hash" text;

create index if not exists data_extrinsic_eth_address on extrinsics (eth_address);
create index if not exists data_extrinsic_eth_tx_hash on extrinsics (eth_tx_hash);

-- `key_type` cannot be derived here: telling an Ethereum key from a substrate one means base58
-- decoding the address and checking for the `0xEE` padding, which postgres has no built in for.
-- Existing rows get a provisional 'substrate' so the column can be NOT NULL.
--
-- That default is wrong for any Ethereum key attributed before this change - registering a DID or
-- joining an identity emits the `0xEE` padded SS58 like any other key, and those accounts were
-- indexed all along. `scripts/backfill/eth-transact-senders.ts` decodes every account offline and
-- reclassifies them.
alter table "accounts" add column if not exists "key_type" text;
update "accounts" set "key_type" = 'substrate' where "key_type" is null;
alter table "accounts" alter column "key_type" set not null;

-- `evm_address` needs the same decode (plus keccak256 for substrate keys), so existing rows are
-- left null. Every account has one - Ethereum keys drop their `0xEE` padding, substrate keys are
-- hashed and truncated - and the same backfill fills them all, matching the forward path.
alter table "accounts" add column if not exists "evm_address" text;

create index if not exists data_account_evm_address on accounts (evm_address);
