import '@subql/types-core/dist/global';
import '@subql/types/dist/global';
import { EventRecord } from '@polkadot/types/interfaces';
import { processUpdateReason } from '../../src/mappings/entities/assets/mapAsset';
import { EventIdEnum } from '../../src/types';

/**
 * Regression tests for defect A7: `processUpdateReason` branched on three of the four
 * `HoldingsUpdateReason` variants and fell through to `{ eventId: undefined, assetDelta: {} }`
 * for `controllerTransfer`, so controller transfers were not counted in `asset.totalTransfers`
 * and their event id was resolved from the (possibly wrapping) extrinsic call name instead.
 */
describe('processUpdateReason', () => {
  const noEvents = [] as unknown as EventRecord[];

  it('counts a controller transfer and pins its event id', () => {
    const result = processUpdateReason('controllerTransfer', {}, BigInt(100), 0, noEvents);

    expect(result.eventId).toBe(EventIdEnum.ControllerTransfer);
    expect(result.assetDelta).toStrictEqual({ totalTransfers: BigInt(1) });
  });

  it('keeps the controller-transfer event id even with no following event (batched call)', () => {
    // The `transferred` branch falls back to `blockEvents[eventIdx + 1]` for its event id;
    // `controllerTransfer` must not, or a batched controller_transfer records `Transfer`.
    const result = processUpdateReason('controllerTransfer', {}, BigInt(1), 5, noEvents);

    expect(result.eventId).toBe(EventIdEnum.ControllerTransfer);
  });

  it('still counts issued / redeemed / transferred as before', () => {
    expect(
      processUpdateReason('issued', { fundingRoundName: '' }, BigInt(10), 0, noEvents).assetDelta
    ).toStrictEqual({ totalSupply: BigInt(10) });
    expect(processUpdateReason('redeemed', {}, BigInt(10), 0, noEvents).assetDelta).toStrictEqual({
      totalSupply: BigInt(-10),
    });
    expect(
      processUpdateReason(
        'transferred',
        { instructionId: 1, instructionMemo: null },
        BigInt(10),
        0,
        noEvents
      ).assetDelta
    ).toStrictEqual({ totalTransfers: BigInt(1) });
  });

  it('falls through for a genuinely unknown reason', () => {
    const result = processUpdateReason('somethingNew', {}, BigInt(1), 0, noEvents);

    expect(result.eventId).toBeUndefined();
    expect(result.assetDelta).toStrictEqual({});
  });
});
