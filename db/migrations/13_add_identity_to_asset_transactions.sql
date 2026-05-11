alter table "asset_transactions" add column if not exists "from_identity_id" text;
alter table "asset_transactions" add column if not exists "to_identity_id" text;

-- Backfill from portfolio IDs (format: did/portfolioNumber)
update "asset_transactions"
set "from_identity_id" = split_part("from_portfolio_id", '/', 1)
where "from_portfolio_id" is not null
  and "from_identity_id" is null;

update "asset_transactions"
set "to_identity_id" = split_part("to_portfolio_id", '/', 1)
where "to_portfolio_id" is not null
  and "to_identity_id" is null;

-- Backfill account-based transactions from the accounts table.
-- Note: this reflects the current identity association for the account,
-- not necessarily the identity at the time of the transaction.
update "asset_transactions" at
set "from_identity_id" = a."identity_id"
from "accounts" a
where at."from_account" = a."id"
  and at."from_identity_id" is null
  and a."identity_id" is not null;

update "asset_transactions" at
set "to_identity_id" = a."identity_id"
from "accounts" a
where at."to_account" = a."id"
  and at."to_identity_id" is null
  and a."identity_id" is not null;

create index if not exists "asset_transactions_from_identity_id" on "asset_transactions" ("from_identity_id");
create index if not exists "asset_transactions_to_identity_id" on "asset_transactions" ("to_identity_id");
