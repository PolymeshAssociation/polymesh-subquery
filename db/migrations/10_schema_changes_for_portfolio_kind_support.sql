alter table "portfolio_movements" add column if not exists "to_account" text;
alter table "portfolio_movements" add column if not exists "from_account" text;

alter table "portfolio_movements" alter column "from_id" drop not null;
alter table "portfolio_movements" alter column "to_id" drop not null;

alter table "legs" add column if not exists "to_account" text;
alter table "legs" add column if not exists "from_account" text;

alter table "instruction_affirmations" add column if not exists "account" text;
alter table "instruction_events" add column if not exists "account" text;

alter table "asset_transactions" add column if not exists "from_account" text;
alter table "asset_transactions" add column if not exists "to_account" text;