-- upgrade_api was incorrectly sorted if SQ upgrades were used after 10.2.0
-- Below queries will delete the manual insertion and fix the API
delete from pg_enum where enumlabel = 'upgrade_api'; 
alter type "0bf3c7d4ef" add value if not exists 'upgrade_api' after 'instantiate_with_hash_as_primary_key';

-- status of proposals was incorrectly set to `Deleted` on SQ restarts. We set all the deleted proposals to `Active` and then updated logic will handle them correctly.
update multi_sig_proposals set status = 'Active' where status = 'Deleted';