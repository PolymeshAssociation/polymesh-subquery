alter type "0bf3c7d4ef" add value if not exists 'allow_identity_to_create_portfolios' after 'update_call_runtime_whitelist';
alter type "0bf3c7d4ef" add value if not exists 'revoke_create_portfolios_permission' after 'allow_identity_to_create_portfolios';
alter type "0bf3c7d4ef" add value if not exists 'create_custody_portfolio' after 'revoke_create_portfolios_permission';
alter type "0bf3c7d4ef" add value if not exists 'instantiate_with_code_as_primary_key' after 'create_custody_portfolio';
alter type "0bf3c7d4ef" add value if not exists 'instantiate_with_hash_as_primary_key' after 'instantiate_with_code_as_primary_key';
alter type "0bf3c7d4ef" add value if not exists 'upgrade_api' after 'instantiate_with_hash_as_primary_key';

alter type "8f5a39c8ee" add value if not exists 'RemoveAssetAffirmationExemption' after 'VenueSignersUpdated';
alter type "8f5a39c8ee" add value if not exists 'AssetAffirmationExemption' after 'RemoveAssetAffirmationExemption';
alter type "8f5a39c8ee" add value if not exists 'PreApprovedAsset' after 'AssetAffirmationExemption';
alter type "8f5a39c8ee" add value if not exists 'RemovePreApprovedAsset' after 'PreApprovedAsset';
alter type "8f5a39c8ee" add value if not exists 'PreApprovedPortfolio' after 'RemovePreApprovedAsset';
alter type "8f5a39c8ee" add value if not exists 'RevokePreApprovedPortfolio' after 'PreApprovedPortfolio';
alter type "8f5a39c8ee" add value if not exists 'InstructionAutomaticallyAffirmed' after 'RevokePreApprovedPortfolio';
alter type "8f5a39c8ee" add value if not exists 'ApiHashUpdated' after 'DelegateCalled';
alter type "8f5a39c8ee" add value if not exists 'SCRuntimeCall' after 'ApiHashUpdated';