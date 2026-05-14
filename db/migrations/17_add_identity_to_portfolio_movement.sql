alter table "portfolio_movements" add column if not exists "identity_id" text;

-- Backfill from portfolio IDs (format: did/portfolioNumber)
update "portfolio_movements"
set "identity_id" = split_part("from_id", '/', 1)
where "from_id" is not null
  and "identity_id" is null;

-- Backfill account-based transactions from the accounts table.
-- Note: this reflects the current identity association for the account,
-- not necessarily the identity at the time of the transaction.
update "portfolio_movements" at
set "identity_id" = a."identity_id"
from "accounts" a
where at."from_account" = a."id"
  and at."identity_id" is null
  and a."identity_id" is not null;

create index if not exists "portfolio_movements_identity_id" on "portfolio_movements" ("identity_id");
