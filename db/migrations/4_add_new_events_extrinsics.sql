
alter type "0bf3c7d4ef" add value if not exists 'set_disable_fees' after 'burn_account_balance';
alter type "0bf3c7d4ef" add value if not exists 'initiate_corporate_action_and_ballot' after 'initiate_corporate_action_and_distribute';
alter type "0bf3c7d4ef" add value if not exists 'update_global_metadata_spec' after 'unlink_ticker_from_asset_id';

alter type "8f5a39c8ee" add value if not exists 'GlobalMetadataSpecUpdated' after 'TickerUnlinkedFromAsset';
alter type "8f5a39c8ee" add value if not exists 'AllowIdentityToCreatePortfolios' after 'FundsMovedBetweenPortfolios';
alter type "8f5a39c8ee" add value if not exists 'RevokeCreatePortfoliosPermission' after 'AllowIdentityToCreatePortfolios';
