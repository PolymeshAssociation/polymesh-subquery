-- update the event types for NFT related asset transactions correctly
update asset_transactions
set event_id = (case 
      when from_portfolio_id is null
        then case when amount is not null then 'Issued' else 'IssuedNFT' end
      when to_portfolio_id is null
        then case when amount is not null then 'Redeemed' else 'RedeemedNFT' end
      end)::"8f5a39c8ee"
where 
  from_portfolio_id is null or to_portfolio_id is null;