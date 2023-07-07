alter type public_enum_0bf3c7d4ef add value if not exists 'exempt_ticker_affirmation' after 'create_asset_with_custom_type';
alter type public_enum_0bf3c7d4ef add value if not exists 'pre_approve_ticker' after 'make_divisible';
alter type public_enum_0bf3c7d4ef add value if not exists 'remove_ticker_affirmation_exemption' after 'remove_metadata_value';
alter type public_enum_0bf3c7d4ef add value if not exists 'remove_ticker_pre_approval' after 'remove_ticker_affirmation_exemption';
alter type public_enum_0bf3c7d4ef add value if not exists 'create_child_identities' after 'register_custom_claim_type';
alter type public_enum_0bf3c7d4ef add value if not exists 'create_child_identity' after 'create_child_identities';
alter type public_enum_0bf3c7d4ef add value if not exists 'unlink_child_identity' after 'create_child_identity';
alter type public_enum_0bf3c7d4ef add value if not exists 'change_sigs_required_via_creator' after 'change_sigs_required';
alter type public_enum_0bf3c7d4ef add value if not exists 'remove_creator_controls' after 'execute_scheduled_proposal';
alter type public_enum_0bf3c7d4ef add value if not exists 'pre_approve_portfolio' after 'accept_portfolio_custody';
alter type public_enum_0bf3c7d4ef add value if not exists 'remove_portfolio_pre_approval' after 'pre_approve_portfolio';

alter type public_enum_0bf3c7d4ef add value if not exists 'placeholder_add_instruction' after 'update_venue_signers';
alter type public_enum_0bf3c7d4ef add value if not exists 'placeholder_add_and_affirm_instruction' after 'placeholder_add_instruction';
alter type public_enum_0bf3c7d4ef add value if not exists 'placeholder_affirm_instruction' after 'placeholder_add_and_affirm_instruction';
alter type public_enum_0bf3c7d4ef add value if not exists 'placeholder_withdraw_affirmation' after 'placeholder_affirm_instruction';
alter type public_enum_0bf3c7d4ef add value if not exists 'placeholder_reject_instruction' after 'placeholder_withdraw_affirmation';
alter type public_enum_0bf3c7d4ef add value if not exists 'placeholder_add_instruction_with_memo' after 'placeholder_reject_instruction';
alter type public_enum_0bf3c7d4ef add value if not exists 'placeholder_add_and_affirm_instruction_with_memo' after 'placeholder_add_instruction_with_memo';
alter type public_enum_0bf3c7d4ef add value if not exists 'execute_scheduled_instruction_v3' after 'placeholder_add_and_affirm_instruction_with_memo';


alter type public_enum_0bf3c7d4ef add value if not exists 'batch_all' after 'relay_tx';
alter type public_enum_0bf3c7d4ef add value if not exists 'dispatch_as' after 'batch_all';
alter type public_enum_0bf3c7d4ef add value if not exists 'force_batch' after 'dispatch_as';
alter type public_enum_0bf3c7d4ef add value if not exists 'with_weight' after 'force_batch';
alter type public_enum_0bf3c7d4ef add value if not exists 'batch_old' after 'with_weight';

--- events
alter type public_enum_8f5a39c8ee add value if not exists 'AssetBalanceUpdated' after 'Redeemed';
alter type public_enum_8f5a39c8ee add value if not exists 'ChildDidCreated' after 'SecondaryKeysUnfrozen';
alter type public_enum_8f5a39c8ee add value if not exists 'ChildDidUnlinked' after 'ChildDidCreated';
alter type public_enum_8f5a39c8ee add value if not exists 'NFTPortfolioUpdated' after 'RedeemedNFT';
alter type public_enum_8f5a39c8ee add value if not exists 'FundsMovedBetweenPortfolios' after 'PortfolioCustodianChanged';
alter type public_enum_8f5a39c8ee add value if not exists 'BatchCompletedOld' after 'BatchCompleted';
alter type public_enum_8f5a39c8ee add value if not exists 'BatchCompletedWithErrors' after 'BatchCompletedOld';
alter type public_enum_8f5a39c8ee add value if not exists 'BatchInterruptedOld' after 'BatchCompletedWithErrors';
alter type public_enum_8f5a39c8ee add value if not exists 'DispatchedAs' after 'BatchInterruptedOld';
alter type public_enum_8f5a39c8ee add value if not exists 'ItemCompleted' after 'DispatchedAs';
alter type public_enum_8f5a39c8ee add value if not exists 'ItemFailed' after 'ItemCompleted';
alter type public_enum_8f5a39c8ee add value if not exists 'RelayedTx' after 'ItemFailed';