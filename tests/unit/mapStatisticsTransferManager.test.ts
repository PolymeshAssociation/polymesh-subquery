/**
 * Regression test for retiring the `TransferManager` dual model (docs/implementation/08-external-agents.md
 * §8.2): `TransferManager` and its writer (`mapTransferManager.ts`) are gone, but the
 * `statistics.TransferManagerAdded` / `ExemptionsAdded` / `ExemptionsRemoved` events still feed
 * `StatType` / `TransferComplianceExemption` for the pre-v5 percentage/count restriction model via
 * `handleStatisticTransferManagerAdded` and friends — this covers that the surviving handler still
 * works with `TransferManager` gone.
 */
import { handleStatisticTransferManagerAdded } from '../../src/mappings/entities/assets/mapStatistics';
import { codec, mockStore, tupleEvent } from './helpers';

const ASSET_ID = '0xassetstattm00000000000000000000000';

describe('handleStatisticTransferManagerAdded', () => {
  it('writes a Balance StatType for a Percentage restriction — no TransferManager entity exists to write', async () => {
    const db = mockStore();

    await handleStatisticTransferManagerAdded(
      tupleEvent({
        section: 'statistics',
        method: 'TransferManagerAdded',
        data: [codec(TEST_DID), codec(ASSET_ID), codec({ percentageTransferManager: 10 })],
      })
    );

    const [statType] = Object.values(db.StatType) as any[];

    expect(statType).toMatchObject({ assetId: ASSET_ID, opType: 'Balance' });
    // `TransferManager` was removed from the schema — a stray write would fail codegen/typecheck
    // long before this test runs; this just documents the invariant.
    expect(db.TransferManager).toBeUndefined();
  });

  it('writes nothing for a Count restriction', async () => {
    const db = mockStore();

    await handleStatisticTransferManagerAdded(
      tupleEvent({
        section: 'statistics',
        method: 'TransferManagerAdded',
        data: [codec(TEST_DID), codec(ASSET_ID), codec({ countTransferManager: 5 })],
      })
    );

    expect(db.StatType ?? {}).toEqual({});
  });
});
