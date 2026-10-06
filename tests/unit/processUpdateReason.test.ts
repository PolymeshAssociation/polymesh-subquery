/**
 * Unit tests for processUpdateReason's event labelling of instruction-less transfers.
 *
 * A `Transferred` reason with no instruction is labelled with the name of the event that
 * follows it (e.g. `ControllerTransfer`). A name missing from EventIdEnum must fall back to
 * `Unknown`, otherwise the insert into `asset_transactions.event_id` fails and halts indexing.
 */

import { EventRecord } from '@polkadot/types/interfaces';
import { processUpdateReason } from '../../src/mappings/entities/assets/mapAsset';
import { EventIdEnum } from '../../src/types';

const eventRecord = (method: string): EventRecord =>
  ({ event: { method } } as unknown as EventRecord);

const transferred = (instructionId: number | null = null) => ({
  instructionId,
  instructionMemo: null,
});

describe('processUpdateReason', () => {
  describe('transferred without an instruction', () => {
    it('uses the next event name when EventIdEnum has it', () => {
      const events = [eventRecord('AssetBalanceUpdated'), eventRecord('ControllerTransfer')];

      const result = processUpdateReason('transferred', transferred(), BigInt(1), 0, events);

      expect(result.eventId).toBe(EventIdEnum.ControllerTransfer);
    });

    it('falls back to Unknown when the next event name is not in EventIdEnum', () => {
      const events = [eventRecord('AssetBalanceUpdated'), eventRecord('NotARealEventName')];

      const result = processUpdateReason('transferred', transferred(), BigInt(1), 0, events);

      expect(result.eventId).toBe(EventIdEnum.Unknown);
    });

    it('falls back to Unknown when there is no next event', () => {
      const events = [eventRecord('AssetBalanceUpdated')];

      const result = processUpdateReason('transferred', transferred(), BigInt(1), 0, events);

      expect(result.eventId).toBe(EventIdEnum.Unknown);
    });
  });

  it('labels a transfer with an instruction as Transfer', () => {
    const events = [eventRecord('AssetBalanceUpdated'), eventRecord('NotARealEventName')];

    const result = processUpdateReason('transferred', transferred(5), BigInt(1), 0, events);

    expect(result.eventId).toBe(EventIdEnum.Transfer);
    expect(result.instructionId).toBe('0000000005');
  });
});
