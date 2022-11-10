alter type public_enum_0bf3c7d4ef add value if not exists 'redeem_from_portfolio' after 'redeem';
alter type public_enum_0bf3c7d4ef add value if not exists 'add_instruction_with_memo' after 'add_instruction';
alter type public_enum_0bf3c7d4ef add value if not exists 'add_and_affirm_instruction_with_memo' after 'add_and_affirm_instruction';
alter type public_enum_0bf3c7d4ef add value if not exists 'register_custom_claim_type' after 'remove_secondary_keys';

alter type public_enum_8f5a39c8ee add value if not exists 'VenueSignersUpdated' after 'InstructionRescheduled';
alter type public_enum_8f5a39c8ee add value if not exists 'CustomClaimTypeAdded' after 'ClaimAdded';
