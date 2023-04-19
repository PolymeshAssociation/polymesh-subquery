INSERT INTO "public"."polyx_transactions" ("id", "identity_id", "address", "to_id", "to_address", "amount", "memo", "type", "module_id", "call_id", "event_id", "extrinsic_id", "datetime", "created_block_id", "updated_block_id", "created_at", "updated_at") VALUES
select 
  e.block_id || '/' || e.event_idx as id,
  e."attributes"->0->>'value' as identity_id,
  e."attributes"->1->>'value' as "address",
  e."attributes"->2->>'value' as to_id,
  e."attributes"->3->>'value' as "to_address",
  e."attributes"->4->>'value' as amount,
  e."attributes"->5->>'value' as memo,
  'Free' as "type",
  e.module_id,
  tx.call_id,
  e.event_id,
  tx.id as extrinsic_id,
  b.datetime,
  e.block_id as created_block_id,
  e.block_id as updated_block_id,
  now(),
  now()
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
INSERT INTO "public"."polyx_transactions" ("id", "identity_id", "address", "to_id", "to_address", "amount", "memo", "type", "module_id", "call_id", "event_id", "extrinsic_id", "datetime", "created_block_id", "updated_block_id", "created_at", "updated_at") VALUES
select 
  e.block_id || '/' || e.event_idx as id,
  e."attributes"->0->>'value' as identity_id,
  e."attributes"->1->>'value' as "address",
  null as to_id,
  null as "to_address",
  e."attributes"->2->>'value' as amount,
  null as memo,
  'Free' as "type",
  e.module_id,
  tx.call_id,
  e.event_id,
  tx.id as extrinsic_id,
  b.datetime,
  e.block_id as created_block_id,
  e.block_id as updated_block_id,
  now(),
  now()
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
INSERT INTO "public"."polyx_transactions" ("id", "identity_id", "address", "to_id", "to_address", "amount", "memo", "type", "module_id", "call_id", "event_id", "extrinsic_id", "datetime", "created_block_id", "updated_block_id", "created_at", "updated_at") VALUES
select 
  e.block_id || '/' || e.event_idx as id,
  (select identity_id from accounts where address = e."attributes"->0->>'value') as identity_id,
  e."attributes"->0->>'value' as "address",
  (select identity_id from accounts where address = e."attributes"->0->>'value') as to_id,
  e."attributes"->0->>'value' as "to_address",
  e."attributes"->1->>'value' as amount,
  null as memo,
  'Reserved' as "type",
  e.module_id,
  tx.call_id,
  e.event_id,
  tx.id as extrinsic_id,
  b.datetime,
  e.block_id as created_block_id,
  e.block_id as updated_block_id,
  now(),
  now()
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
INSERT INTO "public"."polyx_transactions" ("id", "identity_id", "address", "to_id", "to_address", "amount", "memo", "type", "module_id", "call_id", "event_id", "extrinsic_id", "datetime", "created_block_id", "updated_block_id", "created_at", "updated_at") VALUES
select 
  e.block_id || '/' || e.event_idx as id,
  (select identity_id from accounts where address = e."attributes"->0->>'value') as identity_id,
  e."attributes"->0->>'value' as "address",
  (select identity_id from accounts where address = e."attributes"->0->>'value') as to_id,
  e."attributes"->0->>'value' as "to_address",
  e."attributes"->1->>'value' as amount,
  null as memo,
  'Free' as "type",
  e.module_id,
  tx.call_id,
  e.event_id,
  tx.id as extrinsic_id,
  b.datetime,
  e.block_id as created_block_id,
  e.block_id as updated_block_id,
  now(),
  now()
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
INSERT INTO "public"."polyx_transactions" ("id", "identity_id", "address", "to_id", "to_address", "amount", "memo", "type", "module_id", "call_id", "event_id", "extrinsic_id", "datetime", "created_block_id", "updated_block_id", "created_at", "updated_at") VALUES
select 
  e.block_id || '/' || e.event_idx as id,
  (select identity_id from accounts where address = e."attributes"->0->>'value') as identity_id,
  e."attributes"->1->>'value' as "address",
  null as to_id,
  null as "to_address",
  e."attributes"->2->>'value' as amount,
  null as memo,
  'Free' as "type",
  e.module_id,
  tx.call_id,
  e.event_id,
  tx.id as extrinsic_id,
  b.datetime,
  e.block_id as created_block_id,
  e.block_id as updated_block_id,
  now(),
  now()
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
INSERT INTO "public"."polyx_transactions" ("id", "identity_id", "address", "to_id", "to_address", "amount", "memo", "type", "module_id", "call_id", "event_id", "extrinsic_id", "datetime", "created_block_id", "updated_block_id", "created_at", "updated_at") VALUES
select 
  e.block_id || '/' || e.event_idx as id,
  e."attributes"->0->>'value' as identity_id,
  e."attributes"->1->>'value' as "address",
  null as to_id,
  null as "to_address",
  e."attributes"->2->>'value' as amount,
  null as memo,
  'Bonded' as "type",
  e.module_id,
  tx.call_id,
  e.event_id,
  tx.id as extrinsic_id,
  b.datetime,
  e.block_id as created_block_id,
  e.block_id as updated_block_id,
  now(),
  now()
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
INSERT INTO "public"."polyx_transactions" ("id", "identity_id", "address", "to_id", "to_address", "amount", "memo", "type", "module_id", "call_id", "event_id", "extrinsic_id", "datetime", "created_block_id", "updated_block_id", "created_at", "updated_at") VALUES
select 
  e.block_id || '/' || e.event_idx as id,
  null as identity_id,
  null as "address",
  e."attributes"->0->>'value' as to_id,
  e."attributes"->1->>'value' as "to_address",
  e."attributes"->2->>'value' as amount,
  null as memo,
  'Unbonded' as "type",
  e.module_id,
  tx.call_id,
  e.event_id,
  tx.id as extrinsic_id,
  b.datetime,
  e.block_id as created_block_id,
  e.block_id as updated_block_id,
  now(),
  now()
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
INSERT INTO "public"."polyx_transactions" ("id", "identity_id", "address", "to_id", "to_address", "amount", "memo", "type", "module_id", "call_id", "event_id", "extrinsic_id", "datetime", "created_block_id", "updated_block_id", "created_at", "updated_at") VALUES
select 
  e.block_id || '/' || e.event_idx as id,
  (select identity_id from accounts where address = e."attributes"->0->>'value') as identity_id,
  e."attributes"->0->>'value' as "address",
  (select identity_id from accounts where address = e."attributes"->0->>'value') as to_id,
  e."attributes"->0->>'value' as "to_address",
  e."attributes"->1->>'value' as amount,
  null as memo,
  'Free' as "type",
  e.module_id,
  tx.call_id,
  e.event_id,
  tx.id as extrinsic_id,
  b.datetime,
  e.block_id as created_block_id,
  e.block_id as updated_block_id,
  now(),
  now()
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

