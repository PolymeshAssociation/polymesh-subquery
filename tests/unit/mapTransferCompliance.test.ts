/**
 * `TransferCompliance` rows, one per condition in `statistics.assetTransferCompliances`. An asset
 * can hold several conditions over one statistic, such as two investor counts.
 */
import { handleSetTransferCompliance } from '../../src/mappings/entities/assets/mapStatistics';
import { codec, MockDb, mockStore, tupleEvent } from './helpers';

const ASSET = '0x1234567890abcdef1234567890abcdef';

const setConditions = (conditions: unknown[]) =>
  handleSetTransferCompliance(
    tupleEvent({
      section: 'statistics',
      method: 'SetAssetTransferCompliance',
      data: [codec(TEST_DID), codec(ASSET), codec(conditions)],
    })
  );

const values = (db: MockDb) =>
  Object.values(db.TransferCompliance ?? {})
    .map(({ type, value }) => `${type}:${value}`)
    .sort();

describe('transfer conditions', () => {
  it('keeps two conditions over one statistic as two rows', async () => {
    const db = mockStore();

    await setConditions([{ maxInvestorCount: 100 }, { maxInvestorCount: 110 }]);

    expect(values(db)).toEqual(['MaxInvestorCount:100', 'MaxInvestorCount:110']);
  });

  it('drops a condition the new set leaves out', async () => {
    const db = mockStore();
    await setConditions([{ maxInvestorCount: 100 }, { maxInvestorCount: 110 }]);

    await setConditions([{ maxInvestorCount: 110 }]);

    expect(values(db)).toEqual(['MaxInvestorCount:110']);
  });
});
