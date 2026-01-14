/**
 * Unit tests for mapPolyxTransaction parameter extraction logic.
 *
 * These tests verify the core logic for handling 8.x chain staking event parameters
 * using the extract8xStakingAmount utility function from common.ts.
 *
 * The actual parameter extraction logic tested here:
 * - On 8.x chain, Rewarded event has [stash, dest, amount] where dest is RewardDestination enum
 * - On 8.x chain, Bonded/Unbonded have [stash, amount]
 * - The code detects if second param is numeric to determine which param holds the amount
 */

import { Codec } from '@polkadot/types/types';
import { extract8xStakingAmount } from '../../src/utils/common';

/**
 * Helper that wraps extract8xStakingAmount to return address too (for test compatibility)
 */
const extractAmountFrom8xParams = (params: Codec[]): { address: string; amount: bigint } => {
  const [rawAddress, rawSecondParam, rawThirdParam] = params;
  return {
    address: getTextValue(rawAddress),
    amount: extract8xStakingAmount(rawSecondParam, rawThirdParam),
  };
};

/**
 * Pre-8.x parameter extraction logic
 */
const extractAmountFromPre8xParams = (
  params: Codec[]
): { identityId: string; address: string; amount: bigint } => {
  const [rawDid, rawAddress, rawBalance] = params;
  return {
    identityId: getTextValue(rawDid),
    address: getTextValue(rawAddress),
    amount: getBigIntValue(rawBalance),
  };
};

describe('mapPolyxTransaction parameter extraction logic', () => {
  describe('8.x chain - Bonded/Unbonded events (2 params)', () => {
    it('should extract amount from second param when it is numeric', () => {
      const params = [createMockCodec(TEST_ADDRESS), createMockCodec('1000000000000')];
      const result = extractAmountFrom8xParams(params);

      expect(result.address).toBe(TEST_ADDRESS);
      expect(result.amount).toBe(BigInt('1000000000000'));
    });

    it.each([
      ['zero', '0', BigInt(0)],
      ['small', '1', BigInt(1)],
      ['large', '999999999999999999999999', BigInt('999999999999999999999999')],
    ])('should handle %s amount', (_name, amountStr, expected) => {
      const params = [createMockCodec(TEST_ADDRESS), createMockCodec(amountStr)];
      const result = extractAmountFrom8xParams(params);
      expect(result.amount).toBe(expected);
    });
  });

  describe('8.x chain - Rewarded event with RewardDestination (3 params)', () => {
    it.each(REWARD_DESTINATIONS)(
      'should extract amount from third param when second param is "%s"',
      rewardDest => {
        const params = [
          createMockCodec(TEST_ADDRESS),
          createMockCodec(rewardDest),
          createMockCodec('5000000000000'),
        ];
        const result = extractAmountFrom8xParams(params);

        expect(result.address).toBe(TEST_ADDRESS);
        expect(result.amount).toBe(BigInt('5000000000000'));
      }
    );
  });

  describe('8.x chain - edge cases', () => {
    it('should return 0 when second param is non-numeric and third param is missing', () => {
      const params = [createMockCodec(TEST_ADDRESS), createMockCodec('UnknownEnum')];
      const result = extractAmountFrom8xParams(params);
      expect(result.amount).toBe(BigInt(0));
    });

    it('should not match strings with numeric prefix but non-numeric suffix', () => {
      const params = [
        createMockCodec(TEST_ADDRESS),
        createMockCodec('123abc'),
        createMockCodec('8000000000000'),
      ];
      const result = extractAmountFrom8xParams(params);
      expect(result.amount).toBe(BigInt('8000000000000'));
    });
  });

  describe('pre-8.x chain parameter extraction', () => {
    it('should extract identityId from first param and amount from third param', () => {
      const params = [
        createMockCodec(TEST_DID),
        createMockCodec(TEST_ADDRESS),
        createMockCodec('9000000000000'),
      ];
      const result = extractAmountFromPre8xParams(params);

      expect(result.identityId).toBe(TEST_DID);
      expect(result.address).toBe(TEST_ADDRESS);
      expect(result.amount).toBe(BigInt('9000000000000'));
    });
  });

  describe('Numeric detection regex', () => {
    it.each([
      ['0', true],
      ['1', true],
      ['123456789', true],
      ['999999999999999999999999', true],
      ...REWARD_DESTINATIONS.map(v => [v, false] as [string, boolean]),
      ['123abc', false],
      ['abc123', false],
      ['', false],
      [' 123', false],
      ['123 ', false],
    ])('isNumericString("%s") should be %s', (value, expected) => {
      expect(isNumericString(value)).toBe(expected);
    });
  });

  describe('extract8xStakingAmount utility function', () => {
    it('should return amount from second param when numeric (Bonded/Unbonded)', () => {
      const rawSecondParam = createMockCodec('1000000000000');
      expect(extract8xStakingAmount(rawSecondParam)).toBe(BigInt('1000000000000'));
    });

    it('should return amount from third param when second is non-numeric (Rewarded)', () => {
      const rawSecondParam = createMockCodec('Staked');
      const rawThirdParam = createMockCodec('2000000000000');
      expect(extract8xStakingAmount(rawSecondParam, rawThirdParam)).toBe(BigInt('2000000000000'));
    });

    it('should return 0 when second is non-numeric and third is undefined', () => {
      const rawSecondParam = createMockCodec('Controller');
      expect(extract8xStakingAmount(rawSecondParam, undefined)).toBe(BigInt(0));
    });

    it('should handle all RewardDestination enum values', () => {
      const expectedAmount = BigInt('5000000000000');
      REWARD_DESTINATIONS.forEach(enumValue => {
        const rawSecondParam = createMockCodec(enumValue);
        const rawThirdParam = createMockCodec('5000000000000');
        expect(extract8xStakingAmount(rawSecondParam, rawThirdParam)).toBe(expectedAmount);
      });
    });

    it('should handle zero balance', () => {
      const rawSecondParam = createMockCodec('0');
      expect(extract8xStakingAmount(rawSecondParam)).toBe(BigInt(0));
    });
  });
});