--- staking.Withdrawn
INSERT INTO "public"."polyx_transactions" ("id", "identity_id", "address", "to_id", "to_address", "amount", "memo", "type", "module_id", "call_id", "event_id", "extrinsic_id", "datetime", "created_block_id", "updated_block_id", "created_at", "updated_at") VALUES
select 
  e.block_id || '/' || e.event_idx as id,
  null as identity_id,
  null as "address",
  e."attributes"->0->>'value' as to_id,
  e."attributes"->1->>'value' as "to_address",
  e."attributes"->2->>'value' as amount,
  null as memo,
  'Free' as "type",
  e.module_id,
  tx.call_id,
  e.event_id,
  tx.id as extrinsic_id,
  b.datetime,
  e.block_id as created_block_id,
  e.block_id as updated_block_id,
  now(),
  now()
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

--- staking.Withdrawn
INSERT INTO "public"."polyx_transactions" ("id", "identity_id", "address", "to_id", "to_address", "amount", "memo", "type", "module_id", "call_id", "event_id", "extrinsic_id", "datetime", "created_block_id", "updated_block_id", "created_at", "updated_at") VALUES
select 
  e.block_id || '/' || e.event_idx as id,
  (select identity_id from accounts where address = e."attributes"->0->>'value') as identity_id,
  e."attributes"->0->>'value' as "address",
  (select identity_id from accounts where address = e."attributes"->0->>'value') as to_id,
  e."attributes"->0->>'value' as "to_address",
  e."attributes"->1->>'value' as amount,
  null as memo,
  'Free' as "type",
  e.module_id,
  tx.call_id,
  e.event_id,
  tx.id as extrinsic_id,
  b.datetime,
  e.block_id as created_block_id,
  e.block_id as updated_block_id,
  now(),
  now()
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

--- protocolFee.FeeCharged
INSERT INTO "public"."polyx_transactions" ("id", "identity_id", "address", "to_id", "to_address", "amount", "memo", "type", "module_id", "call_id", "event_id", "extrinsic_id", "datetime", "created_block_id", "updated_block_id", "created_at", "updated_at") VALUES
select 
  e.block_id || '/' || e.event_idx as id,
  (select identity_id from accounts where address = e."attributes"->0->>'value') as identity_id,
  e."attributes"->0->>'value' as "address",
  null as to_id,
  null as to_address,
  e."attributes"->1->>'value' as amount,
  null as memo,
  'Free' as "type",
  e.module_id,
  tx.call_id,
  e.event_id,
  tx.id as extrinsic_id,
  b.datetime,
  e.block_id as created_block_id,
  e.block_id as updated_block_id,
  now(),
  now()
from 
  events e
  inner join blocks b
    on b.block_id = e.block_id::int
  left join extrinsics tx
    on tx.block_id = e.block_id
    and e.extrinsic_idx = tx.extrinsic_idx
where 
  e.module_id = 'protocolFee'
  and e.event_id = 'FeeCharged'
on conflict(id) do nothing;

--- transactionpayment.TransactionFeePaid
INSERT INTO "public"."polyx_transactions" ("id", "identity_id", "address", "to_id", "to_address", "amount", "memo", "type", "module_id", "call_id", "event_id", "extrinsic_id", "datetime", "created_block_id", "updated_block_id", "created_at", "updated_at") VALUES
select 
  e.block_id || '/' || e.event_idx as id,
  (select identity_id from accounts where address = e."attributes"->0->>'value') as identity_id,
  e."attributes"->0->>'value' as "address",
  null as to_id,
  null as to_address,
  e."attributes"->1->>'value' as amount,
  null as memo,
  'Free' as "type",
  e.module_id,
  tx.call_id,
  e.event_id,
  tx.id as extrinsic_id,
  b.datetime,
  e.block_id as created_block_id,
  e.block_id as updated_block_id,
  now(),
  now()
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