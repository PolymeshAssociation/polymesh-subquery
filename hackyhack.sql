
create or replace function get_first_key(o jsonb)
returns text
language plpgsql
as
$$
declare
   key text;
begin
   select *
   into key
   from jsonb_object_keys(o)
   limit 1;
   return key;
   exception when others then
   return null;
end;
$$;

DROP VIEW IF EXISTS data_block;
CREATE VIEW data_block AS
SELECT
  id :: int as id,
  parent_id,
  hash,
  parent_hash,
  state_root,
  extrinsics_root,
  count_extrinsics,
  count_extrinsics_unsigned,
  count_extrinsics_signed,
  count_extrinsics_error,
  count_extrinsics_success,
  count_events,
  datetime::timestamp(0) as datetime,
  spec_version_id
FROM
  blocks;
  
DROP VIEW IF EXISTS data_extrinsic;
  
CREATE VIEW data_extrinsic AS
SELECT
  block_id,
  extrinsic_idx,
  extrinsic_hash,
  extrinsic_length,
  extrinsic_version,
  signed,
  address_length,
  address,
  signature,
  nonce,
  era,
  call_id,
  module_id,
  params::jsonb as params,
  success,
  spec_version_id
FROM
  extrinsics;
  
DROP VIEW IF EXISTS data_event;
CREATE VIEW data_event AS
SELECT
  block_id,
  event_idx,
  spec_version_id,
  module_id,
  event_id,
  attributes_txt :: jsonb as attributes,
  (attributes #>> '{0,value}')::varchar(100) as event_arg_0,
  (attributes #>> '{1,value}')::varchar(100) as event_arg_1,
  (attributes #>> '{2,value}')::varchar(100) as event_arg_2,
  (attributes #>> '{3,value}')::varchar(100) as event_arg_3,
  get_first_key(
     attributes #> '{1,value,claim}'
  )::varchar(25) as claim_type,
  (CASE 
  	WHEN ((attributes #> '{1,value,claim}') ?|
          array['Accredited','Affiliate','BuyLockup','SellLockup','KnowYourCustomer','Exempted','Blocked'])
   		  THEN
   			json_build_object(
              'type',
              get_first_key(attributes #> '{1,value,claim}' -> get_first_key(attributes #> '{1,value,claim}')),
              'value',
              attributes #> '{1,value,claim}' -> get_first_key(attributes #> '{1,value,claim}') ->> get_first_key(attributes #> '{1,value,claim}' -> get_first_key(attributes #> '{1,value,claim}'))
             )
    WHEN ((attributes #> '{1,value,claim}') ?|
          array['Jurisdiction'])
   		  THEN
   			json_build_object(
              'type',
              get_first_key(attributes #> '{1,value,claim,Jurisdiction,1}'),
              'value',
              attributes #> '{1,value,claim,Jurisdiction,1}' -> get_first_key(attributes #> '{1,value,claim,Jurisdiction,1}')
             )
     WHEN ((attributes #> '{1,value,claim}') ?|
          array['InvestorUniqueness'])
   		  THEN
   			json_build_object(
              'type',
              get_first_key(attributes #> '{1,value,claim,InvestorUniqueness,col1}'),
              'value',
              attributes #> '{1,value,claim,InvestorUniqueness,col1}' -> get_first_key(attributes #> '{1,value,claim,InvestorUniqueness,col1}')
             )
    WHEN ((attributes #> '{1,value,claim}') ?|
          array['CustomerDueDiligence'])
   		  THEN
			null
    ELSE 
   		json_build_object(
              'type',
              get_first_key(attributes #> '{1,value,claim}' -> get_first_key(attributes #> '{1,value,claim}')),
              'value',
              attributes #> '{1,value,claim}' -> get_first_key(attributes #> '{1,value,claim}') ->> get_first_key(attributes #> '{1,value,claim}' -> get_first_key(attributes #> '{1,value,claim}'))
             )
   END )::varchar(255) as claim_scope,
   (attributes #>> '{1,value,claim_issuer}')::varchar(66) as claim_issuer,
   (attributes #>> '{1,value,expiry}')::varchar(15) as claim_expiry,
   (CASE
    	WHEN attributes #>> '{1,value,ticker}' is not null THEN
    		attributes #>> '{1,value,ticker}'
    	WHEN attributes #>> '{3,value,offering_asset}' is not null THEN
    		attributes #>> '{3,value,offering_asset}'
    	ELSE NULL
    END)::varchar(12) as corporate_action_ticker,
    (attributes #>> '{3,value,offering_asset}')::varchar(12) as fundraiser_offering_asset
FROM
	(
    SELECT
        *,
        attributes_txt::jsonb as attributes
    FROM
	    events
) AS events