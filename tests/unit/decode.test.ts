import { SubstrateEvent } from '@subql/types';
import {
  acceptedArity,
  ArityMismatch,
  decodeEvent,
  field,
  FieldNotFound,
  NoDecoderForSpecVersion,
  registeredShapes,
} from '../../src/decode';

/** Only `.toString()` is exercised by the assertions below */
const codec = (value: string) => ({ toString: () => value } as any);

/**
 * A struct-style event, the shape every upstream Substrate pallet emits: the block's own
 * metadata names each field.
 */
const namedEvent = (
  section: string,
  method: string,
  fields: Record<string, string>,
  specVersion = 8_000_000
): SubstrateEvent =>
  ({
    idx: 2,
    block: {
      block: { header: { number: { toString: () => '900' } } },
      specVersion,
      timestamp: new Date('2024-01-01T00:00:00.000Z'),
    },
    event: {
      section,
      method,
      data: Object.values(fields).map(codec),
      meta: {
        fields: Object.keys(fields).map(name => ({
          name: { isSome: true, unwrap: () => codec(name) },
          typeName: { isSome: true, unwrap: () => codec('Dummy') },
        })),
      },
    },
  } as unknown as SubstrateEvent);

/** A tuple-style event, the shape every Polymesh pallet emits: metadata carries no field names */
const tupleEvent = (
  section: string,
  method: string,
  values: string[],
  specVersion = 8_000_000
): SubstrateEvent =>
  ({
    idx: 2,
    block: {
      block: { header: { number: { toString: () => '900' } } },
      specVersion,
      timestamp: new Date('2024-01-01T00:00:00.000Z'),
    },
    event: {
      section,
      method,
      data: values.map(codec),
      meta: {
        fields: values.map(() => ({
          name: { isSome: false },
          typeName: { isSome: true, unwrap: () => codec('Dummy') },
        })),
      },
    },
  } as unknown as SubstrateEvent);

const anomalies = () =>
  (store.set as jest.Mock).mock.calls
    .filter(([entity]) => entity === 'IndexerAnomaly')
    .map(([, , row]) => row);

describe('field', () => {
  it('resolves a parameter by the name the block metadata gives it', () => {
    const event = namedEvent('balances', 'BalanceSet', { who: '5Grw', free: '100' });

    expect(field(event, 'free').toString()).toBe('100');
  });

  it('resolves by name rather than position, so an inserted field does not shift the answer', () => {
    const event = namedEvent('balances', 'BalanceSet', { who: '5Grw', reason: 'x', free: '100' });

    expect(field(event, 'free').toString()).toBe('100');
  });

  it('throws FieldNotFound rather than returning undefined', () => {
    const event = namedEvent('balances', 'BalanceSet', { who: '5Grw', free: '100' });

    expect(() => field(event, 'reserved')).toThrow(FieldNotFound);
    expect(() => field(event, 'reserved')).toThrow(/has no field "reserved"/);
  });
});

describe('decodeEvent, named events', () => {
  it('keys every parameter by its metadata field name', () => {
    const decoded = decodeEvent(
      namedEvent('balances', 'TransferWithMemo', { from: 'a', to: 'b', amount: '5', memo: 'm' })
    );

    expect(decoded.amount.toString()).toBe('5');
    expect(decoded.memo.toString()).toBe('m');
  });

  it('throws on a name the event does not carry instead of yielding undefined', () => {
    const decoded = decodeEvent(namedEvent('balances', 'BalanceSet', { who: 'a', free: '1' }));

    expect(() => decoded.reserved).toThrow(FieldNotFound);
  });

  it('records an anomaly when a handler asks for a name that is not there', () => {
    const decoded = decodeEvent(namedEvent('balances', 'BalanceSet', { who: 'a', free: '1' }));

    expect(() => decoded.reserved).toThrow();
    expect(anomalies()).toHaveLength(1);
    expect(anomalies()[0]).toMatchObject({ kind: 'FieldNotFound', specVersionId: 8_000_000 });
  });
});

