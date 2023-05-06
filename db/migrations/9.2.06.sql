DO $$
BEGIN
   IF EXISTS (
      SELECT 1
      FROM information_schema.columns 
      WHERE table_schema = 'public'
            AND table_name = 'accounts'
            AND column_name = 'identity_id'
      ) 
   THEN 
      IF EXISTS (
         SELECT 1
         FROM information_schema.columns 
         WHERE table_schema = 'public'
               AND table_name = 'accounts'
               AND column_name = 'identity_id'
               AND is_nullable = 'NO' )
      THEN
         ALTER TABLE public.accounts ALTER COLUMN identity_id DROP NOT NULL;
      END IF;
   END IF;
END $$;

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS account_history (
    id text NOT NULL DEFAULT uuid_generate_v4(),
    account_id text,
    identity_id text,
    event_id public_enum_8f5a39c8ee,
    permissions_id text,
    datetime timestamp(6),
    updated_block_id text
);

BEGIN;

-- handle primary key updated

-- create account history entries
WITH event_data AS (
  SELECT
    event_arg_0 as did,
    event_id,
    block_id as updated_block_id,
    created_at as updated_at
  FROM events
  WHERE event_id = 'PrimaryKeyUpdated'
  ORDER BY created_at ASC
), account_data AS (
  SELECT
    accounts.id as id,
    accounts.address as address,
    accounts.permissions_id as permissions_id,
    accounts.identity_id as identity_id
  FROM accounts
  JOIN event_data ON accounts.identity_id = event_data.did
)
INSERT INTO account_history (account_id, identity_id, event_id, permissions_id, datetime, updated_block_id)
SELECT
  account_data.id,
  account_data.identity_id,
  event_data.event_id,
  account_data.permissions_id,
  event_data.updated_at,
  event_data.updated_block_id
FROM account_data, event_data;

-- select old account permissions and copy them to new account
WITH event_data AS (
  SELECT
    event_arg_0 as did,
    event_arg_2 as new_key,
    block_id as updated_block_id,
    created_at as updated_at
  FROM events
  WHERE event_id = 'PrimaryKeyUpdated'
  ORDER BY created_at ASC
), account_data AS (
  SELECT
    accounts.id as id,
    accounts.permissions_id as permissions_id,
    accounts.identity_id as identity_id
  FROM accounts
  JOIN event_data ON accounts.identity_id = event_data.did
), permission_data AS (
  SELECT
    permissions.id as id,
    permissions.assets as assets,
    permissions.portfolios as portfolios,
    permissions.transactions as transactions,
    permissions.transaction_groups as transaction_groups,
    permissions.datetime as datetime,
    permissions.created_block_id as created_block_id,
    permissions.updated_block_id as updated_block_id,
    permissions.created_at as created_at,
    permissions.updated_at as updated_at
  FROM permissions
  JOIN account_data ON permissions.id = account_data.permissions_id
)
INSERT INTO permissions (id, assets, portfolios, transactions, transaction_groups, datetime, created_block_id, updated_block_id, created_at, updated_at)
SELECT
  event_data.new_key,
  permission_data.assets,
  permission_data.portfolios,
  permission_data.transactions,
  permission_data.transaction_groups,
  permission_data.datetime,
  permission_data.created_block_id,
  permission_data.updated_block_id,
  permission_data.created_at,
  permission_data.updated_at
FROM permission_data, event_data;

-- create the new account
WITH event_data AS (
  SELECT
    event_arg_0 as did,
    event_arg_2 as new_key,
    event_id,
    block_id,
    created_at
  FROM events
  WHERE event_id = 'PrimaryKeyUpdated'
  ORDER BY created_at ASC
)
INSERT INTO accounts (id, address, identity_id, event_id, permissions_id, datetime, created_block_id, updated_block_id, created_at, updated_at)
SELECT
  event_data.new_key,
  event_data.new_key,
  event_data.did,
  'PrimaryKeyUpdated',
  event_data.new_key,
  event_data.created_at,
  event_data.block_id,
  event_data.block_id,
  event_data.created_at,
  event_data.created_at
FROM event_data;

-- -- handle primary key updated

-- create account history entries
WITH event_data AS (
  SELECT
    event_arg_0 as did,
    event_id,
    block_id as updated_block_id,
    created_at as updated_at
  FROM events
  WHERE event_id = 'PrimaryKeyUpdated'
  ORDER BY created_at ASC
), account_data AS (
  SELECT
    accounts.id as id,
    accounts.address as address,
    accounts.permissions_id as permissions_id,
    accounts.identity_id as identity_id
  FROM accounts
  JOIN event_data ON accounts.identity_id = event_data.did
)
INSERT INTO account_history (account_id, identity_id, event_id, permissions_id, datetime, updated_block_id)
SELECT
  account_data.id,
  account_data.identity_id,
  event_data.event_id,
  account_data.permissions_id,
  event_data.updated_at,
  event_data.updated_block_id
FROM account_data, event_data;

