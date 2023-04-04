BEGIN;

-- update secondary_keys_frozen field in identities table
WITH event_data AS (
  SELECT
    event_id,
	block_id,
    event_arg_0 as did,
    CASE
      WHEN event_id = 'SecondaryKeysFrozen' THEN true
      WHEN event_id = 'SecondaryKeysUnfrozen' THEN false
      ELSE null
    END as is_frozen,
    created_at as updated_at
  FROM events
  WHERE event_id IN ('SecondaryKeysFrozen', 'SecondaryKeysUnfrozen')
  ORDER BY created_at DESC
)
UPDATE identities
SET
  secondary_keys_frozen = event_data.is_frozen,
  updated_block_id = event_data.block_id,
  updated_at = event_data.updated_at
FROM event_data
WHERE identities.id = event_data.did;

-- handle secondary key left identity 

WITH event_data AS (
  SELECT
    event_arg_1 as id,
  FROM events
  WHERE event_id = 'SecondaryKeyLeftIdentity'
  ORDER BY created_at DESC
)
DELETE FROM permissions
USING event_data
WHERE permissions.id = event_data.id;

-- handle primary key updated

WITH event_data AS (
  SELECT
    event_arg_0 as did,
    event_arg_2 as new_key,
    block_id as updated_block_id,
    created_at as updated_at,
    event_id as event_id
  FROM events
  WHERE event_id = 'PrimaryKeyUpdated'
  ORDER BY created_at DESC
)
UPDATE identities
SET
  primary_account = event_data.new_key,
  event_id = event_data.event_id
  updated_block_id = event_data.updated_block_id,
  updated_at = event_data.updated_at
FROM event_data
WHERE identities.id = event_data.did;

COMMIT;