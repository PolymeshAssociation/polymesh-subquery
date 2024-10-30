-- first update distribution currency to the one as received from events (either ticker or asset ID) 
update 
  distributions d
set 
  currency_id = e.attributes->2->'value'->>'currency'
from 
  events e 
where e.block_id = d.created_block_id
  and e.module_id = 'capitaldistribution'
  and e.event_id = 'Created';

-- then update the distribution currency to asset_id value from the assets table
update 
  distributions d
set 
  currency_id = a.id
from 
  assets a
where 
  a.ticker = d.currency_id;