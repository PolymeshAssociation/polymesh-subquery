import {
  handleExecutionScheduled,
  handleExpiryScheduled,
  handlePipClosed,
  handlePipSkipped,
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
  it('records the skip count, the execution block and the expiry block the chain scheduled', async () => {
    const db = seeded(4);

    await handlePipSkipped(pipsEvent('PipSkipped', [TEST_DID, 4, 2]));
    await handleExecutionScheduled(pipsEvent('ExecutionScheduled', [TEST_DID, 4, 900], 1));
    await handleExpiryScheduled(pipsEvent('ExpiryScheduled', [TEST_DID, 4, 1200], 2));

    expect(db.Proposal[pip(4)]).toMatchObject({
      skippedCount: 2,
      executionScheduledAt: 900,
      expiresAt: 1200,
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
