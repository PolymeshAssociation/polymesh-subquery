ALTER TYPE "0bf3c7d4ef" ADD VALUE IF NOT EXISTS 'add_mediator_account' AFTER 'redeem_nft';
ALTER TYPE "0bf3c7d4ef" ADD VALUE IF NOT EXISTS 'create_confidential_asset' AFTER 'add_mediator_account';
ALTER TYPE "0bf3c7d4ef" ADD VALUE IF NOT EXISTS 'mint_confidential_asset' AFTER 'create_confidential_asset';
ALTER TYPE "0bf3c7d4ef" ADD VALUE IF NOT EXISTS 'add_transaction' AFTER 'mint_confidential_asset';
ALTER TYPE "0bf3c7d4ef" ADD VALUE IF NOT EXISTS 'sender_affirm_transaction' AFTER 'add_transaction';
ALTER TYPE "0bf3c7d4ef" ADD VALUE IF NOT EXISTS 'receiver_affirm_transaction' AFTER 'sender_affirm_transaction';
ALTER TYPE "0bf3c7d4ef" ADD VALUE IF NOT EXISTS 'mediator_affirm_transaction' AFTER 'receiver_affirm_transaction';
ALTER TYPE "0bf3c7d4ef" ADD VALUE IF NOT EXISTS 'sender_unaffirm_transaction' AFTER 'mediator_affirm_transaction';
ALTER TYPE "0bf3c7d4ef" ADD VALUE IF NOT EXISTS 'receiver_unaffirm_transaction' AFTER 'sender_unaffirm_transaction';
ALTER TYPE "0bf3c7d4ef" ADD VALUE IF NOT EXISTS 'mediator_unaffirm_transaction' AFTER 'receiver_unaffirm_transaction';
ALTER TYPE "0bf3c7d4ef" ADD VALUE IF NOT EXISTS 'create_account' AFTER 'mediator_unaffirm_transaction';
ALTER TYPE "0bf3c7d4ef" ADD VALUE IF NOT EXISTS 'affirm_transactions' AFTER 'create_account';
ALTER TYPE "0bf3c7d4ef" ADD VALUE IF NOT EXISTS 'execute_transaction' AFTER 'affirm_transactions';
ALTER TYPE "0bf3c7d4ef" ADD VALUE IF NOT EXISTS 'apply_incoming_balance' AFTER 'execute_transaction';
ALTER TYPE "0bf3c7d4ef" ADD VALUE IF NOT EXISTS 'reject_transaction' AFTER 'apply_incoming_balance';

ALTER TYPE "7a0b4cc03e" ADD VALUE IF NOT EXISTS 'confidentialasset' AFTER 'utility';