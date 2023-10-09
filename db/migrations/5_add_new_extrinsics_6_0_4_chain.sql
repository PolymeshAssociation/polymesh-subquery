alter type public_enum_0bf3c7d4ef add value if not exists 'affirm_with_receipts_with_count' after 'execute_scheduled_instruction_v3';
alter type public_enum_0bf3c7d4ef add value if not exists 'affirm_instruction_with_count' after 'affirm_with_receipts_with_count';
alter type public_enum_0bf3c7d4ef add value if not exists 'reject_instruction_with_count' after 'affirm_instruction_with_count';
alter type public_enum_0bf3c7d4ef add value if not exists 'withdraw_affirmation_with_count' after 'reject_instruction_with_count';