-- select old account permissions and copy them to new account
WITH event_data AS (
  SELECT
    event_arg_0 as did,
    event_arg_2 as new_key,
    block_id as updated_block_id,
    created_at as updated_at
  FROM events
  WHERE event_id = 'PrimaryKeyUpdated'
  ORDER BY created_at ASC
), account_data AS (
  SELECT
    accounts.id as id,
    accounts.permissions_id as permissions_id,
    accounts.identity_id as identity_id
  FROM accounts
  JOIN event_data ON accounts.identity_id = event_data.did
), permission_data AS (
  SELECT
    permissions.id as id,
    permissions.assets as assets,
    permissions.portfolios as portfolios,
    permissions.transactions as transactions,
    permissions.transaction_groups as transaction_groups,
    permissions.datetime as datetime,
    permissions.created_block_id as created_block_id,
    permissions.updated_block_id as updated_block_id,
    permissions.created_at as created_at,
    permissions.updated_at as updated_at
  FROM permissions
  JOIN account_data ON permissions.id = account_data.permissions_id
)
INSERT INTO permissions (id, assets, portfolios, transactions, transaction_groups, datetime, created_block_id, updated_block_id, created_at, updated_at)
SELECT
  event_data.new_key,
  permission_data.assets,
  permission_data.portfolios,
  permission_data.transactions,
  permission_data.transaction_groups,
  permission_data.datetime,
  permission_data.created_block_id,
  permission_data.updated_block_id,
  permission_data.created_at,
  permission_data.updated_at
FROM permission_data, event_data;

-- create the new account
WITH event_data AS (
  SELECT
    event_arg_0 as did,
    event_arg_2 as new_key,
    event_id,
    block_id,
    created_at
  FROM events
  WHERE event_id = 'PrimaryKeyUpdated'
  ORDER BY created_at ASC
)
INSERT INTO accounts (id, address, identity_id, event_id, permissions_id, datetime, created_block_id, updated_block_id, created_at, updated_at)
SELECT
  event_data.new_key,
  event_data.new_key,
  event_data.did,
  'PrimaryKeyUpdated',
  event_data.new_key,
  event_data.created_at,
  event_data.block_id,
  event_data.block_id,
  event_data.created_at,
  event_data.created_at
FROM event_data;

-- remove the permissions from the old account
WITH event_data AS (
  SELECT
    event_arg_0 as did,
    event_arg_2 as new_key
  FROM events
  WHERE event_id = 'PrimaryKeyUpdated'
  ORDER BY created_at ASC
), account_data AS (
  SELECT
    accounts.id as id,
    accounts.permissions_id as permissions_id
  FROM accounts
  JOIN event_data ON accounts.identity_id = event_data.did
)
DELETE FROM permissions
WHERE id IN (SELECT permissions_id FROM account_data);

-- unlink identity from old account
WITH event_data AS (
  SELECT
    event_arg_0 as did,
    event_arg_2 as new_key
  FROM events
  WHERE event_id = 'PrimaryKeyUpdated'
  ORDER BY created_at ASC
), account_data AS (
  SELECT
    accounts.id as id
  FROM accounts
  JOIN event_data ON accounts.identity_id = event_data.did
)
UPDATE accounts
SET
  identity_id = NULL
WHERE id IN (SELECT id FROM account_data);

-- link the new account to the identity
WITH event_data AS (
  SELECT
    event_arg_0 as did,
    event_arg_2 as new_key,
    block_id as updated_block_id,
    created_at as updated_at
  FROM events
  WHERE event_id = 'PrimaryKeyUpdated'
  ORDER BY created_at ASC
)
UPDATE identities
SET
  primary_account = event_data.new_key,
  updated_block_id = event_data.updated_block_id,
  updated_at = event_data.updated_at
FROM event_data
WHERE identities.id = event_data.did;


-- link the new account to the identity
WITH event_data AS (
  SELECT
    event_arg_0 as did,
    event_arg_2 as new_key,
    block_id as updated_block_id,
    created_at as updated_at
  FROM events
  WHERE event_id = 'PrimaryKeyUpdated'
  ORDER BY created_at ASC
)
UPDATE identities
SET
  primary_account = event_data.new_key,
  updated_block_id = event_data.updated_block_id,
  updated_at = event_data.updated_at
FROM event_data
WHERE identities.id = event_data.did;

COMMIT;

BEGIN;
-- handle secondary key left identity 

-- remove the permissions from the account that has left the identity
WITH event_data AS (
  SELECT
    event_arg_1 as account_id
  FROM events
  WHERE event_id = 'SecondaryKeyLeftIdentity'
  ORDER BY created_at ASC
)
DELETE FROM permissions
USING event_data
WHERE permissions.id = event_data.account_id;

-- create history entity for the account that has left the identity
WITH event_data AS (
  SELECT
    event_arg_1 as account_id,
    block_id as updated_block_id,
    created_at as updated_at
  FROM events
  WHERE event_id = 'SecondaryKeyLeftIdentity'
  ORDER BY created_at ASC
), account_data AS (
  SELECT
    accounts.id as id,
    accounts.address as address,
    accounts.permissions_id as permissions_id,
    accounts.identity_id as did
  FROM accounts
  JOIN event_data ON accounts.id = event_data.account_id
)
INSERT INTO account_history (account_id, identity_id, event_id, permissions_id, datetime, updated_block_id)
SELECT
  account_data.id,
  account_data.did,
  'SecondaryKeyLeftIdentity',
  account_data.permissions_id,
  event_data.updated_at,
  event_data.updated_block_id
FROM account_data, event_data;

-- unlink identity from the account that has left the identity
WITH event_data AS (
  SELECT
    event_arg_1 as account_id
  FROM events
  WHERE event_id = 'SecondaryKeyLeftIdentity'
  ORDER BY created_at ASC
)
UPDATE accounts
SET
  identity_id = NULL
WHERE id IN (SELECT account_id FROM event_data);

COMMIT;