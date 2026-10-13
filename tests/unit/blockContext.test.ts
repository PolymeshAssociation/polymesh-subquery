import {
  __resetBlockContext,
  getKeyRecordCache,
  getLedgerEntries,
} from '../../src/mappings/blockContext';
import { PolyxEntry } from '../../src/types';

const entry = { id: 'entry', accountId: 'alice', movementId: '0000000001/0000000001' };

describe('block context lookups by bare block id', () => {
  beforeEach(__resetBlockContext);

  it('keep the first block they are asked about', () => {
    getLedgerEntries('0000000001').add(entry as unknown as PolyxEntry);

    expect(getLedgerEntries('0000000001').ofAccount('alice')).toHaveLength(1);
  });

  it('under another block id leave the current block untouched', () => {
    getLedgerEntries('0000000001').add(entry as unknown as PolyxEntry);
    getKeyRecordCache('0000000001').set('alice', undefined);

    expect(getLedgerEntries('0000000000').ofAccount('alice')).toHaveLength(0);
    getKeyRecordCache('0000000000').set('bob', undefined);

    expect(getLedgerEntries('0000000001').ofAccount('alice')).toHaveLength(1);
    expect(getKeyRecordCache('0000000001').has('alice')).toBe(true);
    expect(getKeyRecordCache('0000000001').has('bob')).toBe(false);
  });
});
