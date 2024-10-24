-- rename the column currency to currency_id
DO $$ 
BEGIN
    IF EXISTS (
        SELECT 1 
        FROM pg_attribute 
        WHERE attname = 'currency' 
          AND attrelid = (
              SELECT oid 
              FROM pg_class 
              WHERE relname = 'distributions'
          )
    ) THEN
        EXECUTE 'ALTER TABLE distributions RENAME COLUMN currency TO currency_id';
        EXECUTE 'CREATE INDEX "0xfa49555fd3055365" ON distributions USING GIST (currency_id, _block_range)';
    END IF;
END $$;

-- first update distribution currency to the one as received from events (either ticker or asset ID) 
update 
  distributions d
set 
  currency_id = e.corporate_action_ticker
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
where a.ticker = d.currency_id;