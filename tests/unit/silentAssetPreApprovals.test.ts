/**
 * 6.0.0 and 6.0.1 pre-approve a ticker, and take the pre-approval away, with no event; the
 * `PreApprovedAsset` and `RemovePreApprovedAsset` events arrived in 6.1.0. The calls stand in.
 */
import { stringToHex } from '@polkadot/util';
import { handleSilentAssetPreApproval } from '../../src/mappings/entities/assets/mapAsset';
import { getAssetIdForLegacyTicker } from '../../src/utils/assets';
import { codec, mockStore } from './helpers';

const ALICE = '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY';
const TICKER = stringToHex('4ITEST'.padEnd(12, '\0'));

const call = (method: string, specVersion: number) =>
  ({
    idx: 1,
    block: {
      block: {
        header: {
          number: { toString: () => '5000' },
          parentHash: '0xparent',
          hash: { toHex: () => '0xhash5000' },
        },
      },
      timestamp: new Date('2024-01-01T00:00:00Z'),
      specVersion,
      events: [
        {
          phase: { isApplyExtrinsic: true, asApplyExtrinsic: { toNumber: () => 1 } },
          event: { section: 'system', method: 'ExtrinsicSuccess', data: [], meta: { fields: [] } },
        },
      ],
    },
    extrinsic: {
      signer: { toString: () => ALICE },
      method: { section: 'asset', method, args: [codec(TICKER)] },
    },
    success: true,
  } as any);

const chainAt = (specVersion: number) => {
  const g = globalThis as any;
  g.api.rpc = {
    state: {
      getRuntimeVersion: jest.fn(async () => ({ specVersion: { toNumber: () => specVersion } })),
    },
  };
  g.api.runtimeVersion = { specName: { toString: () => 'polymesh_testnet' } };
  g.api.query = {
    identity: {
      keyRecords: jest.fn(async () => ({
        isEmpty: false,
        unwrap: () => ({ isPrimaryKey: true, asPrimaryKey: { toString: () => TEST_DID } }),
      })),
    },
  };
};

describe('a ticker pre-approval in 6.0, which emitted no event', () => {
  it('is recorded from the call', async () => {
    const db = mockStore();
    chainAt(6_000_004);

    await handleSilentAssetPreApproval(call('preApproveTicker', 6_000_004));

    const assetId = await getAssetIdForLegacyTicker(TICKER);
    expect(db.AssetPreApproval?.[`${assetId}/${TEST_DID}`]).toMatchObject({
      assetId,
      identityId: TEST_DID,
      createdEventId: '0000005000/0000000000',
    });
  });

  it('is removed by the call that takes it away', async () => {
    const assetId = await getAssetIdForLegacyTicker(TICKER);
    const db = mockStore({ AssetPreApproval: { [`${assetId}/${TEST_DID}`]: { id: 'x' } } });
    chainAt(6_000_004);

    await handleSilentAssetPreApproval(call('removeTickerPreApproval', 6_000_004));

    expect(db.AssetPreApproval[`${assetId}/${TEST_DID}`]).toBeUndefined();
  });

  it('is left to its event from 6.1', async () => {
    const db = mockStore();
    chainAt(6_001_000);

    await handleSilentAssetPreApproval(call('preApproveTicker', 6_001_000));

    expect(db.AssetPreApproval ?? {}).toEqual({});
  });
});
