alter table migrations add column if not exists executed boolean;
update migrations set executed = false where executed is null;
alter table migrations alter column executed set not null;

alter table migrations add column if not exists processed_block integer;
update migrations set processed_block = 0 where processed_block is null;
alter table migrations alter column processed_block set not null;

DO $$
BEGIN
    IF NOT EXISTS (select 1 from pg_type where typname = 'public_enum_5df0f1d22c') then
        create type public_enum_5df0f1d22c AS ENUM ('Free', 'Reserved', 'Bonded', 'Unbonded', 'Locked');
    END IF;
END
$$;

create table if not exists polyx_transactions
(
  id text not null PRIMARY KEY,
  identity_id text,
  "address" text,
  to_id text,
  to_address text,
  amount numeric not null,
  "type" public_enum_5df0f1d22c not null,
  module_id public_enum_7a0b4cc03e,
  call_id public_enum_0bf3c7d4ef,
  event_id public_enum_8f5a39c8ee,
  memo text,
  extrinsic_id text,
  event_idx numeric not null,
  "datetime" timestamp without time zone not null,
  created_block_id text not null,
  updated_block_id text not null,
  created_at timestamp with time zone not null,
  updated_at timestamp with time zone not null
);

alter table polyx_transactions
  drop constraint if exists "polyx_transactions_extrinsic_id_fkey",
  drop constraint if exists "polyx_transactions_created_block_id_fkey",
  drop constraint if exists "polyx_transactions_updated_block_id_fkey";

alter table polyx_transactions
  add constraint "polyx_transactions_extrinsic_id_fkey" foreign key (extrinsic_id) references extrinsics(id) ON UPDATE CASCADE ON DELETE SET NULL,
  add constraint "polyx_transactions_created_block_id_fkey" foreign key (created_block_id) references blocks(id) on update cascade,
  add constraint "polyx_transactions_updated_block_id_fkey" foreign key (updated_block_id) references blocks(id) on update cascade;

create index if not exists "polyx_transactions_pkey" on polyx_transactions using btree (id);
create index if not exists "polyx_transactions_created_block_id" on polyx_transactions using hash (created_block_id);
create index if not exists "polyx_transactions_extrinsic_id" on polyx_transactions using hash (extrinsic_id);
create index if not exists "polyx_transactions_updated_block_id" on polyx_transactions using hash (updated_block_id);
