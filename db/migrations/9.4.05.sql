-- Create StoStatus enum
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

INSERT INTO "public"."polyx_transactions" ("id", "identity_id", "address", "to_id", "to_address", "amount", "memo", "type", "module_id", "call_id", "event_id", "extrinsic_id", "datetime", "created_block_id", "updated_block_id", "created_at", "updated_at")
select 
  e.block_id || '/' || e.event_idx as id,
  e."attributes"->0->>'value' as identity_id,
  e."attributes"->1->>'value' as "address",
  e."attributes"->2->>'value' as to_id,
  e."attributes"->3->>'value' as "to_address",
  (e."attributes"->4->>'value')::NUMERIC as amount,
  e."attributes"->5->>'value' as memo,
  'Free' as "type",
  e.module_id,
  tx.call_id,
  e.event_id,
  tx.id as extrinsic_id,
  b.datetime,
  e.block_id as created_block_id,
  e.block_id as updated_block_id,
  b.created_at,
  b.updated_at
from 
  events e
  inner join blocks b
    on b.block_id = e.block_id::int
  left join extrinsics tx
    on tx.block_id = e.block_id
    and e.extrinsic_idx = tx.extrinsic_idx
where 
  e.module_id = 'balances'
  and e.event_id = 'Transfer'
on conflict(id) do nothing;

--- balances.Endowed
INSERT INTO "public"."polyx_transactions" ("id", "identity_id", "address", "to_id", "to_address", "amount", "memo", "type", "module_id", "call_id", "event_id", "extrinsic_id", "datetime", "created_block_id", "updated_block_id", "created_at", "updated_at") 
select 
  e.block_id || '/' || e.event_idx as id,
  e."attributes"->0->>'value' as identity_id,
  e."attributes"->1->>'value' as "address",
  null as to_id,
  null as "to_address",
  (e."attributes"->2->>'value')::NUMERIC as amount,
  null as memo,
  'Free' as "type",
  e.module_id,
  tx.call_id,
  e.event_id,
  tx.id as extrinsic_id,
  b.datetime,
  e.block_id as created_block_id,
  e.block_id as updated_block_id,
  b.created_at,
  b.updated_at
from 
  events e
  inner join blocks b
    on b.block_id = e.block_id::int
  left join extrinsics tx
    on tx.block_id = e.block_id
    and e.extrinsic_idx = tx.extrinsic_idx
where 
  e.module_id = 'balances'
  and e.event_id = 'Endowed'
on conflict(id) do nothing;

--- balances.Reserved
INSERT INTO "public"."polyx_transactions" ("id", "identity_id", "address", "to_id", "to_address", "amount", "memo", "type", "module_id", "call_id", "event_id", "extrinsic_id", "datetime", "created_block_id", "updated_block_id", "created_at", "updated_at") 
select 
  e.block_id || '/' || e.event_idx as id,
  (select identity_id from accounts where address = e."attributes"->0->>'value') as identity_id,
  e."attributes"->0->>'value' as "address",
  (select identity_id from accounts where address = e."attributes"->0->>'value') as to_id,
  e."attributes"->0->>'value' as "to_address",
  (e."attributes"->1->>'value')::NUMERIC as amount,
  null as memo,
  'Reserved' as "type",
  e.module_id,
  tx.call_id,
  e.event_id,
  tx.id as extrinsic_id,
  b.datetime,
  e.block_id as created_block_id,
  e.block_id as updated_block_id,
  b.created_at,
  b.updated_at
from 
  events e
  inner join blocks b
    on b.block_id = e.block_id::int
  left join extrinsics tx
    on tx.block_id = e.block_id
    and e.extrinsic_idx = tx.extrinsic_idx
where 
  e.module_id = 'balances'
  and e.event_id = 'Reserved'
on conflict(id) do nothing;

--- balances.Unreserved
INSERT INTO "public"."polyx_transactions" ("id", "identity_id", "address", "to_id", "to_address", "amount", "memo", "type", "module_id", "call_id", "event_id", "extrinsic_id", "datetime", "created_block_id", "updated_block_id", "created_at", "updated_at") 
select 
  e.block_id || '/' || e.event_idx as id,
  (select identity_id from accounts where address = e."attributes"->0->>'value') as identity_id,
  e."attributes"->0->>'value' as "address",
  (select identity_id from accounts where address = e."attributes"->0->>'value') as to_id,
  e."attributes"->0->>'value' as "to_address",
  (e."attributes"->1->>'value')::NUMERIC as amount,
  null as memo,
  'Free' as "type",
  e.module_id,
  tx.call_id,
  e.event_id,
  tx.id as extrinsic_id,
  b.datetime,
  e.block_id as created_block_id,
  e.block_id as updated_block_id,
  b.created_at,
  b.updated_at
