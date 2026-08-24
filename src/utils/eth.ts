import { decodeAddress, encodeAddress } from '@polkadot/keyring';
import { hexToU8a } from '@polkadot/util';
import { ethereumEncode, keccakAsU8a } from '@polkadot/util-crypto';

/**
 * `pallet_revive` derives a substrate account for an Ethereum key by right padding the 20 byte
 * address with 12 `0xEE` bytes. See `AccountId32Mapper::to_fallback_account_id`
 */
export const ETH_ACCOUNT_SUFFIX = new Uint8Array(12).fill(0xee);

/**
 * The address `pallet_revive` reserves for calls into the substrate runtime.
 *
 * Computed with `PalletId(*b"py/paddr").into_account_truncating()`. An Ethereum wallet dispatches a
 * `RuntimeCall` by sending a zero value transaction to this address with the SCALE encoded call as
 * its calldata
 */
export const RUNTIME_PALLETS_ADDR = '0x6d6f646c70792f70616464720000000000000000';

const ACCOUNT_ID_LENGTH = 32;
const H160_LENGTH = 20;
const KECCAK_ADDRESS_OFFSET = 12;

const tryDecodeAddress = (address: string, ss58Format?: number): Uint8Array | undefined => {
  try {
    return decodeAddress(address, false, ss58Format);
  } catch {
    return undefined;
  }
};

/**
 * Converts an Ethereum address into the SS58 account `pallet_revive` dispatches it as
 */
export const ss58FromEthAddress = (h160: string, ss58Format?: number): string => {
  const accountId = new Uint8Array(ACCOUNT_ID_LENGTH);
  accountId.set(hexToU8a(h160), 0);
  accountId.set(ETH_ACCOUNT_SUFFIX, H160_LENGTH);

  return encodeAddress(accountId, ss58Format);
};

/**
 * Returns true when the given address is an Ethereum key's `0xEE` padded account
 */
export const isEthDerivedAddress = (address: string, ss58Format?: number): boolean => {
  const decoded = tryDecodeAddress(address, ss58Format);

  if (!decoded || decoded.length !== ACCOUNT_ID_LENGTH) {
    return false;
  }

  return decoded.subarray(H160_LENGTH).every(byte => byte === 0xee);
};

/**
 * Recovers the checksummed Ethereum address from a `0xEE` padded SS58 account
 *
 * @throws if the address is not Ethereum derived
 */
export const ethAddressFromSs58 = (address: string, ss58Format?: number): string => {
  if (!isEthDerivedAddress(address, ss58Format)) {
    throw new Error(`"${address}" is not an Ethereum derived address`);
  }

  return ethereumEncode(decodeAddress(address, false, ss58Format).subarray(0, H160_LENGTH));
};

/**
 * Returns the checksummed H160 that `pallet_revive` addresses the given account by.
 *
 * Mirrors `AccountId32Mapper::to_address` - Ethereum derived accounts drop their `0xEE` padding,
 * every other account is hashed and truncated
 */
export const evmAddressFromSs58 = (address: string, ss58Format?: number): string | undefined => {
  const decoded = tryDecodeAddress(address, ss58Format);

  if (!decoded || decoded.length !== ACCOUNT_ID_LENGTH) {
    return undefined;
  }

  if (decoded.subarray(H160_LENGTH).every(byte => byte === 0xee)) {
    return ethereumEncode(decoded.subarray(0, H160_LENGTH));
  }

  return ethereumEncode(keccakAsU8a(decoded).subarray(KECCAK_ADDRESS_OFFSET));
};
