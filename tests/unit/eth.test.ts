import {
  ethAddressFromSs58,
  evmAddressFromSs58,
  isEthDerivedAddress,
  ss58FromEthAddress,
} from '../../src/utils/eth';

/**
 * Vectors are mirrored from `@polymeshassociation/eth-signing-manager` and the Polymesh SDK's
 * `src/utils/eth.ts`. If any of these drift the three implementations no longer agree on which
 * account an Ethereum key acts as
 */
const ETH_ADDRESS = '0xf24FF3a9CF04c71Dbc94D0b566f7A27B94566cac';
const SS58_ADDRESS = '5HYRCKHYJN9z5xUtfFkyMj4JUhsAwWyvuU8vKB1FcnYTf9ZQ';
const ALICE = '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY';

describe('ss58FromEthAddress', () => {
  it('should pad an Ethereum address with 0xEE bytes', () => {
    expect(ss58FromEthAddress(ETH_ADDRESS, 42)).toEqual(SS58_ADDRESS);
  });

  it('should encode with the given SS58 format', () => {
    expect(ss58FromEthAddress(ETH_ADDRESS, 12)).not.toEqual(SS58_ADDRESS);
    expect(ethAddressFromSs58(ss58FromEthAddress(ETH_ADDRESS, 12), 12)).toEqual(ETH_ADDRESS);
  });

  it('should accept a lower cased address and return a checksummed one', () => {
    expect(ethAddressFromSs58(ss58FromEthAddress(ETH_ADDRESS.toLowerCase(), 42), 42)).toEqual(
      ETH_ADDRESS
    );
  });
});

describe('isEthDerivedAddress', () => {
  it('should detect 0xEE padded accounts', () => {
    expect(isEthDerivedAddress(SS58_ADDRESS, 42)).toBe(true);
  });

  it('should return false for a regular substrate account', () => {
    expect(isEthDerivedAddress(ALICE, 42)).toBe(false);
  });

  it('should return false for an undecodable address', () => {
    expect(isEthDerivedAddress('not an address', 42)).toBe(false);
  });
});

describe('ethAddressFromSs58', () => {
  it('should strip the 0xEE padding', () => {
    expect(ethAddressFromSs58(SS58_ADDRESS, 42)).toEqual(ETH_ADDRESS);
  });

  it('should throw for a non Ethereum derived address', () => {
    expect(() => ethAddressFromSs58(ALICE, 42)).toThrow('is not an Ethereum derived address');
  });
});

describe('evmAddressFromSs58', () => {
  it('should strip the padding for an Ethereum derived account', () => {
    expect(evmAddressFromSs58(SS58_ADDRESS, 42)).toEqual(ETH_ADDRESS);
  });

  it('should hash a regular substrate account', () => {
    // keccak256(<Alice's public key>)[12..], matching `AccountId32Mapper::to_address`
    expect(evmAddressFromSs58(ALICE, 42)).toEqual('0x9621DDe636dE098B43Efb0fA9b61fAcFE328F99D');
  });

  it('should return undefined for an undecodable address', () => {
    expect(evmAddressFromSs58('not an address', 42)).toBeUndefined();
  });
});