from 
  events e
  inner join blocks b
    on b.block_id = e.block_id::int
  left join extrinsics tx
    on tx.block_id = e.block_id
    and e.extrinsic_idx = tx.extrinsic_idx
where 
  e.module_id = 'balances'
  and e.event_id = 'Unreserved'
on conflict(id) do nothing;

--- balances.AccountBalanceBurned
INSERT INTO "public"."polyx_transactions" ("id", "identity_id", "address", "to_id", "to_address", "amount", "memo", "type", "module_id", "call_id", "event_id", "extrinsic_id", "datetime", "created_block_id", "updated_block_id", "created_at", "updated_at") 
select 
  e.block_id || '/' || e.event_idx as id,
  (select identity_id from accounts where address = e."attributes"->0->>'value') as identity_id,
  e."attributes"->1->>'value' as "address",
  null as to_id,
  null as "to_address",
  (e."attributes"->2->>'value')::NUMERIC as amount,
  null as memo,
  'Free' as "type",
  e.module_id,
  tx.call_id,
  e.event_id,
  tx.id as extrinsic_id,
  b.datetime,
  e.block_id as created_block_id,
  e.block_id as updated_block_id,
  b.created_at,
  b.updated_at
from 
  events e
  inner join blocks b
    on b.block_id = e.block_id::int
  left join extrinsics tx
    on tx.block_id = e.block_id
    and e.extrinsic_idx = tx.extrinsic_idx
where 
  e.module_id = 'balances'
  and e.event_id = 'AccountBalanceBurned'
on conflict(id) do nothing;

--- staking.Bonded
INSERT INTO "public"."polyx_transactions" ("id", "identity_id", "address", "to_id", "to_address", "amount", "memo", "type", "module_id", "call_id", "event_id", "extrinsic_id", "datetime", "created_block_id", "updated_block_id", "created_at", "updated_at") 
select 
  e.block_id || '/' || e.event_idx as id,
  e."attributes"->0->>'value' as identity_id,
  e."attributes"->1->>'value' as "address",
  null as to_id,
  null as "to_address",
  (e."attributes"->2->>'value')::NUMERIC as amount,
  null as memo,
  'Bonded' as "type",
  e.module_id,
  tx.call_id,
  e.event_id,
  tx.id as extrinsic_id,
  b.datetime,
  e.block_id as created_block_id,
  e.block_id as updated_block_id,
  b.created_at,
  b.updated_at
from 
  events e
  inner join blocks b
    on b.block_id = e.block_id::int
  left join extrinsics tx
    on tx.block_id = e.block_id
    and e.extrinsic_idx = tx.extrinsic_idx
where 
  e.module_id = 'staking'
  and e.event_id = 'Bonded'
on conflict(id) do nothing;

--- staking.Unbonded
INSERT INTO "public"."polyx_transactions" ("id", "identity_id", "address", "to_id", "to_address", "amount", "memo", "type", "module_id", "call_id", "event_id", "extrinsic_id", "datetime", "created_block_id", "updated_block_id", "created_at", "updated_at") 
select 
  e.block_id || '/' || e.event_idx as id,
  null as identity_id,
  null as "address",
  e."attributes"->0->>'value' as to_id,
  e."attributes"->1->>'value' as "to_address",
  (e."attributes"->2->>'value')::NUMERIC as amount,
  null as memo,
  'Unbonded' as "type",
  e.module_id,
  tx.call_id,
  e.event_id,
  tx.id as extrinsic_id,
  b.datetime,
  e.block_id as created_block_id,
  e.block_id as updated_block_id,
  b.created_at,
  b.updated_at
from 
  events e
  inner join blocks b
    on b.block_id = e.block_id::int
  left join extrinsics tx
    on tx.block_id = e.block_id
    and e.extrinsic_idx = tx.extrinsic_idx
where 
  e.module_id = 'staking'
  and e.event_id = 'Unbonded'
on conflict(id) do nothing;

