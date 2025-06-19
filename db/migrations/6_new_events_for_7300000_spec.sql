alter type "0bf3c7d4ef" add value if not exists 'lock_instruction' after 'add_and_affirm_with_mediators';
alter type "0bf3c7d4ef" add value if not exists 'enable_offchain_funding' after 'stop';

alter type "8f5a39c8ee" add value if not exists 'InstructionLocked' after 'InstructionMediators';
alter type "8f5a39c8ee" add value if not exists 'FundraiserOffchainFundingEnabled' after 'FundraiserClosed';

alter table "public"."stos" add column if not exists "off_chain_funding_enabled" boolean not null default false;
alter table "public"."stos" add column if not exists "off_chain_funding_token" text;
alter table "public"."stos" alter column "raising_ticker" drop not null;

alter type "b861be9158" add value if not exists 'Locked' after 'Failed';

alter type "7f3c7bae24" add value if not exists 'SettleAfterLock' after 'SettleManual';

DO $$
BEGIN
    IF NOT EXISTS (select 1 from pg_type where typname = '867b307be0') then
        create type "867b307be0" AS ENUM ('OnChain', 'OffChain');
    END IF;
END
$$;

alter table "public"."investments" add column if not exists "raising_asset_type" "867b307be0" not null default 'OnChain';

alter type "3e29b3f361" add value if not exists 'InstructionLocked' after 'InstructionFailed';
