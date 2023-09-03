ALTER TABLE public.accounts ALTER COLUMN identity_id DROP NOT NULL;

CREATE TABLE IF NOT EXISTS account_history (
    id text NOT NULL PRIMARY KEY,
    account_id text NOT NULL REFERENCES accounts(id) ON UPDATE CASCADE,
    identity_id text REFERENCES identities(id) ON UPDATE CASCADE,
    event_id public_enum_8f5a39c8ee NOT NULL,
    permissions_id text NOT NULL,
    datetime timestamp(6) NOT NULL,
    created_block_id text NOT NULL,
    updated_block_id text NOT NULL,
    created_at timestamp(6) NOT NULL,
    updated_at timestamp(6) NOT NULL
);

CREATE INDEX IF NOT EXISTS account_history_account_id_index ON account_history (account_id);
CREATE INDEX IF NOT EXISTS account_history_created_block_id_index ON account_history (created_block_id);
CREATE INDEX IF NOT EXISTS account_history_updated_block_id_index ON account_history (updated_block_id);
CREATE INDEX IF NOT EXISTS account_history_identity_id_index ON account_history (identity_id);
CREATE INDEX IF NOT EXISTS account_history_permissions_id_index ON account_history (permissions_id);
