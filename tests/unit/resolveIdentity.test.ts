/**
 * `resolveIdentity` answers from the index alone: the seed writes every identity the chain holds
 * at the start, and `DidCreated` every one after, so a DID the index lacks is one the chain lacks.
 */
import { SubstrateBlock } from '@subql/types';
import { resolveIdentity } from '../../src/mappings/entities/identities/mapIdentities';
import { mockStore } from './helpers';

const DID = `0x${'01'.repeat(32)}`;
const block = {
  block: { header: { number: { toString: () => '500' } } },
  specVersion: 8_000_000,
  timestamp: new Date('2024-01-01T00:00:00.000Z'),
} as unknown as SubstrateBlock;
const context = { reason: 'a test', block, eventIdx: 1, blockEventId: '0000000500/0000000001' };

beforeEach(() => {
  (globalThis as any).api.query = {
    identity: { didRecords: jest.fn().mockRejectedValue(new Error('should not be called')) },
  };
});

it('resolves an indexed identity', async () => {
  mockStore({ Identity: { [DID]: { id: DID } } });

  expect(await resolveIdentity(DID, context)).toBe(DID);
});

it('drops a DID the index lacks, with an anomaly, and never asks the chain', async () => {
  const db = mockStore();

  expect(await resolveIdentity(DID, context)).toBeUndefined();
  expect(Object.keys(db.Identity ?? {})).toEqual([]);
  expect(Object.values(db.IndexerAnomaly)[0].detail).toMatch(/not indexed/);
});