--- staking.Withdrawn
INSERT INTO "public"."polyx_transactions" ("id", "identity_id", "address", "to_id", "to_address", "amount", "memo", "type", "module_id", "call_id", "event_id", "extrinsic_id", "datetime", "created_block_id", "updated_block_id", "created_at", "updated_at") 
select 
  e.block_id || '/' || e.event_idx as id,
  (select identity_id from accounts where address = e."attributes"->0->>'value') as identity_id,
  e."attributes"->0->>'value' as "address",
  (select identity_id from accounts where address = e."attributes"->0->>'value') as to_id,
  e."attributes"->0->>'value' as "to_address",
  (e."attributes"->1->>'value')::NUMERIC as amount,
  null as memo,
  'Free' as "type",
  e.module_id,
  tx.call_id,
  e.event_id,
  tx.id as extrinsic_id,
  b.datetime,
  e.block_id as created_block_id,
  e.block_id as updated_block_id,
  b.created_at,
  b.updated_at
from 
  events e
  inner join blocks b
    on b.block_id = e.block_id::int
  left join extrinsics tx
    on tx.block_id = e.block_id
    and e.extrinsic_idx = tx.extrinsic_idx
where 
  e.module_id = 'staking'
  and e.event_id = 'Withdrawn'
on conflict(id) do nothing;

--- staking.Reward
INSERT INTO "public"."polyx_transactions" ("id", "identity_id", "address", "to_id", "to_address", "amount", "memo", "type", "module_id", "call_id", "event_id", "extrinsic_id", "datetime", "created_block_id", "updated_block_id", "created_at", "updated_at") 
select 
  e.block_id || '/' || e.event_idx as id,
  null as identity_id,
  null as "address",
  e."attributes"->0->>'value' as to_id,
  e."attributes"->1->>'value' as "to_address",
  (e."attributes"->2->>'value')::NUMERIC as amount,
  null as memo,
  'Free' as "type",
  e.module_id,
  tx.call_id,
  e.event_id,
  tx.id as extrinsic_id,
  b.datetime,
  e.block_id as created_block_id,
  e.block_id as updated_block_id,
  b.created_at,
  b.updated_at
from 
  events e
  inner join blocks b
    on b.block_id = e.block_id::int
  left join extrinsics tx
    on tx.block_id = e.block_id
    and e.extrinsic_idx = tx.extrinsic_idx
where 
  e.module_id = 'staking'
  and e.event_id = 'Reward'
on conflict(id) do nothing;

--- protocolFee.FeeCharged
INSERT INTO "public"."polyx_transactions" ("id", "identity_id", "address", "to_id", "to_address", "amount", "memo", "type", "module_id", "call_id", "event_id", "extrinsic_id", "datetime", "created_block_id", "updated_block_id", "created_at", "updated_at") 
select 
  e.block_id || '/' || e.event_idx as id,
  (select identity_id from accounts where address = e."attributes"->0->>'value') as identity_id,
  e."attributes"->0->>'value' as "address",
  null as to_id,
  null as to_address,
  (e."attributes"->1->>'value')::NUMERIC as amount,
  null as memo,
  'Free' as "type",
  e.module_id,
  tx.call_id,
  e.event_id,
  tx.id as extrinsic_id,
  b.datetime,
  e.block_id as created_block_id,
  e.block_id as updated_block_id,
  b.created_at,
  b.updated_at
from 
  events e
  inner join blocks b
    on b.block_id = e.block_id::int
  left join extrinsics tx
    on tx.block_id = e.block_id
    and e.extrinsic_idx = tx.extrinsic_idx
where 
  e.module_id = 'protocolfee'
  and e.event_id = 'FeeCharged'
on conflict(id) do nothing;

--- transactionpayment.TransactionFeePaid
INSERT INTO "public"."polyx_transactions" ("id", "identity_id", "address", "to_id", "to_address", "amount", "memo", "type", "module_id", "call_id", "event_id", "extrinsic_id", "datetime", "created_block_id", "updated_block_id", "created_at", "updated_at") 
select 
  e.block_id || '/' || e.event_idx as id,
  (select identity_id from accounts where address = e."attributes"->0->>'value') as identity_id,
  e."attributes"->0->>'value' as "address",
  null as to_id,
  null as to_address,
  (e."attributes"->1->>'value')::NUMERIC as amount,
  null as memo,
  'Free' as "type",
  e.module_id,
  tx.call_id,
  e.event_id,
  tx.id as extrinsic_id,
  b.datetime,
  e.block_id as created_block_id,
  e.block_id as updated_block_id,
  b.created_at,
  b.updated_at
from 
  events e
  inner join blocks b
    on b.block_id = e.block_id::int
  left join extrinsics tx
    on tx.block_id = e.block_id
    and e.extrinsic_idx = tx.extrinsic_idx
where 
  e.module_id = 'transactionpayment'
  and e.event_id = 'TransactionFeePaid'
on conflict(id) do nothing;