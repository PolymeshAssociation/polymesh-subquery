-- Consistency checks for settlement approvals, run against a synced database with the
-- project's schema on the search path. Each query returns no rows when the index is consistent;
-- every row it returns is one inconsistency. Only current row versions are read.

-- The on-chain holders on each instruction's legs: a portfolio (`did/number`) or an account.
-- Off-chain legs hold nothing on chain.
CREATE TEMP VIEW leg_holders AS
SELECT instruction_id, coalesce(from_account_id, from_portfolio_id) AS holder
FROM legs
WHERE upper_inf(_block_range) AND leg_type <> 'OffChain'
UNION
SELECT instruction_id, coalesce(to_account_id, to_portfolio_id)
FROM legs
WHERE upper_inf(_block_range) AND leg_type <> 'OffChain';

-- 1. An executed instruction with a holder or mediator still pending.
SELECT i.id AS instruction_id, a.id AS affirmation_id
FROM instructions i
JOIN instruction_affirmations a
  ON a.instruction_id = i.id AND upper_inf(a._block_range)
WHERE upper_inf(i._block_range) AND i.status = 'Executed' AND a.status = 'Pending';

-- 2. A holder on a leg with no approval row.
SELECT h.instruction_id, h.holder
FROM leg_holders h
WHERE h.holder IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM instruction_affirmations a
    WHERE upper_inf(a._block_range) AND a.id = h.instruction_id || '/' || h.holder
  );

-- 3. A holder's approval row whose holder is on none of its instruction's legs.
SELECT a.id
FROM instruction_affirmations a
WHERE upper_inf(a._block_range)
  AND NOT a.is_mediator
  AND a.off_chain_receipt_id IS NULL
  AND NOT EXISTS (
    SELECT 1
    FROM leg_holders h
    WHERE h.instruction_id = a.instruction_id
      AND h.holder = coalesce(a.account_id, a.portfolio_id)
  );

-- 4. An approval row whose party is not in the index.
SELECT a.id, a.party_id
FROM instruction_affirmations a
WHERE upper_inf(a._block_range)
  AND NOT EXISTS (
    SELECT 1
    FROM instruction_parties p
    WHERE p.id = a.party_id AND upper_inf(p._block_range)
  );

-- 5. A rejected instruction with no record of who rejected it.
SELECT id
FROM instructions
WHERE upper_inf(_block_range) AND status = 'Rejected' AND rejected_by_id IS NULL;
