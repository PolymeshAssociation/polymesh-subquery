/**
 * `extract8xStakingAmount` — on a v8 chain a staking event is `[stash, amount]` (Bonded/Unbonded)
 * or `[stash, dest, amount]` (Rewarded, where `dest` is a `RewardDestination` enum). The amount's
 * position is decided by whether the second parameter renders as a bare number.
 *
 * (These tests moved here from the deleted `mapPolyxTransaction.test.ts` when the POLYX ledger
 * replaced that module; the helper itself still lives in `src/utils/common.ts`.)
 */

import { extract8xStakingAmount } from '../../src/utils/common';

describe('extract8xStakingAmount', () => {
  it('returns the amount from the second param when it is numeric (Bonded/Unbonded)', () => {
    expect(extract8xStakingAmount(createMockCodec('1000000000000'))).toBe(BigInt('1000000000000'));
  });

  it('returns the amount from the third param when the second is a RewardDestination', () => {
    expect(
      extract8xStakingAmount(createMockCodec('Staked'), createMockCodec('2000000000000'))
    ).toBe(BigInt('2000000000000'));
  });

  it('returns 0 when the second param is non-numeric and there is no third param', () => {
    expect(extract8xStakingAmount(createMockCodec('Controller'), undefined)).toBe(BigInt(0));
  });

  it('handles every RewardDestination enum value', () => {
    REWARD_DESTINATIONS.forEach(dest => {
      expect(extract8xStakingAmount(createMockCodec(dest), createMockCodec('5000000000000'))).toBe(
        BigInt('5000000000000')
      );
    });
  });

  it('handles a zero amount', () => {
    expect(extract8xStakingAmount(createMockCodec('0'))).toBe(BigInt(0));
  });

  it('does not treat a numeric-prefixed string as the amount', () => {
    expect(
      extract8xStakingAmount(createMockCodec('123abc'), createMockCodec('8000000000000'))
    ).toBe(BigInt('8000000000000'));
  });
});
