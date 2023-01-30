alter type public_enum_0bf3c7d4ef add value if not exists 'update_asset_type' after 'unfreeze';
alter type public_enum_0bf3c7d4ef add value if not exists 'cdd_register_did_with_cdd' after 'cdd_register_did';
alter type public_enum_0bf3c7d4ef add value if not exists 'chill_from_governance' after 'chill';
alter type public_enum_0bf3c7d4ef add value if not exists 'execute_manual_instruction' after 'disallow_venues';
alter type public_enum_0bf3c7d4ef add value if not exists 'update_call_runtime_whitelist' after 'instantiate_with_hash_perms';

alter type public_enum_8f5a39c8ee add value if not exists 'AssetTypeChanged' after 'AssetRenamed';
alter type public_enum_8f5a39c8ee add value if not exists 'BridgeTxFailed' after 'BridgeLimitUpdated';
alter type public_enum_8f5a39c8ee add value if not exists 'FailedToExecuteInstruction' after 'AffirmationWithdrawn';
alter type public_enum_8f5a39c8ee add value if not exists 'SettlementManuallyExecuted' after 'SchedulingFailed';
