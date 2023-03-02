alter type public_enum_7a0b4cc03e add value if not exists 'nft' after 'testutils';

alter type public_enum_0bf3c7d4ef add value if not exists 'move_portfolio_funds_v2' after 'move_portfolio_funds';
alter type public_enum_0bf3c7d4ef add value if not exists 'add_instruction_with_memo_v2' after 'add_instruction_with_memo';
alter type public_enum_0bf3c7d4ef add value if not exists 'add_and_affirm_instruction_with_memo_v2' after 'add_and_affirm_instruction_with_memo';
alter type public_enum_0bf3c7d4ef add value if not exists 'affirm_instruction_v2' after 'affirm_instruction';
alter type public_enum_0bf3c7d4ef add value if not exists 'withdraw_affirmation_v2' after 'withdraw_affirmation';
alter type public_enum_0bf3c7d4ef add value if not exists 'reject_instruction_v2' after 'reject_instruction';
alter type public_enum_0bf3c7d4ef add value if not exists 'placeholder_claim_receipt' after 'claim_receipt';
alter type public_enum_0bf3c7d4ef add value if not exists 'placeholder_unclaim_receipt' after 'unclaim_receipt';
alter type public_enum_0bf3c7d4ef add value if not exists 'create_nft_collection' after 'get_cdd_of';
alter type public_enum_0bf3c7d4ef add value if not exists 'issue_nft' after 'create_nft_collection';
alter type public_enum_0bf3c7d4ef add value if not exists 'redeem_nft' after 'issue_nft';

alter type public_enum_8f5a39c8ee add value if not exists 'FungibleTokensMovedBetweenPortfolios' after 'MovedBetweenPortfolios';
alter type public_enum_8f5a39c8ee add value if not exists 'NFTsMovedBetweenPortfolios' after 'FungibleTokensMovedBetweenPortfolios';
alter type public_enum_8f5a39c8ee add value if not exists 'InstructionV2Created' after 'InstructionCreated';
alter type public_enum_8f5a39c8ee add value if not exists 'IssuedNFT' after 'CddStatus';
alter type public_enum_8f5a39c8ee add value if not exists 'NftCollectionCreated' after 'IssuedNFT';
alter type public_enum_8f5a39c8ee add value if not exists 'RedeemedNFT' after 'NftCollectionCreated';
