alter table asset_transactions add column if not exists instruction_id text,
add column if not exists instruction_memo text;

alter table asset_transactions
  drop constraint if exists "asset_transactions_instruction_id_fkey";

alter table asset_transactions
  add constraint "asset_transactions_instruction_id_fkey" foreign key (instruction_id) references instructions(id) on update cascade on delete set null deferrable;

create index if not exists "0x7fd74c9400e1ed49" on asset_transactions using hash (instruction_id);

-- update data against old `asset.Transfer` events
with update_data as (
  select 
  txs.id,
  (
    select
      attributes->1->>'value'
    from 
      events 
    where 
      event_id = 'InstructionExecuted'
      and block_id = e.block_id 
      and event_idx > e.event_idx
    order by event_idx
    limit 1
  ) as instruction_id
from 
asset_transactions txs
inner join events e on e.block_id = txs.created_block_id and e.event_idx = txs.event_idx
and e.event_id = 'Transfer'
where txs.event_id = 'Transfer'
)
update 
  asset_transactions ast
set 
  instruction_id = inst.id, 
  instruction_memo = inst.memo
from 
  update_data d 
inner join instructions inst on inst.id = d.instruction_id
where 
  d.id = ast.id;

-- update data against new `asset.AssetBalanceUpdated` events
with update_data as (
  select 
  txs.id,
  e.attributes->5->'value'->'Transferred'->>'instructionId' as instruction_id
from 
asset_transactions txs
inner join events e on e.block_id = txs.created_block_id and e.event_idx = txs.event_idx
and e.event_id = 'AssetBalanceUpdated'
where txs.event_id = 'Transfer'
)
update 
  asset_transactions ast
set 
  instruction_id = inst.id, 
  instruction_memo = inst.memo
from 
  update_data d 
inner join instructions inst on inst.id = d.instruction_id
where 
  d.id = ast.id;
