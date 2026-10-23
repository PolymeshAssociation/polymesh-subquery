import '@subql/types-core/dist/global';
import '@subql/types/dist/global';
import { TypeRegistry } from '@polkadot/types';
import { EventRecord } from '@polkadot/types/interfaces';
import {
  fundingRoundAtCreation,
  processUpdateReason,
} from '../../src/mappings/entities/assets/mapAsset';
import { EventIdEnum } from '../../src/types';

/**
 * Regression tests: `processUpdateReason` branched on three of the four
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

describe('fundingRoundAtCreation', () => {
  const registry = new TypeRegistry();
  const none = registry.createType('Option<Bytes>');
  const named = registry.createType('Option<Bytes>', 'Series A ');

  it('gives no round as "" before 6.0, which stored `unwrap_or_default()`', () => {
    expect(fundingRoundAtCreation(none, 5_004_003)).toBe('');
    expect(fundingRoundAtCreation(named, 5_004_003)).toBe('Series A ');
  });

  it('gives no round as undefined from 6.0, which stores only a named one', () => {
    expect(fundingRoundAtCreation(none, 6_000_000)).toBeUndefined();
    expect(fundingRoundAtCreation(named, 6_000_000)).toBe('Series A ');
  });
});
