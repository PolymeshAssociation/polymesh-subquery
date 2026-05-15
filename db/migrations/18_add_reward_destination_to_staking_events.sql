alter table "staking_events" add column if not exists "reward_destination" text;
alter table "staking_events" add column if not exists "reward_destination_account" text;
