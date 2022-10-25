alter table authorizations drop constraint if exists authorizations_to_id_fkey;
drop index if exists authorizations_to_id;
create index authorizations_to_id on authorizations using hash(to_id);
