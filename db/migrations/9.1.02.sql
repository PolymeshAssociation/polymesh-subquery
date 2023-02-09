insert into asset_transactions 
  (id, asset_id, from_portfolio_id, to_portfolio_id, amount, 
    event_id, event_idx, funding_round, datetime, 
    created_block_id, updated_block_id, created_at, updated_at)
select 
  e.block_id || '/' || e.event_idx as id, 
  e.event_arg_1 as asset_id,
  case 
    when e.event_id = 'Transfer'
      then (e.event_arg_2::jsonb->>'did') || '/' || coalesce(event_arg_2::jsonb->'kind'->>'User', '0')
    else null
  end as from_portfolio_id,
  case 
    when e.event_id = 'Transfer'
      then e.event_arg_3::jsonb->>'did' || '/' || coalesce(e.event_arg_3::jsonb->'kind'->>'User', '0')
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
    and tx.call_id in ('issue', 'redeem', 'redeem_from_portfolio', 'controller_transfer', 'push_benefit', 'claim', 'invest')
where 
  e.module_id = 'asset' 
  and e.event_id in ('Issued', 'Transfer')
  and case 
      when e.event_id = 'Transfer' 
        then event_arg_2::jsonb->>'did' != '0x0000000000000000000000000000000000000000000000000000000000000000' 
      else true 
    end
order by b.block_id;