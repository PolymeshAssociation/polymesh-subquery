alter type "8f5a39c8ee" add value if not exists 'SetAssetMediators' after 'LocalMetadataKeyDeleted';
alter type "8f5a39c8ee" add value if not exists 'AssetMediatorsRemoved' after 'SetAssetMediators';
alter type "8f5a39c8ee" add value if not exists 'MediatorAffirmationReceived' after 'InstructionAutomaticallyAffirmed';
alter type "8f5a39c8ee" add value if not exists 'MediatorAffirmationWithdrawn' after 'MediatorAffirmationReceived';

alter type "0bf3c7d4ef" add value if not exists 'add_mandatory_mediators' after 'remove_ticker_pre_approval';
alter type "0bf3c7d4ef" add value if not exists 'remove_mandatory_mediators' after 'add_mandatory_mediators';
alter type "0bf3c7d4ef" add value if not exists 'add_instruction_with_mediators' after 'withdraw_affirmation_with_count';
alter type "0bf3c7d4ef" add value if not exists 'affirm_instruction_as_mediator' after 'add_instruction_with_mediators';
alter type "0bf3c7d4ef" add value if not exists 'withdraw_affirmation_as_mediator' after 'affirm_instruction_as_mediator';
alter type "0bf3c7d4ef" add value if not exists 'reject_instruction_as_mediator' after 'withdraw_affirmation_as_mediator';
alter type "0bf3c7d4ef" add value if not exists 'add_and_affirm_with_mediators' after 'reject_instruction_as_mediator';

