-- NOTE: This migration should only run after all pre 7.0 blocks have been processed
-- Similar logic should be triggered when the 7.0 upgrade is reached

-- Update claims ID field to use asset IDs
UPDATE claims
SET id = REGEXP_REPLACE(id, '/Asset/[^/]+', '/Asset/' || (scope->>'assetId')::TEXT)
WHERE scope ? 'assetId';

-- Find ClaimRevoked events and update corresponding claims with the revoke date
WITH revoked_events AS (
  select
	    concat(
	      e.event_arg_0,
	      '/',
	      e.claim_type,
	      case
	        when e.claim_type = 'CustomerDueDiligence'
	          then concat('/', attributes_txt::jsonb->1->'value'->'claim'->>'CustomerDueDiligence')
	        when e.claim_type = 'NoData'
	          then ''
	        else
	          concat(
	            case
	              when e.claim_type = 'Custom'
	              then e.attributes_txt::jsonb->1->'value'->'claim'->'Custom'->>'col1'
	              else ''
	            end,
	            case
	              when e.claim_scope is not null
	              then
	                case
	                  when (e.claim_scope::jsonb)->>'type' is not null
	                  then
	                    concat(
	                      '/',
	                      case
	                        when (e.claim_scope::jsonb)->>'type' = 'Ticker'
	                        then 'Asset'
	                        else (e.claim_scope::jsonb)->>'type'
	                      end,
	                      '/',
	                      case
	                        when (e.claim_scope::jsonb)->>'type' = 'Ticker'
	                        then a.id
	                        else (e.claim_scope::jsonb)->>'value'
	                      end
	                    )
	                  else '//'
	                end
	              else ''
	            end,
	            case
	              when e.claim_type = 'Jurisdiction'
	              then concat('/', e.attributes_txt::jsonb->1->'value'->'claim'->'Jurisdiction'->>'col1')
	              else ''
	            end
	          )
	      end
	    ) as claim_id,
	    e.attributes_txt::jsonb->1->'value'->'issuanceDate' as revoke_date,
	    e.block_id,
	    e.event_idx
	  from events e
	  left join assets a
	    on
	      case
	        when (e.claim_scope::jsonb)->>'type' = 'Ticker'
	        then a.ticker = (e.claim_scope::jsonb)->>'value'
	        else false
	      end
	  where e.event_id = 'ClaimRevoked'
),
latest_claims AS (
    SELECT *
    FROM claims
    WHERE upper_inf(_block_range)
),
claims_to_update AS (
    SELECT
        lc.id AS claim_id,
        re.revoke_date,
        re.block_id AS updated_block
    FROM revoked_events re
    JOIN latest_claims lc ON re.claim_id = lc.id
)
UPDATE claims
SET revoke_date = claims_to_update.revoke_date::numeric,
  updated_block_id = claims_to_update.updated_block
FROM claims_to_update
WHERE claims.id = claims_to_update.claim_id
  AND upper_inf(_block_range);
