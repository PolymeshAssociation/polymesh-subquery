/**
 * Resetting an asset's compliance removes its whole entry on chain, the paused flag with it, and
 * emits only `AssetComplianceReset`.
 */
import {
  handleComplianceChanged,
  handleComplianceReset,
} from '../../src/mappings/entities/assets/mapCompliance';
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

/** `change_compliance_requirement` replaces one requirement in place, keeping its id */
it('replaces a requirement when it is changed', async () => {
  const conditions = (scope: Record<string, string>) => ({
    senderConditions: [{ conditionType: { isPresent: { accredited: scope } }, issuers: [] }],
    receiverConditions: [],
  });
  const db = mockStore({
    Compliance: {
      [`${ASSET}/1`]: {
        id: `${ASSET}/1`,
        assetId: ASSET,
        complianceId: 1,
        data: JSON.stringify(conditions({ asset: ASSET })),
        createdEventId: '0000000900/0000000001',
        updatedEventId: '0000000900/0000000001',
      },
    },
  });
  const identityScope = { identity: `0x${'05'.padEnd(64, '0')}` };

  await handleComplianceChanged(
    tupleEvent({
      section: 'complianceManager',
      method: 'ComplianceRequirementChanged',
      data: [codec(DID), codec(ASSET), codec({ id: 1, ...conditions(identityScope) })],
    })
  );

  expect(db.Compliance[`${ASSET}/1`]).toMatchObject({
    complianceId: 1,
    createdEventId: '0000000900/0000000001',
    updatedEventId: '0000001000/0000000000',
  });
  expect(JSON.parse(db.Compliance[`${ASSET}/1`].data)).toEqual(conditions(identityScope));
});
