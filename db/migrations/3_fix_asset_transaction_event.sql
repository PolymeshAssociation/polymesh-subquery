-- update the event types for NFT related asset transactions correctly
update asset_transactions
set event_id = (case 
      when from_portfolio_id is null
        then case when amount is not null then 'Issued' else 'IssuedNFT' end
      when to_portfolio_id is null
        then case when amount is not null then 'Redeemed' else 'RedeemedNFT' end
      end)::"8f5a39c8ee"
where 
  from_portfolio_id is null or to_portfolio_id is null;

with update_data as (
  select 
  txs.id,
  e.attributes->4->'value'->'Transferred'->>'instructionId' as instruction_id
from 
asset_transactions txs
inner join events e on e.block_id = txs.created_block_id and e.event_idx = txs.event_idx
and e.event_id = 'NFTPortfolioUpdated'
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
