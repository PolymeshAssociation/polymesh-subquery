-- add unknown to CallIdEnum
alter type "0bf3c7d4ef" add value if not exists 'unknown' after 'set_proposal_duration';

-- add unknown to EventIdEnum
alter type "8f5a39c8ee" add value if not exists 'Unknown' after 'VoteRejectReferendum';

-- add unknown to ModuleIdEnum
alter type "7a0b4cc03e" add value if not exists 'unknown' after 'stocapped';

alter table events 
  add column if not exists module_id_text text,
  add column if not exists event_id_text text;

alter table extrinsics 
  add column if not exists module_id_text text,
  add column if not exists call_id_text text;

alter table polyx_transactions 
  add column if not exists event_id_text text,
  add column if not exists call_id_text text,
  add column if not exists module_id_text text;
