-- add sto_id column 
alter table stos
add column if not exists sto_id integer;

-- create index for sto_id column
create index if not exists stos_sto_id on stos using btree(sto_id);

-- migrate current id column which stored the sto Id to sto_id column
update stos set sto_id = id::int;

-- set sto_id column to be not null to match the schema description
alter table stos alter column sto_id set not null;

-- update existing sto table entries to change their ID to `offeringAssetId/stoId`
update stos set id = offering_asset_id || '/' || sto_id;

-- fetch all the FundraiserCreated events and populate the missing entries in stos
with sto_data as (
  select 
    event_arg_1 as sto_id, 
    block_id, 
    created_at, 
    coalesce(
      attributes->3->'value'->>'offeringAsset',
      attributes->3->'value'->>'offering_asset' --needed for chain < 5.0.0
    ) as offering_asset_id
  from 
    events e
  where 
    module_id = 'sto' and event_id = 'FundraiserCreated'
)
insert into stos(id, offering_asset_id, sto_id, created_block_id, updated_block_id, created_at, updated_at) 
select sto_data.offering_asset_id || '/' || sto_data.sto_id, sto_data.offering_asset_id, sto_data.sto_id::int, sto_data.block_id, sto_data.block_id,  sto_data.created_at, sto_data.created_at
from sto_data
on conflict(id) do nothing;