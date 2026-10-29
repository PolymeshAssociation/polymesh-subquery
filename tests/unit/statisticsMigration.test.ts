/**
 * 5.0's statistics `migrate_v1` turned each asset's active transfer managers into transfer
 * conditions, the statistics they need and the exemptions they carried, with no event. The index
 * replays the 4.x transfer-manager events it stored to apply the same conversion at the upgrade.
 */
import { migrateTransferManagers } from '../../src/mappings/migrations/statisticsMigration';
import { mockStore } from './helpers';

/** "NEWX" and the asset id 7.0 later gave it, which the index keys it by from the start */
const NEWX = 'NEWX';
const NEWX_ID = '0x01a51ab4975b8e58ba628d573cce6419';
const SCOPE = '0x79256ced38797955f01140b28e41e3de94ebb56998fa6d141e2e570a1956b118';
const OTHER_SCOPE = '0x35456a7371666d59344a714d537274375951436533696635444b344672473938';
const EVENT = '0004397818/0000000002';

let n = 0;
/** A stored 4.x statistics event, as `handleEvent` keeps it */
const stored = (
  eventId: string,
  args: Record<string, unknown>
): [string, Record<string, unknown>] => {
  n += 1;
  const id = `000000${String(1000 + n).padStart(4, '0')}/0000000001`;
  return [id, { id, moduleId: 'statistics', eventId, args: { callerDid: '0x01', ...args } }];
};

const migrate = async (events: [string, Record<string, unknown>][]) => {
  const db = mockStore({ Event: Object.fromEntries(events) });
  await migrateTransferManagers(EVENT);
  return db;
};

describe('migrateTransferManagers', () => {
  it('writes each active manager as the condition, statistic and exemptions 5.0 gave it', async () => {
    const db = await migrate([
      stored('TransferManagerAdded', {
        ticker: NEWX,
        transferManager: { CountTransferManager: '10' },
      }),
      stored('TransferManagerAdded', {
        ticker: NEWX,
        transferManager: { PercentageTransferManager: '490000' },
      }),
      stored('ExemptionsAdded', {
        ticker: NEWX,
        transferManager: { PercentageTransferManager: '490000' },
        scopeIds: [SCOPE, OTHER_SCOPE],
      }),
      stored('ExemptionsRemoved', {
        ticker: NEWX,
        transferManager: { PercentageTransferManager: '490000' },
        scopeIds: [OTHER_SCOPE],
      }),
    ]);

    expect(db.TransferCompliance).toEqual({
      [`${NEWX_ID}/Count/10`]: expect.objectContaining({
        assetId: NEWX_ID,
        type: 'MaxInvestorCount',
        statTypeId: `${NEWX_ID}/Count`,
        value: BigInt(10),
        createdEventId: EVENT,
      }),
      [`${NEWX_ID}/Balance/490000`]: expect.objectContaining({
        type: 'MaxInvestorOwnership',
        statTypeId: `${NEWX_ID}/Balance`,
        value: BigInt(490_000),
      }),
    });
    expect(Object.keys(db.StatType).sort()).toEqual([`${NEWX_ID}/Balance`, `${NEWX_ID}/Count`]);
    expect(db.TransferComplianceExemption).toEqual({
      [`${NEWX_ID}/Balance/null/${SCOPE}`]: expect.objectContaining({
        assetId: NEWX_ID,
        opType: 'Balance',
        exemptedEntityId: SCOPE,
      }),
    });
  });

  it('leaves out a manager that was removed', async () => {
    const db = await migrate([
      stored('TransferManagerAdded', {
        ticker: NEWX,
        transferManager: { CountTransferManager: '10' },
      }),
      stored('TransferManagerRemoved', {
        ticker: NEWX,
        transferManager: { CountTransferManager: '10' },
      }),
    ]);

    expect(db.TransferCompliance).toBeUndefined();
    expect(db.StatType).toBeUndefined();
  });

  /** 4.x `remove_transfer_manager` left its exemptions, so a manager added again had them back */
  it('keeps the exemptions a manager had before it was removed and added again', async () => {
    const manager = { CountTransferManager: '40' };
    const db = await migrate([
      stored('TransferManagerAdded', { ticker: NEWX, transferManager: manager }),
      stored('ExemptionsAdded', { ticker: NEWX, transferManager: manager, scopeIds: [SCOPE] }),
      stored('TransferManagerRemoved', { ticker: NEWX, transferManager: manager }),
      stored('TransferManagerAdded', { ticker: NEWX, transferManager: manager }),
    ]);

    expect(Object.keys(db.TransferComplianceExemption)).toEqual([`${NEWX_ID}/Count/null/${SCOPE}`]);
  });
});
