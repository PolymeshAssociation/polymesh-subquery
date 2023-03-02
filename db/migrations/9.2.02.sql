-- Create StoStatus enum
DO $$
BEGIN
    IF NOT EXISTS (select 1 from pg_type where typname = 'public_enum_9ceea16a44') then
        create type public_enum_9ceea16a44 AS ENUM ('Live', 'Frozen', 'Closed', 'ClosedEarly');
    END IF;
END
$$;

/** 
 * STO entity creation - Add new columns, index and constraints for each newly added attribute in the entity
 */
alter table stos
add column if not exists "name" text,
add column if not exists venue_id text,
add column if not exists offering_portfolio_id text,
add column if not exists raising_asset_id text,
add column if not exists raising_portfolio_id text,
add column if not exists creator_id text,
add column if not exists "start" timestamp without time zone,
add column if not exists "end" timestamp without time zone,
add column if not exists tiers jsonb,
add column if not exists "status" public_enum_9ceea16a44, 
add column if not exists minimum_investment numeric;

create index if not exists "stos_creator_id" on stos using hash(creator_id);
create index if not exists "stos_offering_portfolio_id" on stos using hash(offering_portfolio_id);
create index if not exists "stos_raising_portfolio_id" on stos using hash(raising_portfolio_id);
create index if not exists "stos_tiers" on stos using gin(tiers);
create index if not exists "stos_venue_id" on stos using hash(venue_id);

alter table stos 
drop constraint if exists "stos_creator_id_fkey",
drop constraint if exists "stos_offering_portfolio_id_fkey",
drop constraint if exists "stos_raising_portfolio_id_fkey",
drop constraint if exists "stos_venue_id_fkey";

alter table stos
add constraint "stos_creator_id_fkey" FOREIGN KEY (creator_id) REFERENCES identities(id) ON UPDATE CASCADE,
add constraint "stos_offering_portfolio_id_fkey" FOREIGN KEY (offering_portfolio_id) REFERENCES portfolios(id) ON UPDATE CASCADE,
add constraint "stos_raising_portfolio_id_fkey" FOREIGN KEY (raising_portfolio_id) REFERENCES portfolios(id) ON UPDATE CASCADE,
add constraint "stos_venue_id_fkey" FOREIGN KEY (venue_id) REFERENCES venues(id) ON UPDATE CASCADE;

/**
 * STO data migration - 
 * 
 *   1. Populate all the STO being created with `FundraiserCreated` event
 *   2. Find the last (if any) `FundraiserWindowModified` event for all the STOs and update the corresponding `start` and `end` of the STO
 *   3. Find the last modified status (if any) based on the events `FundraiserFrozen`, `FundraiserUnfrozen`, `FundraiserClosed`. This provides the latest status of all the STOs
 *   4. To make the update data consistent, find the last event which triggered the STO modification and update the `block_id` and `updated_at` from the event against the corresponding STO
 */

-- Create all STOs
with sto_data as (
  select 
    event_arg_1::int as sto_id,
    event_arg_2 as name,
    coalesce(
        attributes->3->'value'->>'venueId',
        attributes->3->'value'->>'venue_id' --needed for chain < 5.0.0
      ) as venue_id,
    coalesce(
        attributes->3->'value'->>'offeringAsset',
        attributes->3->'value'->>'offering_asset' --needed for chain < 5.0.0
      ) as offering_asset_id,
    coalesce(
        attributes->3->'value'->'offeringPortfolio',
        attributes->3->'value'->'offering_portfolio' --needed for chain < 5.0.0
      ) as offering_portfolio,
    coalesce(
        attributes->3->'value'->>'raisingAsset',
        attributes->3->'value'->>'raising_asset' --needed for chain < 5.0.0
      ) as raising_asset_id,
    coalesce(
        attributes->3->'value'->'raisingPortfolio',
        attributes->3->'value'->'raising_portfolio' --needed for chain < 5.0.0
      ) as raising_portfolio,
    "attributes"->3->'value'->>'creator' as creator_id,
    to_timestamp(("attributes"->3->'value'->>'start')::NUMERIC/1000) as start,
    to_timestamp(("attributes"->3->'value'->>'end')::NUMERIC/1000) as end,
    "attributes"->3->'value'->'tiers' as tiers,
    'Live' as status,
    coalesce(
        attributes->3->'value'->'minimumInvestment',
        attributes->3->'value'->'minimum_investment' --needed for chain < 5.0.0
      )::NUMERIC as minimum_investment,
    block_id as created_block_id, 
    block_id as updated_block_id, 
    created_at as created_at, 
    updated_at as updated_at
  from events e
  where module_id = 'sto' and event_id in ('FundraiserCreated')
  order by block_id::int
)
insert into "public"."stos" ("id", "sto_id", "name", "venue_id", "offering_asset_id", "offering_portfolio_id", 
"raising_asset_id", "raising_portfolio_id", "creator_id", "start", "end", "tiers", "status", "minimum_investment",
"created_block_id", "updated_block_id", "created_at", "updated_at")
select 
  offering_asset_id || '/' || sto_id, sto_id, "name", venue_id, 
  offering_asset_id, offering_portfolio->>'did' || '/' || coalesce(offering_portfolio->'kind'->>'User', '0'),
  raising_asset_id, raising_portfolio->>'did' || '/' || coalesce(raising_portfolio->'kind'->>'User', '0'), 
  creator_id, "start", "end", tiers, cast("status" as public_enum_9ceea16a44), minimum_investment,
  created_block_id, updated_block_id, created_at, updated_at
