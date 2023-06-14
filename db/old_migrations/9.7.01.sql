-- creating asset_transactions table for already running SQ
create table if not exists asset_transactions
(
  id text not null PRIMARY KEY,
  asset_id  text not null,
  from_portfolio_id text,
  to_portfolio_id text,
  amount numeric  not null,
  event_id  public_enum_8f5a39c8ee not null,
  event_idx integer not null,
  extrinsic_idx integer,
  funding_round text,
  datetime  timestamp without time zone not null,
  created_block_id text not null,
  updated_block_id text not null,
  created_at timestamp with time zone not null,
  updated_at timestamp with time zone not null
);

alter table asset_transactions
  drop constraint if exists "asset_transactions_asset_id_fkey",
  drop constraint if exists "asset_transactions_created_block_id_fkey",
  drop constraint if exists "asset_transactions_from_portfolio_id_fkey",
  drop constraint if exists "asset_transactions_to_portfolio_id_fkey",
  drop constraint if exists "asset_transactions_updated_block_id_fkey";

alter table asset_transactions
  add constraint "asset_transactions_asset_id_fkey" foreign key (asset_id) references assets(id) on update cascade,
  add constraint "asset_transactions_created_block_id_fkey" foreign key (created_block_id) references blocks(id) on update cascade,
  add constraint "asset_transactions_from_portfolio_id_fkey" foreign key (from_portfolio_id) references portfolios(id) on update cascade on delete set null,
  add constraint "asset_transactions_to_portfolio_id_fkey" foreign key (to_portfolio_id) references portfolios(id) on update cascade on delete set null,
  add constraint "asset_transactions_updated_block_id_fkey" foreign key (updated_block_id) references blocks(id) on update cascade;

create index if not exists "asset_transactions_pkey" on asset_transactions using btree (id);
create index if not exists "asset_transactions_asset_id" on asset_transactions using hash (asset_id);
create index if not exists "asset_transactions_created_block_id" on asset_transactions using hash (created_block_id);
create index if not exists "asset_transactions_from_portfolio_id" on asset_transactions using hash (from_portfolio_id);
create index if not exists "asset_transactions_to_portfolio_id" on asset_transactions using hash (to_portfolio_id);
create index if not exists "asset_transactions_updated_block_id" on asset_transactions using hash (updated_block_id);

-- Inserting data for already processed blocks
insert into asset_transactions 
  (id,asset_id,from_portfolio_id,to_portfolio_id,amount,
    event_id,event_idx,extrinsic_idx,funding_round,datetime,
    created_block_id,updated_block_id,created_at,updated_at)
select 
  e.block_id || '/' || e.event_idx as id,
  e.event_arg_1 as asset_id,
  case 
    when e.event_id = 'Transfer'
      then (e.event_arg_2::jsonb->>'did') || '/' || coalesce(event_arg_2::jsonb->'kind'->>'User','0')
    else null
  end as from_portfolio_id,
  case 
    when e.event_id = 'Transfer'
      then e.event_arg_3::jsonb->>'did' || '/' || coalesce(e.event_arg_3::jsonb->'kind'->>'User','0')
    when e.event_id = 'Issued' 
      then a.owner_id || '/0'
    else null
  end as to_portfolio_id,
  (
    case 
      when e.event_id = 'Transfer' 
        then e."attributes"->4->>'value' 
      else e.event_arg_3 
    end
  )::numeric as amount,
  (
    case 
      when tx.call_id = 'issue' then 'Issued'
      when tx.call_id = 'redeem' then 'Redeemed'
      when tx.call_id = 'redeem_from_portfolio' then 'Redeemed'
      when tx.call_id = 'controller_transfer' then 'ControllerTransfer'
      when tx.call_id = 'push_benefit' then 'BenefitClaimed'
      when tx.call_id = 'claim' then 'BenefitClaimed'
      when tx.call_id = 'invest' then 'Invested'
      else 'Transfer'
    end
  )::public_enum_8f5a39c8ee as event_id,
  e.event_idx,
  e.extrinsic_idx,
  case 
    when e.event_id ='Issued' 
      then e."attributes"->4->>'value' 
    else '' 
  end as funding_round,
  b.datetime,
  e.block_id as created_block_id,
  e.block_id as updated_block_id,
  now() as created_at,
  now() as created_at
from 
  events e
  inner join assets a 
    on a.id = e.event_arg_1
  inner join blocks b 
    on b.block_id = e.block_id::int
  left join extrinsics tx 
    on tx.block_id = e.block_id 
    and tx.call_id in ('issue','redeem','redeem_from_portfolio','controller_transfer','push_benefit','claim','invest')
    and e.extrinsic_idx = tx.extrinsic_idx
where 
  e.module_id = 'asset' 
  and e.event_id in ('Issued','Transfer')
  and case 
      when e.event_id = 'Transfer' 
        then event_arg_2::jsonb->>'did' != '0x0000000000000000000000000000000000000000000000000000000000000000' 
      else true 
    end
order by b.block_id
on conflict(id) do nothing;