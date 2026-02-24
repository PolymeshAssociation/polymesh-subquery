CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

INSERT INTO ticker_reservations
(id, ticker, identity_id, expiry, created_block_id, updated_block_id, _id, _block_range)
SELECT DISTINCT ON(event_arg_1)
    event_arg_1,
    event_arg_1,
    event_arg_0,
    case when event_arg_2 != 'null' then to_timestamp(event_arg_2::bigint / 1000.0) else NULL end,
    block_id,
    block_id,
    uuid_generate_v4(),
    int8range(block_id::bigint, NULL::bigint)
FROM events
WHERE module_id = 'asset'
  AND event_id_text = 'TickerRegistered'
  AND NOT EXISTS (
      SELECT 1
      FROM ticker_reservations
      WHERE ticker_reservations.id = events.event_arg_1
  )
ORDER BY event_arg_1, block_id DESC
ON CONFLICT DO NOTHING;

DO $$
DECLARE
    transfer_event RECORD;
    closed_expiry timestamp;
    registered_ticker text;
    closed_created_block_id text;
BEGIN
    FOR transfer_event IN
        SELECT event_arg_1 AS ticker, event_arg_0 AS new_identity, block_id
        FROM events
        WHERE module_id = 'asset'
          AND event_id_text = 'TickerTransferred'
        ORDER BY block_id ASC
    LOOP
        IF EXISTS (
            SELECT 1 
            FROM ticker_reservations 
            WHERE id = transfer_event.ticker 
              AND identity_id = transfer_event.new_identity
              AND created_block_id = transfer_event.block_id
        ) THEN
            CONTINUE;
        END IF;

        SELECT id, expiry, created_block_id INTO registered_ticker, closed_expiry, closed_created_block_id
        FROM ticker_reservations
        WHERE id = transfer_event.ticker
          AND upper(_block_range) IS NULL
        LIMIT 1;

        IF registered_ticker IS NOT NULL THEN
            IF closed_created_block_id::bigint <= transfer_event.block_id::bigint THEN
                UPDATE ticker_reservations tr
                SET _block_range = int8range(closed_created_block_id::bigint, transfer_event.block_id::bigint),
                    updated_block_id = transfer_event.block_id
                WHERE id = registered_ticker
                  AND upper(tr._block_range) IS NULL;

                INSERT INTO ticker_reservations
                (id, ticker, identity_id, expiry, created_block_id, updated_block_id, _id, _block_range)
                VALUES (
                    transfer_event.ticker,
                    transfer_event.ticker,
                    transfer_event.new_identity,
                    closed_expiry,
                    transfer_event.block_id,
                    transfer_event.block_id,
                    uuid_generate_v4(),
                    int8range(transfer_event.block_id::bigint, NULL::bigint)
                );
            ELSE
                UPDATE ticker_reservations tr
                SET identity_id = transfer_event.new_identity,
                    updated_block_id = transfer_event.block_id
                WHERE id = registered_ticker
                  AND upper(tr._block_range) IS NULL;
            END IF;
        ELSE
            -- Handle the case where the ticker wasn't registered yet
            INSERT INTO ticker_reservations
            (id, ticker, identity_id, expiry, created_block_id, updated_block_id, _id, _block_range)
            VALUES (
                transfer_event.ticker,
                transfer_event.ticker,
                transfer_event.new_identity,
                closed_expiry,
                transfer_event.block_id,
                transfer_event.block_id,
                uuid_generate_v4(),
                int8range(transfer_event.block_id::bigint, NULL::bigint)
            );
        END IF;
    END LOOP;
END $$;

DO $$
DECLARE
    asset_event RECORD;
    closed_identity_id text;
    closed_expiry timestamp;
    closed_created_block_id bigint;
    registered_ticker text;
    target_asset_id text;
BEGIN
    FOR asset_event IN
        SELECT event_arg_1 AS ticker, event_arg_2 AS asset_id, block_id, event_id_text
        FROM events
        WHERE module_id = 'asset'
          AND event_id_text IN ('TickerLinkedToAsset', 'TickerUnlinkedFromAsset')
        ORDER BY block_id ASC
    LOOP
        -- Determine the target asset_id
        IF asset_event.event_id_text = 'TickerUnlinkedFromAsset' THEN
            target_asset_id := NULL;
        ELSE
            target_asset_id := asset_event.asset_id;
        END IF;

        -- Idempotency check: skip if this specific link/unlink has already been processed
        IF EXISTS (
            SELECT 1 
            FROM ticker_reservations 
            WHERE id = asset_event.ticker 
              AND (
                  (asset_id = target_asset_id) OR 
                  (asset_id IS NULL AND target_asset_id IS NULL)
              )
              AND created_block_id = asset_event.block_id
        ) THEN
            CONTINUE;
        END IF;

        -- Retrieve details from the currently active reservation before closing it
        SELECT id, identity_id, expiry, created_block_id INTO registered_ticker, closed_identity_id, closed_expiry, closed_created_block_id
        FROM ticker_reservations
        WHERE id = asset_event.ticker
          AND upper(_block_range) IS NULL
        LIMIT 1;

        IF registered_ticker IS NOT NULL THEN
            IF closed_created_block_id::bigint < asset_event.block_id::bigint THEN
                UPDATE ticker_reservations tr
                SET _block_range = int8range(tr.created_block_id::bigint, asset_event.block_id::bigint),
                    updated_block_id = asset_event.block_id
                WHERE id = asset_event.ticker
                  AND upper(tr._block_range) IS NULL;

                INSERT INTO ticker_reservations
                (id, ticker, identity_id, asset_id, expiry, created_block_id, updated_block_id, _id, _block_range)
                VALUES (
                    asset_event.ticker,
                    asset_event.ticker,
                    closed_identity_id,
                    target_asset_id,
                    closed_expiry,
                    asset_event.block_id,
                    asset_event.block_id,
                    uuid_generate_v4(),
                    int8range(asset_event.block_id::bigint, NULL::bigint)
                );
            ELSE 
              UPDATE ticker_reservations tr
              SET asset_id = target_asset_id,
                updated_block_id = asset_event.block_id
              WHERE id = asset_event.ticker
                AND upper(tr._block_range) IS NULL;
            END IF;
        END IF;
    END LOOP;
END $$;


