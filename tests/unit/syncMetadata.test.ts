import {
  applyEnumUpdates,
  ArityFixture,
  enumMembers,
  eventDrift,
  findEnumBlock,
  planEnumUpdates,
  RuntimeSnapshot,
  unhandledEvents,
  withAddedMembers,
} from '../../scripts/sync-metadata';

const SCHEMA = `"""
Represents all known chain "pallets"
"""
enum ModuleIdEnum {
  ## system ##
  system
  balances @deprecated
  "unknown module value is populated for modules not yet implemented"
  unknown
}

enum EventIdEnum {
  BalanceSet
  Unknown
}

enum CallIdEnum {
  set_balance
  unknown
}
`;

const snapshot = (overrides: Partial<RuntimeSnapshot> = {}): RuntimeSnapshot => ({
  specName: 'polymesh',
  specVersion: 8_000_000,
  modules: ['system', 'balances'],
  events: { Balances: { BalanceSet: 2, TransferWithMemo: 4 } },
  calls: { Balances: ['set_balance'] },
  ...overrides,
});

describe('enum parsing', () => {
  it('reads member names past comments, docstrings and directives', () => {
    expect(enumMembers(findEnumBlock(SCHEMA, 'ModuleIdEnum').body)).toEqual([
      'system',
      'balances',
      'unknown',
    ]);
  });

  it('throws rather than guessing when an enum is missing', () => {
    expect(() => findEnumBlock(SCHEMA, 'NotAnEnum')).toThrow(/no NotAnEnum/);
  });
});

describe('planEnumUpdates', () => {
  it('lists the members this runtime emits that the schema does not declare', () => {
    const updates = planEnumUpdates(SCHEMA, snapshot());

    expect(updates.EventIdEnum.added).toEqual(['TransferWithMemo']);
  });

  it('reports a declared member the runtime dropped instead of removing it', () => {
    const updates = planEnumUpdates(SCHEMA, snapshot({ modules: ['system'] }));

    expect(updates.ModuleIdEnum.added).toEqual([]);
    expect(updates.ModuleIdEnum.notInRuntime).toContain('balances');
  });

  it('sorts additions so two runs over the same runtime produce the same file', () => {
    const updates = planEnumUpdates(
      SCHEMA,
      snapshot({ events: { Balances: { Zebra: 1, Apple: 1, BalanceSet: 2 } } })
    );

    expect(updates.EventIdEnum.added).toEqual(['Apple', 'Zebra']);
  });
});

describe('applyEnumUpdates', () => {
  const updated = () => applyEnumUpdates(SCHEMA, planEnumUpdates(SCHEMA, snapshot()));

  it('appends the new member under its own heading', () => {
    expect(updated()).toContain('## added by scripts/sync-metadata.ts ##\n  TransferWithMemo');
  });

  it('leaves existing members in their original order, which is the Postgres enum order', () => {
    expect(enumMembers(findEnumBlock(updated(), 'ModuleIdEnum').body)).toEqual([
      'system',
      'balances',
      'unknown',
    ]);
  });

  it('keeps docstrings and deprecations attached to the members they annotate', () => {
    expect(updated()).toContain('balances @deprecated');
    expect(updated()).toContain('"unknown module value is populated');
  });

  it('is idempotent, so re-running it does not churn the file', () => {
    const once = updated();

    expect(applyEnumUpdates(once, planEnumUpdates(once, snapshot()))).toBe(once);
  });
});

describe('withAddedMembers', () => {
  it('returns the body untouched when nothing is new', () => {
    const body = '\n  a\n  b\n';

    expect(withAddedMembers(body, [])).toBe(body);
  });
});

describe('eventDrift', () => {
  const fixture: ArityFixture = {
    specVersion: 7_004_001,
    source: 'test',
    modules: { Balances: { BalanceSet: 4, Gone: 1 } },
  };

  it('names an event whose parameter count changed, which positional decoding cannot see', () => {
    expect(eventDrift(fixture, snapshot()).reshaped).toEqual(['Balances.BalanceSet: 4 -> 2']);
  });

  it('names an event the runtime added since the fixture was captured', () => {
    expect(eventDrift(fixture, snapshot()).added).toEqual(['Balances.TransferWithMemo']);
  });

  it('names an event the runtime no longer has', () => {
    expect(eventDrift(fixture, snapshot()).removed).toEqual(['Balances.Gone']);
  });

  it('reports nothing when the runtime matches the fixture', () => {
    const same = snapshot({ events: { Balances: { BalanceSet: 4, Gone: 1 } } });
    const drift = eventDrift(fixture, same);

    expect([drift.added, drift.removed, drift.reshaped]).toEqual([[], [], []]);
  });
});

describe('unhandledEvents', () => {
  it('lists an event of a subscribed pallet that no handler reads', () => {
    const unhandled = unhandledEvents(
      snapshot({ events: { asset: { AssetCreated: 8, AssetTypeChanged: 3 } } })
    );

    expect(unhandled).toContain('asset.AssetTypeChanged');
    expect(unhandled).not.toContain('asset.AssetCreated');
  });

  it('ignores pallets the indexer does not subscribe to at all', () => {
    expect(unhandledEvents(snapshot({ events: { notAPallet: { Whatever: 1 } } }))).toEqual([]);
  });
});
