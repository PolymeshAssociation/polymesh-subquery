### Migration Files

Migration files should be placed within the `db/migrations` directory and should adhere to the following naming convention: `${version}_${description}.sql`

Common scenarios in which migration files are used include:

- **Adding enum values**

When schema changes involve adding new values to an existing enum, SQ may encounter errors upon restart due to differences in enum values. To successfully restart SQ, we need to write queries that add or remove enum values in the schema at the specified location. For example:

```
alter type "0bf3c7d4ef" add value if not exists 'exempt_ticker_affirmation' after 'create_asset_with_custom_type';
```

If an entirely new enum is introduced to the schema, it should be added as follows:

```
DO $$
BEGIN
    IF NOT EXISTS (select 1 from pg_type where typname = '5df0f1d22c') then
        create type "5df0f1d22c" AS ENUM ('Free', 'Reserved', 'Bonded', 'Unbonded', 'Locked');
    END IF;
END
$$;
```

- **Altering Existing Entities**

When modifying an existing entity, SQL queries must be added to ensure that the entity's state appears as if it was originally designed. For example, if a new attribute `processedBlock: Int!` is added to an entity named `Migration`, the following SQL queries should be used:

```
alter table migrations add column if not exists processed_block integer;
update migrations set processed_block = 0 where processed_block is null;
alter table migrations alter column processed_block set not null;
```

These queries add the new column, update existing rows (for data from previously processed blocks/events), and enforce schema validations (where ! is specified) by adding a not-null constraint.

- **Correcting Entity Data**

There may be instances where a new metadata attribute is added to an existing entity, or data was incorrectly populated for an entity. This could require complex parsing of the events table to populate the data. For example, the following query adds missing STO details:-

```
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
```

### Migration Handlers

In cases where SQL alone may not provide all the necessary tools to correct or add data to an entity table, a migration handler can be used to process previously handled blocks in batches, reprocessing entity data. In such scenarios, the mappingHandlers need to be updated differently, as demonstrated in `mapPolyxTransactions`.

Please refer to the `mapPolyxTransactions` for guidance on how to handle such scenarios using the migration handler.
