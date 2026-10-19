/**
 * 6.0's settlement migration made each leg it still held off-chain if its ticker was no asset then,
 * fungible otherwise. The index decides a pre-6.0 leg when its instruction is created, so a leg of
 * a ticker that became an asset while its instruction was still pending turns fungible at 6.0.
 */
import { migrateOffChainLegs } from '../../src/mappings/migrations/offChainLegMigration';
import { getAssetIdForLegacyTicker } from '../../src/utils/assets';
import { mockStore } from './helpers';

const CROSSING = '0010036147/0000000002';

const leg = (instructionId: string, ticker: string) => ({
  id: `${instructionId}/0`,
  instructionId,
  legType: 'OffChain',
  ticker,
  updatedEventId: '0006100000/0000000001',
});

it('makes fungible the pending legs of a ticker that is an asset at 6.0', async () => {
  const acme = await getAssetIdForLegacyTicker('ACME');
  const db = mockStore({
    Asset: { [acme]: { id: acme, ticker: 'ACME' } },
    Instruction: {
      '0000000001': { id: '0000000001', status: 'Created' },
      '0000000002': { id: '0000000002', status: 'Failed' },
      '0000000003': { id: '0000000003', status: 'Executed' },
      '0000000004': { id: '0000000004', status: 'Created' },
    },
    Leg: {
      '0000000001/0': leg('0000000001', 'ACME'),
      '0000000002/0': leg('0000000002', 'ACME'),
      // settled before 6.0, so the chain had pruned it and the index keeps what it settled as
      '0000000003/0': leg('0000000003', 'ACME'),
      // no asset at 6.0, so off-chain on chain too
      '0000000004/0': leg('0000000004', 'NOPE'),
    },
  });
  // the migration finds rows by status and by instruction
  (globalThis as any).store.getByFields = jest.fn(
    async (name: string, filters: [string, string, unknown][]) =>
      Object.values(db[name] ?? {})
        .filter(row => filters.every(([field, , value]) => row[field] === value))
        .map(row => ({ ...row }))
  );

  await migrateOffChainLegs(CROSSING);

  for (const id of ['0000000001/0', '0000000002/0']) {
    expect(db.Leg[id]).toMatchObject({
      legType: 'Fungible',
      assetId: acme,
      ticker: 'ACME',
      updatedEventId: CROSSING,
    });
  }
  expect(db.Leg['0000000003/0']).toMatchObject({ legType: 'OffChain' });
  expect(db.Leg['0000000003/0'].assetId).toBeUndefined();
  expect(db.Leg['0000000004/0']).toMatchObject({ legType: 'OffChain' });
});
