-- Fix claim entries with incorrect IDs
with data as 
( 
  select
    c.id, 
    concat(
      e.event_arg_0,
      '/',
      e.claim_type,
      case 
        when e.claim_type = 'CustomerDueDiligence' 
          then concat('/', attributes->1->'value'->'claim'->>'CustomerDueDiligence')
        when e.claim_type = 'NoData' 
          then ''
        else 
          concat(
            case 
              when e.claim_type = 'Custom' 
              then e.attributes->1->'value'->'claim'->'Custom'->>'col1' 
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
              then concat('/', e.attributes->1->'value'->'claim'->'Jurisdiction'->>'col1') 
              else '' 
            end
          )
      end
    ) as new_id
  from claims c
  inner join events e 
    on e.block_id = c.created_block_id 
    and e.event_idx = c.event_idx 
    and e.event_id = 'ClaimAdded'
  left join assets a 
    on 
      case 
        when (e.claim_scope::jsonb)->>'type' = 'Ticker' 
        then a.ticker = (e.claim_scope::jsonb)->>'value' 
        else false 
      end
)
update claims 
  set id = new_id
from data 
where data.id = claims.id and data.id != data.new_id;

-- populate revoke_date against the claims already revoked
with data as 
( 
  select
    concat(
      e.event_arg_0,
      '/',
      e.claim_type,
      case 
        when e.claim_type = 'CustomerDueDiligence' 
          then concat('/', attributes->1->'value'->'claim'->>'CustomerDueDiligence')
        when e.claim_type = 'NoData' 
          then ''
        else 
          concat(
            case 
              when e.claim_type = 'Custom' 
              then e.attributes->1->'value'->'claim'->'Custom'->>'col1' 
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
              then concat('/', e.attributes->1->'value'->'claim'->'Jurisdiction'->>'col1') 
              else '' 
            end
          )
      end
    ) as id,
    b.datetime,
    b.id as block_id,
    e.event_idx
  from events e 
  inner join blocks b 
    on b.id = e.block_id
  left join assets a 
    on 
      case 
        when (e.claim_scope::jsonb)->>'type' = 'Ticker' 
        then a.ticker = (e.claim_scope::jsonb)->>'value' 
        else false 
      end
  where e.event_id = 'ClaimRevoked'
)
update claims c
  set revoke_date = EXTRACT(EPOCH FROM data.datetime) * 1000,
  updated_block_id = data.block_id
from data 
where data.id = c.id;
