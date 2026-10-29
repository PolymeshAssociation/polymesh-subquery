import { accountDataFrozen } from '../../src/mappings/entities/identities/ledgerCore';
import { codec } from './helpers';

describe('accountDataFrozen', () => {
  it('reads the single frozen amount a v8 account carries', () => {
    expect(accountDataFrozen({ free: codec(9), frozen: codec(4) })).toBe(BigInt(4));
  });

  it('takes the larger of the two freezes before v8', () => {
    expect(accountDataFrozen({ miscFrozen: codec(7), feeFrozen: codec(3) })).toBe(BigInt(7));
    expect(accountDataFrozen({ miscFrozen: codec(2), feeFrozen: codec(5) })).toBe(BigInt(5));
  });

  it('counts an absent freeze as nothing frozen', () => {
    expect(accountDataFrozen({ miscFrozen: codec(2) })).toBe(BigInt(2));
    expect(accountDataFrozen({})).toBe(BigInt(0));
  });

  it('refuses a value that is not account data', () => {
    expect(() => accountDataFrozen(undefined)).toThrow(TypeError);
  });
});
