-- add sto_id column 
alter table stos
add column if not exists sto_id integer;

-- create index for sto_id column
create index if not exists stos_sto_id on stos using btree(sto_id);

-- migrate current id column which stored the sto Id to sto_id column
update stos set sto_id = id::int where sto_id is null and id SIMILAR TO '[0-9]+';

-- set sto_id column to be not null to match the schema description
alter table stos alter column sto_id set not null;

-- update existing sto table entries to change their ID to `offeringAssetId/stoId`
update stos set id = offering_asset_id || '/' || sto_id where id SIMILAR TO '[0-9]+';
