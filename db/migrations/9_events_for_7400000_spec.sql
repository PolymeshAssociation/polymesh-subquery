alter type "0bf3c7d4ef" add value if not exists 'receiver_affirm_asset_transfer' after 'update_global_metadata_spec';
alter type "0bf3c7d4ef" add value if not exists 'reject_asset_transfer' after 'receiver_affirm_asset_transfer';
alter type "0bf3c7d4ef" add value if not exists 'transfer_asset' after 'reject_asset_transfer';

alter type "8f5a39c8ee" add value if not exists 'CreatedAssetTransfer' after 'GlobalMetadataSpecUpdated';
