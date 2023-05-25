/** 
 * Query to fix the amounts associated with each Asset holders
 * This was needed because currently the issued/redeemed and controller transfer amount even if initiated by an external agent,
 * was getting tagged with the Asset owner, which should have been tagged with the external agent
 */
with data as (
  select 
    asset_balances.*
  from (
    select 
      did, 
      asset_id,
      SUM(received_amount - sent_amount) AS current_balance,
      MIN(created_block_id) as created_block_id,
      MAX(updated_block_id) as updated_block_id
    from (
        select 
          attributes->3->'value'->>'did' AS did,
          event_arg_1 as asset_id, 
          SUM((attributes->4->'value')::NUMERIC) AS received_amount, 
          0 AS sent_amount,
          MIN(e.block_id::int) as created_block_id,
          MAX(e.block_id::int) as updated_block_id
        from events e
        where module_id = 'asset' and event_id in ('Transfer')
        group by attributes->3->'value'->>'did', event_arg_1
        
        union all
        
        select 
          attributes->2->'value'->>'did' AS did, 
          event_arg_1 as asset_id,
          0 AS received_amount, 
          SUM((attributes->4->'value')::NUMERIC) AS sent_amount,
          MIN(e.block_id::int) as created_block_id,
          MAX(e.block_id::int) as updated_block_id
        from events e
        where module_id = 'asset' and event_id in ('Transfer')
        group by attributes->2->'value'->>'did', event_arg_1
    ) AS asset_transactions
    where 
      did != '0x0000000000000000000000000000000000000000000000000000000000000000'
    group by 
      did, asset_id
  ) asset_balances 
   left join asset_holders ah
      on ah.asset_id = asset_balances.asset_id
      and ah.identity_id = asset_balances.did
    where 
      ah.amount is null or ah.amount != asset_balances.current_balance
)
insert into asset_holders(id, identity_id, asset_id, amount, created_block_id, updated_block_id, created_at, updated_at)
select 
  d.asset_id || '/' || d.did,
  d.did,
  d.asset_id, 
  d.current_balance, 
  d.created_block_id,
  d.updated_block_id, 
  now(),
  now()
from data d
on conflict(id)
do update set 
  amount = excluded.amount,
  created_block_id = excluded.created_block_id,
  updated_block_id = excluded.updated_block_id;

-- query to remove the rows where amount was tagged to the owner instead of the external agent
with data as (
  select 
    distinct ah.id 
  from events e
  inner join asset_holders ah
    on e.block_id = ah.created_block_id
  inner join assets a
    on a.id = ah.asset_id
  where
    ah.identity_id != e.attributes->3->'value'->>'did'
    and ah.identity_id = a.owner_id
    and ah.asset_id = e.event_arg_1
)
delete from asset_holders
using data d
where d.id = asset_holders.id;
