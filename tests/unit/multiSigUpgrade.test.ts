/**
 * What runtime upgrades did to multisigs without an event.
 */
import { removeIdentitySigners } from '../../src/mappings/entities/multiSig/mapMultiSig';
import { deletePendingProposals } from '../../src/mappings/entities/multiSig/mapMultiSigProposal';
import { mockStore } from './helpers';

const MS = '5ErsSYhQZSEqhkAG7cYvBj2KD4DK1TXpW7gtyyRDjaXg2gh5';

/**
 * Multisig's `on_runtime_upgrade` clears every proposal, its votes and states when the upgrade's
 * transaction version is above the one it stored (v3.0.0 to v8.1.2).
 */
describe('pending proposals an upgrade deleted', () => {
  it('are every active proposal, and no finished one, with nothing read from the chain', async () => {
    const db = mockStore({
      MultiSigProposal: {
        [`${MS}/1`]: { id: `${MS}/1`, multisigId: MS, proposalId: 1, status: 'Active' },
        [`${MS}/2`]: { id: `${MS}/2`, multisigId: MS, proposalId: 2, status: 'Active' },
        [`${MS}/3`]: { id: `${MS}/3`, multisigId: MS, proposalId: 3, status: 'Success' },
      },
    });
    const g = globalThis as any;
    g.store.bulkUpdate = jest.fn(async (entity: string, rows: any[]) =>
      rows.forEach(row => (db[entity][row.id] = { ...row }))
    );
    g.api.rpc = {};

    await deletePendingProposals('0000000500/0000000003');

    expect(db.MultiSigProposal[`${MS}/1`]).toMatchObject({
      status: 'Deleted',
      updatedEventId: '0000000500/0000000003',
    });
    expect(db.MultiSigProposal[`${MS}/2`].status).toBe('Deleted');
    expect(db.MultiSigProposal[`${MS}/3`].status).toBe('Success');
  });
});

describe('identity signers at 7.0', () => {
  it('are removed, as 7.0 keeps only account signers', async () => {
    const db = mockStore({
      MultiSigSigner: {
        a: { id: 'a', signerType: 'Identity', status: 'Approved' },
        b: { id: 'b', signerType: 'Identity', status: 'Authorized' },
        c: { id: 'c', signerType: 'Account', status: 'Approved' },
      },
    });

    await removeIdentitySigners('0000000500/0000000003');

    expect(db.MultiSigSigner.a).toMatchObject({
      status: 'Removed',
      updatedEventId: '0000000500/0000000003',
    });
    expect(db.MultiSigSigner.b.status).toBe('Removed');
    expect(db.MultiSigSigner.c.status).toBe('Approved');
  });
});
