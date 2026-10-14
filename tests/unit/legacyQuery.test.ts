import '@subql/types-core/dist/global';
import '@subql/types/dist/global';
import { findStorage, legacyQuery } from '../../src/utils';

describe('legacyQuery', () => {
  afterEach(() => {
    (api.query as any) = {};
  });

  test('throws when the entry is absent from the block metadata', () => {
    expect(() => legacyQuery('multiSig', 'proposalDetail', [0, 6_999_999])).toThrow(
      /multiSig.proposalDetail/
    );
  });

  test('throws when the pallet itself is absent', () => {
    expect(() => legacyQuery('nonexistentPallet', 'thing', [0, 1])).toThrow(
      /nonexistentPallet.thing/
    );
  });

  test('returns the storage entry when it is present in metadata', () => {
    const proposalDetail = jest.fn();
    (api.query as any).multiSig = { proposalDetail };

    expect(legacyQuery('multiSig', 'proposalDetail', [0, 6_999_999])).toBe(proposalDetail);
  });
});

describe('findStorage', () => {
  afterEach(() => {
    (api.query as any) = {};
  });

  test('is undefined for an entry or a pallet the block lacks, and the entry when it has it', () => {
    const payee = jest.fn();
    (api.query as any).staking = { payee };

    expect(findStorage('staking', 'payee')).toBe(payee);
    expect(findStorage('staking', 'gone')).toBeUndefined();
    expect(findStorage('gone', 'payee')).toBeUndefined();
  });
});
