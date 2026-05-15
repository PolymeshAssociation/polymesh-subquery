alter table "staking_events" add column if not exists "reward_destination" text;
alter table "staking_events" add column if not exists "reward_destination_account" text;

update "staking_events" set reward_destination = 'LegacyUnknown' where reward_destination is null and event_id in ('Reward', 'Rewarded');
