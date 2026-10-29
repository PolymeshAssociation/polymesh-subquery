/**
 * `getCustomType` reads the indexed `CustomAssetType`, which the seed and
 * `CustomAssetTypeRegistered` write, and never the chain.
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

  /**
   * The seed writes every registered type, so one the index lacks is one the chain never
   * registered: testnet has NFT collections naming id 0, never registered, and id 100 long before
   * it was, as the chain didn't check the id.
   */
  it('leaves the type unknown, with an anomaly, when the index holds no such type', async () => {
    const db = mockStore();
    (globalThis as any).api.query = {
      asset: { customTypes: jest.fn().mockRejectedValue(new Error('should not be called')) },
    };

    const name = await getCustomType(codec(0) as unknown as Codec, blockAt(12_029_979));

    expect(name).toBeUndefined();
    expect(Object.values(db.IndexerAnomaly)[0].detail).toMatch(/no CustomAssetType 0/);
  });
});
