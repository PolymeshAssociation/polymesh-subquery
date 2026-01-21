DO $$
BEGIN
    IF NOT EXISTS (select 1 from pg_type where typname = '04c7376a01') then
        create type "04c7376a01" AS ENUM (
            'SenderAffirmed',
            'SenderReverted',
            'SenderCounterUpdated',
            'MediatorAffirmed',
            'MediatorRejected',
            'ReceiverAffirmed',
            'ReceiverClaimed'
        );
    END IF;
END
$$;

alter type "7a0b4cc03e" add value if not exists 'confidentialassets' after 'validators';

alter type "8f5a39c8ee" add value if not exists 'AccountAssetRegistered' after 'StorageDepositTransferredAndReleased';
alter type "8f5a39c8ee" add value if not exists 'AccountCurveTreeRootUpdated' after 'AccountAssetRegistered';
alter type "8f5a39c8ee" add value if not exists 'AccountRegistered' after 'AccountCurveTreeRootUpdated';
alter type "8f5a39c8ee" add value if not exists 'AccountStateLeafInserted' after 'AccountRegistered';
alter type "8f5a39c8ee" add value if not exists 'AssetCreated' after 'AccountStateLeafInserted';
alter type "8f5a39c8ee" add value if not exists 'AssetCurveTreeRootUpdated' after 'AssetCreated';
alter type "8f5a39c8ee" add value if not exists 'AssetMinted' after 'AssetCurveTreeRootUpdated';
alter type "8f5a39c8ee" add value if not exists 'AssetStateLeafUpdated' after 'AssetMinted';
alter type "8f5a39c8ee" add value if not exists 'AssetUpdated' after 'AssetStateLeafUpdated';
alter type "8f5a39c8ee" add value if not exists 'EncryptionKeyRegistered' after 'AssetUpdated';
alter type "8f5a39c8ee" add value if not exists 'FeeAccountCurveTreeRootUpdated' after 'EncryptionKeyRegistered';
alter type "8f5a39c8ee" add value if not exists 'FeeAccountDeposited' after 'FeeAccountCurveTreeRootUpdated';
alter type "8f5a39c8ee" add value if not exists 'FeeAccountStateLeafInserted' after 'FeeAccountDeposited';
alter type "8f5a39c8ee" add value if not exists 'FeeAccountUpdated' after 'FeeAccountStateLeafInserted';
alter type "8f5a39c8ee" add value if not exists 'FeeAccountWithdrawn' after 'FeeAccountUpdated';
alter type "8f5a39c8ee" add value if not exists 'MediatorAffirmed' after 'FeeAccountWithdrawn';
alter type "8f5a39c8ee" add value if not exists 'MediatorRejected' after 'MediatorAffirmed';
alter type "8f5a39c8ee" add value if not exists 'ReceiverAffirmed' after 'MediatorRejected';
alter type "8f5a39c8ee" add value if not exists 'ReceiverClaimed' after 'ReceiverAffirmed';
alter type "8f5a39c8ee" add value if not exists 'RelayerBatchedProofs' after 'ReceiverClaimed';
alter type "8f5a39c8ee" add value if not exists 'SenderAffirmed' after 'RelayerBatchedProofs';
alter type "8f5a39c8ee" add value if not exists 'SenderCounterUpdated' after 'SenderAffirmed';
alter type "8f5a39c8ee" add value if not exists 'SenderReverted' after 'SenderCounterUpdated';
alter type "8f5a39c8ee" add value if not exists 'SettlementCreated' after 'SenderReverted';
alter type "8f5a39c8ee" add value if not exists 'SettlementStatusUpdated' after 'SettlementCreated';

alter type "0bf3c7d4ef" add value if not exists 'batched_settlement' after 'ensure_updated';
alter type "0bf3c7d4ef" add value if not exists 'create_asset' after 'batched_settlement';
alter type "0bf3c7d4ef" add value if not exists 'create_settlement' after 'create_asset';
alter type "0bf3c7d4ef" add value if not exists 'execute_instant_settlement' after 'create_settlement';
alter type "0bf3c7d4ef" add value if not exists 'instant_receiver_affirmation' after 'execute_instant_settlement';
alter type "0bf3c7d4ef" add value if not exists 'instant_sender_affirmation' after 'instant_receiver_affirmation';
alter type "0bf3c7d4ef" add value if not exists 'mediator_affirmation' after 'instant_sender_affirmation';
alter type "0bf3c7d4ef" add value if not exists 'mint_asset' after 'mediator_affirmation';
alter type "0bf3c7d4ef" add value if not exists 'receiver_affirmation' after 'mint_asset';
alter type "0bf3c7d4ef" add value if not exists 'receiver_claim' after 'receiver_affirmation';
alter type "0bf3c7d4ef" add value if not exists 'register_account_assets' after 'receiver_claim';
alter type "0bf3c7d4ef" add value if not exists 'register_accounts' after 'register_account_assets';
alter type "0bf3c7d4ef" add value if not exists 'register_encryption_keys' after 'register_accounts';
alter type "0bf3c7d4ef" add value if not exists 'register_fee_accounts' after 'register_encryption_keys';
alter type "0bf3c7d4ef" add value if not exists 'relayer_submit_batched_proofs' after 'register_fee_accounts';
alter type "0bf3c7d4ef" add value if not exists 'sender_affirmation' after 'relayer_submit_batched_proofs';
alter type "0bf3c7d4ef" add value if not exists 'sender_revert' after 'sender_affirmation';
alter type "0bf3c7d4ef" add value if not exists 'sender_update_counter' after 'sender_revert';
alter type "0bf3c7d4ef" add value if not exists 'submit_batched_proofs' after 'sender_update_counter';
alter type "0bf3c7d4ef" add value if not exists 'topup_fee_accounts' after 'submit_batched_proofs';

