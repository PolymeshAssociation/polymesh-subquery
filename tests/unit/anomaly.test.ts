import { SubstrateBlock } from '@subql/types';
import { AnomalyKind } from '../../src/types';
import { recordAnomaly } from '../../src/utils/anomaly';

const blockAt = (blockNumber: number, specVersion = 7_004_000): SubstrateBlock =>
  ({
    block: { header: { number: { toString: () => `${blockNumber}` } } },
    specVersion,
    timestamp: new Date('2024-01-01T00:00:00.000Z'),
  } as unknown as SubstrateBlock);

const written = () => (store.set as jest.Mock).mock.calls.map(([, , row]) => row);

describe('recordAnomaly', () => {
  it('pads the id so lexical order matches emission order', async () => {
    await recordAnomaly({
      kind: AnomalyKind.FieldNotFound,
      detail: 'no field "amount"',
      block: blockAt(42),
      eventIdx: 7,
    });

    expect(written()[0].id).toBe('0000000042/0000000007/0000000000');
  });

  it('gives each anomaly on one event its own sequence number', async () => {
    const block = blockAt(100);

    await recordAnomaly({ kind: AnomalyKind.ArityMismatch, detail: 'a', block, eventIdx: 1 });
    await recordAnomaly({ kind: AnomalyKind.ArityMismatch, detail: 'b', block, eventIdx: 1 });
    await recordAnomaly({ kind: AnomalyKind.ArityMismatch, detail: 'c', block, eventIdx: 2 });

    expect(written().map(({ id }) => id)).toEqual([
      '0000000100/0000000001/0000000000',
      '0000000100/0000000001/0000000001',
      '0000000100/0000000002/0000000000',
    ]);
  });

  it('restarts sequence numbers on a new block', async () => {
    await recordAnomaly({
      kind: AnomalyKind.HandlerError,
      detail: 'a',
      block: blockAt(200),
      eventIdx: 1,
    });
    await recordAnomaly({
      kind: AnomalyKind.HandlerError,
      detail: 'b',
      block: blockAt(201),
      eventIdx: 1,
    });

    expect(written().map(({ id }) => id)).toEqual([
      '0000000200/0000000001/0000000000',
      '0000000201/0000000001/0000000000',
    ]);
  });

  it('records the block spec version, not the indexer default', async () => {
    await recordAnomaly({
      kind: AnomalyKind.NoDecoderForSpecVersion,
      detail: 'balances.BalanceSet',
      block: blockAt(300, 5_000_000),
    });

    expect(written()[0]).toMatchObject({ specVersionId: 5_000_000, blockId: '0000000300' });
  });

  it('writes a deduplicated anomaly once per process', async () => {
    const key = `unique-${Date.now()}`;

    await recordAnomaly({
      kind: AnomalyKind.UnknownEnumValue,
      detail: 'first',
      block: blockAt(400),
      dedupeKey: key,
    });
    await recordAnomaly({
      kind: AnomalyKind.UnknownEnumValue,
      detail: 'second',
      block: blockAt(401),
      dedupeKey: key,
    });

    expect(written()).toHaveLength(1);
    expect(written()[0].detail).toBe('first');
  });
});
