/**
 * `getAssetOrAnomaly` (src/mappings/entities/common.ts): an asset the index has never seen, met by an
 * `AssetBalanceUpdated` on an index started after the asset was created, is built from chain storage
 * rather than reported missing and its movement dropped.
 */
import { assetFromChain } from '../../src/mappings/entities/assets/assetFromChain';
import { getAssetOrAnomaly } from '../../src/mappings/entities/common';
import { IndexerAnomaly } from '../../src/types';
import { mockStore, tupleEvent } from './helpers';

jest.mock('../../src/mappings/entities/assets/assetFromChain', () => ({
  assetFromChain: jest.fn(),
}));

const ASSET = '0xcf64'.padEnd(34, '0');
const event = tupleEvent({ section: 'asset', method: 'AssetBalanceUpdated', data: [] });

describe('getAssetOrAnomaly', () => {
  beforeEach(() => {
    mockStore();
    (IndexerAnomaly as unknown as { create: jest.Mock }).create = jest.fn(() => ({
      save: jest.fn(),
    }));
  });

  it('builds an asset the index has not seen from chain storage, given the event', async () => {
    (assetFromChain as jest.Mock).mockResolvedValue({ id: ASSET });

    const asset = await getAssetOrAnomaly(ASSET, { block: event.block, event });

    expect(asset).toEqual({ id: ASSET });
    expect(assetFromChain).toHaveBeenCalledWith(ASSET, event);
  });

  it('records the gap without the event', async () => {
    const asset = await getAssetOrAnomaly(ASSET, { block: event.block });

    expect(asset).toBeUndefined();
    expect(assetFromChain).not.toHaveBeenCalled();
  });
});