from 
  sto_data
on conflict(id)
do update SET
  "name" = excluded.name,
  venue_id = excluded.venue_id,
  offering_asset_id = excluded.offering_asset_id,
  offering_portfolio_id = excluded.offering_portfolio_id,
  raising_asset_id = excluded.raising_asset_id,
  raising_portfolio_id = excluded.raising_portfolio_id,
  creator_id = excluded.creator_id,
  "start" = excluded.start,
  "end" = excluded.end,
  tiers = excluded.tiers,
  "status" = excluded.status,
  minimum_investment = excluded.minimum_investment,
  created_block_id = excluded.created_block_id,
  updated_block_id = excluded.updated_block_id,
  created_at = excluded.created_at,
  updated_at = excluded.updated_at;

-- Update all the STO windows (start and end)
with modified_data as (
  select 
    s.id,
    tx_data.*
  from stos s 
  inner join lateral 
    (
        select 
          tx.params->0->>'value' || '/' || (tx.params->1->>'value')::text as sto_id,
          to_timestamp((e."attributes"->4->>'value')::NUMERIC/1000) as "start",
          to_timestamp((e."attributes"->5->>'value')::NUMERIC/1000) as "end"
        from 
          extrinsics tx 
          inner join events e 
            on tx.block_id = e.block_id 
            and e.module_id = 'sto' 
            and e.event_id::text = 'FundraiserWindowModified'
          inner join blocks b 
            on b.block_id = e.block_id::int
        where 
          tx.params->0->>'value' = s.offering_asset_id 
          and (tx.params->1->>'value')::int = s.sto_id 
          and tx.call_id = 'modify_fundraiser_window'
        order by 
          e.block_id::int desc, 
          e.event_idx desc 
        limit 1
    ) tx_data on tx_data.sto_id = s.id
)
update 
  stos s
set 
  "start" = modified_data."start", 
  "end" = modified_data."end"
from 
  modified_data 
where 
  modified_data.id = s.id;

-- Update status of the STOs
with modified_data as (
  select 
    s.id,
    tx_data."status"
  from stos s 
    inner join lateral (
      select 
        tx.params->0->>'value' || '/' || (tx.params->1->>'value')::text as sto_id,
        case
          when e.event_id::text = 'FundraiserFrozen' 
            then 'Frozen'
          when e.event_id::text = 'FundraiserUnfrozen' 
            then 'Live'
          when e.event_id::text = 'FundraiserClosed' 
              and b.datetime::TIMESTAMP < s.end::TIMESTAMP -- if it is closed before the configured `end` time, status should be set to `ClosedEarly`
            then 'ClosedEarly'
          else 
            'Closed'
          end as "status"
      from 
        extrinsics tx 
        inner join events e 
          on tx.block_id = e.block_id 
          and e.module_id = 'sto' 
          and e.event_id::text in ('FundraiserFrozen', 'FundraiserUnfrozen', 'FundraiserClosed')
        inner join blocks b 
          on b.block_id = e.block_id::int
      where 
        tx.params->0->>'value' = s.offering_asset_id 
        and (tx.params->1->>'value')::int = s.sto_id 
        and tx.call_id in ('freeze_fundraiser', 'unfreeze_fundraiser', 'stop')
        order by 
          e.block_id::int desc, 
          e.event_idx desc 
        limit 1
    ) tx_data on tx_data.sto_id = s.id
)
update 
  stos s
set 
  "status" = cast(modified_data."status" as public_enum_9ceea16a44)
from 
  modified_data 
where 
  modified_data.id = s.id;

-- Update the timestamp and block when the STO details were updated
with modified_data as (
  select 
    s.id,
    tx_data.*
  from stos s 
    inner join lateral 
    (
      select 
        tx.params->0->>'value' || '/' || (tx.params->1->>'value')::text as sto_id,
        e.updated_at,
        e.block_id as updated_block_id
      from 
        extrinsics tx 
        inner join events e 
          on tx.block_id = e.block_id 
          and e.module_id = 'sto' 
          and e.event_id::text in ('FundraiserFrozen', 'FundraiserUnfrozen', 'FundraiserClosed', 'FundraiserWindowModified')
        inner join blocks b 
          on b.block_id = e.block_id::int
      where 
        tx.params->0->>'value' = s.offering_asset_id 
        and (tx.params->1->>'value')::int = s.sto_id 
        and tx.call_id in ('freeze_fundraiser', 'unfreeze_fundraiser', 'stop', 'modify_fundraiser_window')
      order by 
        e.block_id::int desc, 
        e.event_idx desc 
      limit 1
    ) tx_data on tx_data.sto_id = s.id
)
update 
  stos s
set 
  updated_at = modified_data.updated_at,
  updated_block_id = modified_data.updated_block_id
from 
  modified_data 
where 
  modified_data.id = s.id;

-- Add non null constraints 
alter table stos alter column name set not null;
alter table stos alter column venue_id set not null;
alter table stos alter column offering_portfolio_id set not null;
alter table stos alter column raising_asset_id set not null;
alter table stos alter column raising_portfolio_id set not null;
alter table stos alter column creator_id set not null;
alter table stos alter column "status" set not null;
alter table stos alter column minimum_investment set not null;