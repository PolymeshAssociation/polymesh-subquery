import {
  handleExecutionScheduled,
  handlePipClosed,
  handlePipSkipped,
  handleProposalCreated,
  handleProposalStateUpdated,
  handleSnapshotCleared,
  handleSnapshotResultsEnacted,
  handleSnapshotTaken,
} from '../../src/mappings/entities/pips/mapProposal';
import { IndexerAnomaly } from '../../src/types';
import { codec, mockGetByFields, mockStore, tupleEvent } from './helpers';

const pip = (id: number) => `${id}`.padStart(10, '0');

const seeded = (...ids: number[]) =>
  mockStore({
    Proposal: Object.fromEntries(
      ids.map(id => [pip(id), { id: pip(id), snapshotted: false, state: 'Pending' }])
    ),
  });

const pipsEvent = (method: string, data: unknown[], idx = 0) =>
  tupleEvent({ section: 'pips', method, data: data.map(value => codec(value)), idx });

describe('the PIP lifecycle beyond creation and votes', () => {
  it('records the skip count and the execution block the chain scheduled', async () => {
    const db = seeded(4);

    await handlePipSkipped(pipsEvent('PipSkipped', [TEST_DID, 4, 2]));
    await handleExecutionScheduled(pipsEvent('ExecutionScheduled', [TEST_DID, 4, 900], 1));

    expect(db.Proposal[pip(4)]).toMatchObject({ skippedCount: 2, executionScheduledAt: 900 });
  });

  /**
   * `propose` schedules a PIP's expiry before it emits `ProposalCreated`, so `ExpiryScheduled`
   * arrives first, before the PIP exists (mainnet block 68,657, PIP 0).
   */
  describe('the expiry scheduled when the PIP is proposed', () => {
    const inExtrinsic = (section: string, method: string, data: unknown[]) => ({
      phase: { toString: () => '{"applyExtrinsic":1}' },
      event: { section, method, data: data.map(value => codec(value)) },
    });
    const created = (expiry: 'scheduled' | 'none') => {
      const records = [
        ...(expiry === 'scheduled'
          ? [inExtrinsic('pips', 'ExpiryScheduled', [TEST_DID, 4, 1200])]
          : []),
        inExtrinsic('pips', 'ProposalCreated', []),
      ];

      return tupleEvent({
        section: 'pips',
        method: 'ProposalCreated',
        data: [
          codec(TEST_DID),
          codec({ committee: { technical: null } }),
          codec(4),
          codec(0),
          codec('https://example.com'),
          codec('A proposal'),
        ],
        idx: records.length - 1,
        events: records,
      });
    };

    it('takes the expiry from the ExpiryScheduled before it', async () => {
      const db = mockStore();

      await handleProposalCreated(created('scheduled'));

      expect(db.Proposal[pip(4)].expiresAt).toBe(1200);
    });

    it('leaves it unset for a PIP with no scheduled expiry', async () => {
      const db = mockStore();

      await handleProposalCreated(created('none'));

      expect(db.Proposal[pip(4)].expiresAt).toBeUndefined();
    });
  });

  it('marks the PIP closed by the event that closed it', async () => {
    const db = seeded(4);

    await handlePipClosed(pipsEvent('PipClosed', [TEST_DID, 4, true], 3));

    expect(db.Proposal[pip(4)].closedEventId).toBe('0000001000/0000000003');
  });

  /**
   * `SnapshotTaken` sets a flag on every queued PIP. It used to stay set for good; it follows the
   * queue now — cleared with the queue, and dropped for each PIP whose result is enacted.
   */
  describe('the snapshot queue', () => {
    it('queues, then releases every PIP when the snapshot is cleared', async () => {
      const db = seeded(4, 5);
      mockGetByFields(db, 'Proposal');

      await handleSnapshotTaken(pipsEvent('SnapshotTaken', [TEST_DID, 7, [{ id: 4 }, { id: 5 }]]));

      expect(db.Proposal[pip(4)]).toMatchObject({ snapshotted: true, snapshotId: 7 });

      await handleSnapshotCleared(pipsEvent('SnapshotCleared', [TEST_DID, 7], 1));

      expect(db.Proposal[pip(4)]).toMatchObject({ snapshotted: false });
      expect(db.Proposal[pip(4)].snapshotId).toBeUndefined();
      expect(db.Proposal[pip(5)].snapshotted).toBe(false);
    });

    it("releases each enacted PIP, carrying a skipped one's new count", async () => {
      const db = seeded(4, 5, 6);

      await handleSnapshotTaken(
        pipsEvent('SnapshotTaken', [TEST_DID, 7, [{ id: 4 }, { id: 5 }, { id: 6 }]])
      );
      await handleSnapshotResultsEnacted(
        pipsEvent('SnapshotResultsEnacted', [TEST_DID, 7, [[4, 1]], [5], [6]], 1)
      );

      expect(db.Proposal[pip(4)]).toMatchObject({ snapshotted: false, skippedCount: 1 });
      expect(db.Proposal[pip(5)].snapshotted).toBe(false);
      expect(db.Proposal[pip(6)].snapshotted).toBe(false);
    });
  });

  it('reports a state update for a PIP the index does not have, instead of failing the block', async () => {
    mockStore();
    const anomaly = jest.spyOn(IndexerAnomaly.prototype, 'save').mockResolvedValue(undefined);

    await expect(
      handleProposalStateUpdated(pipsEvent('ProposalStateUpdated', [TEST_DID, 99, 'Rejected']))
    ).resolves.not.toThrow();

    expect(anomaly).toHaveBeenCalled();
  });
});
