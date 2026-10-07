/**
 * `getCustomType` reads the already-indexed `CustomAssetType` entity (populated by
 * `CustomAssetTypeRegistered`/`Exists`) instead of an unconditional chain read — a chain read is
 * a fallback for the case that shouldn't happen (a type used before its registration was
 * indexed), and that fallback records an anomaly rather than silently trusting the read.
 */
import { Codec } from '@polkadot/types/types';
import { SubstrateBlock } from '@subql/types';
import { getCustomType } from '../../src/utils/assets';
import { codec, mockStore } from './helpers';

const blockAt = (blockNumber: number): SubstrateBlock =>
  ({
    block: { header: { number: { toString: () => `${blockNumber}` } } },
    specVersion: 7_004_000,
    timestamp: new Date('2024-01-01T00:00:00.000Z'),
  } as unknown as SubstrateBlock);

describe('getCustomType', () => {
  it('reads the name from the indexed CustomAssetType without touching the chain', async () => {
    const db = mockStore({
      CustomAssetType: { '3': { id: '3', name: 'MyCustomType' } },
    });
    (globalThis as any).api.query = {
      asset: { customTypes: jest.fn().mockRejectedValue(new Error('should not be called')) },
    };

    const name = await getCustomType(codec(3) as unknown as Codec, blockAt(500));

    expect(name).toBe('MyCustomType');
    expect(Object.keys(db.IndexerAnomaly ?? {})).toHaveLength(0);
  });

  it('falls back to a chain read and records an anomaly when the type is not yet indexed', async () => {
    const db = mockStore();
    (globalThis as any).api.query = {
      asset: {
        customTypes: jest.fn().mockResolvedValue({ toString: () => '0x4c6567616379' }),
      },
    };

    const name = await getCustomType(codec(9) as unknown as Codec, blockAt(500));

    expect(name).toBe('Legacy');
    expect(Object.keys(db.IndexerAnomaly ?? {})).toHaveLength(1);
    expect(Object.values(db.IndexerAnomaly)[0].detail).toMatch(/registered on chain/);
  });

  /**
   * The chain did not check a custom type id when an NFT collection was created — testnet has
   * collections naming id 0, never registered, and id 100 long before it was. The chain answers
   * with empty bytes, which used to be written as an asset type of `''`: a name that happens to be
   * blank, rather than an unknown one.
   */
  it('leaves the type unknown, not blank, when the chain has not registered it either', async () => {
    const db = mockStore();
    (globalThis as any).api.query = {
      asset: { customTypes: jest.fn().mockResolvedValue({ toString: () => '0x' }) },
    };

    const name = await getCustomType(codec(0) as unknown as Codec, blockAt(12_029_979));

    expect(name).toBeUndefined();
    expect(Object.values(db.IndexerAnomaly)[0].detail).toMatch(/has not registered/);
  });
});
