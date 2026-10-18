/**
 * Resetting an asset's compliance removes its whole entry on chain, the paused flag with it, and
 * emits only `AssetComplianceReset`.
 */
import { handleComplianceReset } from '../../src/mappings/entities/assets/mapCompliance';
import { codec, mockGetByFields, mockStore, tupleEvent } from './helpers';

const ASSET = `0x${'3f'.repeat(16)}`;
const DID = `0x${'01'.repeat(32)}`;

it('resumes a paused asset when its compliance is reset', async () => {
  const db = mockStore({
    Asset: { [ASSET]: { id: ASSET, isCompliancePaused: true } },
    Compliance: { [`${ASSET}/0`]: { id: `${ASSET}/0`, assetId: ASSET } },
  });
  mockGetByFields(db, 'Compliance');
  (globalThis as any).store.bulkRemove = jest.fn(async (entity: string, ids: string[]) =>
    ids.forEach(id => delete db[entity][id])
  );

  await handleComplianceReset(
    tupleEvent({
      section: 'complianceManager',
      method: 'AssetComplianceReset',
      data: [codec(DID), codec(ASSET)],
    })
  );

  expect(db.Asset[ASSET]).toMatchObject({ isCompliancePaused: false });
  expect(db.Compliance).toEqual({});
});