describe('decodeEvent, tuple events', () => {
  it('names the parameters from the registered shape', () => {
    const decoded = decodeEvent(
      tupleEvent('externalAgents', 'AgentAdded', ['0xdid', '0xasset', 'Full'])
    );

    expect(decoded.did.toString()).toBe('0xdid');
    expect(decoded.assetId.toString()).toBe('0xasset');
    expect(decoded.agentGroup.toString()).toBe('Full');
  });

  it('matches the section case-insensitively, as the chain reports it', () => {
    const decoded = decodeEvent(
      tupleEvent('externalagents', 'AgentAdded', ['0xdid', '0xasset', 'Full'])
    );

    expect(decoded.assetId.toString()).toBe('0xasset');
  });

  it('picks the shape covering the block, not the latest one', () => {
    const v5 = decodeEvent(
      tupleEvent(
        'asset',
        'AssetCreated',
        ['0xdid', 'TICKER', 'true', 'EquityCommon', '0xowner', 'false', 'Name', '[]', 'Round'],
        5_004_003
      )
    );

    expect(v5.disableIu.toString()).toBe('false');
    expect(v5.name.toString()).toBe('Name');
  });

  it('leaves the parameter a shorter event never carried undefined, not missing', () => {
    const early = decodeEvent(
      tupleEvent(
        'asset',
        'AssetCreated',
        ['0xdid', 'TICKER', 'true', 'EquityCommon', '0xowner', 'false'],
        5_000_000
      )
    );

    expect(early.name).toBeUndefined();
    expect(early.disableIu.toString()).toBe('false');
  });

  it('does not expose a parameter the later shape dropped', () => {
    const v6 = decodeEvent(
      tupleEvent(
        'asset',
        'AssetCreated',
        ['0xdid', '0xasset', 'true', 'EquityCommon', '0xowner', 'Name', '[]', 'Round'],
        6_000_000
      )
    );

    expect(() => v6.disableIu).toThrow(FieldNotFound);
  });

  it('throws ArityMismatch when the chain disagrees about the parameter count', () => {
    expect(() =>
      decodeEvent(tupleEvent('externalAgents', 'AgentAdded', ['0xdid', '0xasset']))
    ).toThrow(ArityMismatch);
  });

  it('records the arity mismatch as an anomaly', () => {
    expect(() =>
      decodeEvent(tupleEvent('externalAgents', 'AgentAdded', ['0xdid', '0xasset']))
    ).toThrow();

    expect(anomalies()[0]).toMatchObject({ kind: 'ArityMismatch' });
    expect(anomalies()[0].detail).toContain('carried 2 parameters');
  });

  it('throws NoDecoderForSpecVersion when the block predates every registered shape', () => {
    expect(() =>
      decodeEvent(
        tupleEvent('asset', 'Issued', ['0xdid', '0xasset', '0xto', '5', 'r', '5'], 8_000_000)
      )
    ).toThrow(NoDecoderForSpecVersion);
  });

  it('records the missing decoder as an anomaly naming the ranges it does cover', () => {
    expect(() =>
      decodeEvent(
        tupleEvent('asset', 'Issued', ['0xdid', '0xasset', '0xto', '5', 'r', '5'], 8_000_000)
      )
    ).toThrow();

    expect(anomalies()[0]).toMatchObject({ kind: 'NoDecoderForSpecVersion' });
    expect(anomalies()[0].detail).toContain('[0, 5999999]');
  });

  it('throws NoDecoderForSpecVersion for an event with no registered shape at all', () => {
    expect(() => decodeEvent(tupleEvent('asset', 'NotAnEvent', ['a']))).toThrow(
      NoDecoderForSpecVersion
    );
  });
});

/**
 * One case per registered shape: an event of the declared parameter count decodes to exactly the
 * declared names, in order. This is what makes a typo in the table a test failure rather than an
 * `undefined` in a row.
 */
describe('every registered shape', () => {
  const cases = [...registeredShapes().entries()].flatMap(([shapeKey, shapes]) =>
    shapes.map((shape, index) => {
      const [moduleId, eventId] = shapeKey.split('.');

      return [
        `${shapeKey}${shapes.length > 1 ? ` (${shape.from} onwards)` : ''}`,
        moduleId,
        eventId,
        shape,
        index,
      ] as const;
    })
  );

  it.each(cases)('decodes %s to its declared field names', (_label, moduleId, eventId, shape) => {
    const { max } = acceptedArity(shape);
    const values = shape.fields.map((_name, index) => `value-${index}`);

    const decoded = decodeEvent(tupleEvent(moduleId, eventId, values, shape.from));

    expect(Object.keys(decoded)).toEqual([...shape.fields]);
    expect(shape.fields.map(name => decoded[name].toString())).toEqual(values);
    expect(values).toHaveLength(max);
  });

  it('gives every event at least one shape covering the spec versions it was live for', () => {
    const gaps = [...registeredShapes().entries()]
      .filter(([, shapes]) => shapes.length === 0)
      .map(([shapeKey]) => shapeKey);

    expect(gaps).toEqual([]);
  });
});
