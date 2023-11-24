alter table multi_sig_proposals alter column status type text;
create index if not exists "0x9b5ac03e59df0332" on multi_sig_proposals(status);