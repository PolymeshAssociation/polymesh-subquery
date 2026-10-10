/**
 * `readChainHolds` (src/mappings/entities/identities/ledgerCore.ts) on testnet's leftover `contracts`
 * holds: `revive` replaced `contracts` at pallet index 46 in spec 8000020, the metadata lists 46 as
 * `unused46` with no inner reason, and the typed decode of a list holding one fails. Seeding a
 * partial index past that block stopped at its first block on exactly this.
 */
import { bnToU8a, u8aConcat } from '@polkadot/util';
import { readChainHolds } from '../../src/mappings/entities/identities/ledgerCore';
import { HoldReason } from '../../src/types';

const ACCOUNT = '5CBCmSoCYUa54FXx4sPFFMMHW27WYCf7AHHdWrzJbKX3sg7E';
const BLOCK_HASH = `0x${'ab'.repeat(32)}`;
const STAKING = 17;

const entry = (pallet: number, reason: number, amount: bigint) =>
  u8aConcat(new Uint8Array([pallet, reason]), bnToU8a(amount, { bitLength: 128 }));

/** `compact(count)` then the entries, as the chain stores a `Vec` of holds. */
const holdsBytes = (...entries: Uint8Array[]) =>
  u8aConcat(new Uint8Array([entries.length << 2]), ...entries);

const mockChain = (bytes: Uint8Array | undefined, typed: () => Promise<unknown>) => {
  const getStorage = jest
    .fn()
    .mockResolvedValue(
      bytes
        ? { isNone: false, unwrap: () => ({ toU8a: () => bytes }) }
        : { isNone: true, unwrap: () => undefined }
    );
  const holds = Object.assign(jest.fn(typed), { key: jest.fn(() => '0xholdskey') });
  (globalThis as any).api.query = { balances: { holds } };
  (globalThis as any).api.rpc = { state: { getStorage } };
  (globalThis as any).api.registry = {
    metadata: {
      pallets: [
        { index: { toNumber: () => STAKING }, name: { toString: () => 'Staking' } },
        { index: { toNumber: () => 60 }, name: { toString: () => 'Revive' } },
      ],
    },
  };
  return { getStorage, holds };
};

const undecodable = () =>
  Promise.reject(new Error("createType(Lookup704):: Decoded input doesn't match input"));

describe('readChainHolds', () => {
  it('reads a list the typed decode rejects from raw storage, at the given block', async () => {
    const { getStorage } = mockChain(
      holdsBytes(entry(46, 1, BigInt(5_009_999)), entry(STAKING, 0, BigInt(1_000_000))),
      undecodable
    );

    const holds = await readChainHolds(ACCOUNT, BLOCK_HASH);

    expect(getStorage).toHaveBeenCalledWith('0xholdskey', BLOCK_HASH);
    expect(holds).toEqual([
      { reason: HoldReason.Unknown, amount: BigInt(5_009_999) },
      { reason: HoldReason.Staking, amount: BigInt(1_000_000) },
    ]);
  });

  it('still fails when the raw bytes do not fit the hold layout either', async () => {
    const bytes = holdsBytes(entry(46, 1, BigInt(1)));
    mockChain(u8aConcat(bytes, new Uint8Array([0])), undecodable);

    await expect(readChainHolds(ACCOUNT, BLOCK_HASH)).rejects.toThrow('does not decode');
  });

  it('fails as before without a block to read raw storage at', async () => {
    mockChain(holdsBytes(entry(46, 1, BigInt(1))), undecodable);

    await expect(readChainHolds(ACCOUNT)).rejects.toThrow('Lookup704');
  });

  it('decodes a list the metadata describes as before', async () => {
    const { getStorage } = mockChain(undefined, () =>
      Promise.resolve({
        toJSON: () => [{ id: { staking: 'Staking' }, amount: '0x' + '00'.repeat(15) + '2a' }],
      })
    );

    expect(await readChainHolds(ACCOUNT, BLOCK_HASH)).toEqual([
      { reason: HoldReason.Staking, amount: BigInt(42) },
    ]);
    expect(getStorage).not.toHaveBeenCalled();
  });
});
