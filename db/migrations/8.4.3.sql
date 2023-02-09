-- Inserts legacy stat data for assets issued before chain 5.0.0
with asset_data as (
  select distinct a.id, a.created_block_id, a.created_at
  from assets a
  inner join events e
    on e.event_arg_1 = a.id
    and e.event_id = 'Issued'
  inner join blocks b
    on b.id = e.block_id
    and b.spec_version_id < 5000000
)
insert into stat_types(id, asset_id, op_type, created_block_id, updated_block_id, created_at, updated_at)
select id || '/Count', id, 'Count', created_block_id, created_block_id, created_at, created_at
from asset_data
on conflict(id)
do update
set
created_at = excluded.created_at,
updated_at = excluded.created_at,
created_block_id = excluded.created_block_id,
updated_block_id = excluded.created_block_id;

with tm_data as (
  select
    asset_id,
    case when type = 'Percentage' then 'Balance' else 'Count' end as op_type,
    value,
    created_block_id,
    updated_block_id,
    created_at,
    updated_at
  from transfer_managers
)
insert into stat_types(id, asset_id, op_type, created_block_id, updated_block_id, created_at, updated_at)
select asset_id || '/' || op_type, asset_id, CAST (op_type AS public_enum_040f13614f), created_block_id, updated_block_id, created_at, updated_at
from tm_data on conflict(id) do nothing;


with tm_data as (
  select
    asset_id,
    case when type = 'Percentage' then 'Balance' else 'Count' end as op_type,
    case when type = 'Percentage' then 'MaxInvestorOwnership' else 'MaxInvestorCount' end as type,
    value,
    created_block_id,
    updated_block_id,
    created_at,
    updated_at
  from transfer_managers
)
insert into transfer_compliances(id, asset_id, type, stat_type_id, value, created_block_id, updated_block_id, created_at, updated_at)
select asset_id || '/' || op_type, asset_id, CAST (type AS public_enum_71afee1504), asset_id || '/' || op_type, value, created_block_id, updated_block_id, created_at, updated_at
from tm_data on conflict(id) do nothing;


with tm_data as (
  select
    asset_id,
    case when type = 'Percentage' then 'Balance' else 'Count' end as op_type,
    jsonb_array_elements(exempted_entities) as entity_id,
    updated_block_id,
    updated_at
  from transfer_managers
)
insert into transfer_compliance_exemptions(id, asset_id, op_type, claim_type, exempted_entity_id, created_block_id, updated_block_id, created_at, updated_at)
select asset_id || '/' || op_type || '/null/' || trim(both '"' from entity_id::text), asset_id, CAST (op_type AS public_enum_040f13614f), null, trim(both '"' from entity_id::text), updated_block_id, updated_block_id, updated_at, updated_at from tm_data on conflict(id) do nothing;