-- for older blocks, the extrinsic_idx in asset_transactions was not being populated. We use the events table to update the value for `Issued` event
update 
  asset_transactions ast
set 
  extrinsic_idx = e.extrinsic_idx
from 
  events e
where 
  e.block_id = ast.created_block_id
  and e.event_idx = ast.event_idx
  and ast.extrinsic_idx is null
  and e.extrinsic_idx is not null;

-- extrinsic_id mapping in events was not being populated correctly. We use the block_id and extrinsic_idx to update the missing values
update 
  events
set 
  extrinsic_id = block_id || '/' || extrinsic_idx
where 
  extrinsic_id is null;
