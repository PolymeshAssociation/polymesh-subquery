update instruction_affirmations
set id = party_id || '/' || off_chain_receipt_id
where off_chain_receipt_id is not null;