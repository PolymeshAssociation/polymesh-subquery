alter table migrations add column if not exists processed_block integer;
update migrations set processed_block = 0 where processed_block is null;
alter table migrations alter column processed_block set not null;
