import { HoldReason } from '../../src/types';
import {
  holdReasonFromJson,
  holdReasonVariantOf,
} from '../../src/mappings/entities/identities/ledgerCore';

describe('holdReasonVariantOf', () => {
  it('returns the pallet reason and the unit variant nested under it', () => {
    expect(holdReasonVariantOf({ revive: 'StorageDepositReserve' })).toEqual({
      reason: HoldReason.Revive,
      variant: 'StorageDepositReserve',
    });
  });

  it('has no variant for a bare-string reason', () => {
    expect(holdReasonVariantOf('Staking')).toEqual({
      reason: HoldReason.Staking,
      variant: undefined,
    });
  });

  it('has no variant when the nested value is not a plain string', () => {
    expect(holdReasonVariantOf({ revive: { nested: 1 } }).variant).toBeUndefined();
  });

  it('files an unrecognised or unreadable reason under Unknown', () => {
    expect(holdReasonVariantOf({ nothing: 'Here' }).reason).toBe(HoldReason.Unknown);
    expect(holdReasonVariantOf(null)).toEqual({ reason: HoldReason.Unknown, variant: undefined });
    expect(holdReasonVariantOf([])).toEqual({ reason: HoldReason.Unknown, variant: undefined });
  });

  it('agrees with holdReasonFromJson on the reason', () => {
    const json = { staking: 'Staking' };

    expect(holdReasonVariantOf(json).reason).toBe(holdReasonFromJson(json));
  });
});
