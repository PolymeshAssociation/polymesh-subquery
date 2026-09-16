import { Metadata, TypeRegistry } from '@polkadot/types';
import metadataHex from '@polkadot/types-support/metadata/static-substrate';
import {
  applyEnumUpdates,
  arityFixtureFor,
  ArityFixture,
  enumMembers,
  eventDrift,
  findEnumBlock,
  planEnumUpdates,
  RuntimeSnapshot,
  sectionId,
  snapshotFromMetadata,
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
  events: { balances: { BalanceSet: 2, TransferWithMemo: 4 } },
  calls: { balances: ['set_balance'] },
  ...overrides,
});

describe('snapshotFromMetadata', () => {
  const registry = new TypeRegistry();
  const metadata = new Metadata(registry, metadataHex);

  registry.setMetadata(metadata);

  const real = snapshotFromMetadata(registry, metadata, 'substrate', 1);

  it('keys a section the way the arity fixtures spell it, not the way metadata spells it', () => {
    expect(real.events.balances).toBeDefined();
    expect(real.events.Balances).toBeUndefined();
  });

  it('lowercases the first letter only, so a multi-word pallet keeps its camelCase', () => {
    expect(Object.keys(real.events)).toContain('transactionPayment');
    expect(Object.keys(real.calls)).toContain('electionProviderMultiPhase');
  });

  it('still spells modules the way ModuleIdEnum does, fully lowercased', () => {
    expect(real.modules).toContain('transactionpayment');
  });

  /**
   * The regression this file exists for: a fixture captured from a runtime has to read back
   * against that same runtime as no drift at all. Keyed by the metadata spelling instead, every
   * event in the fixture reads as removed - 81 of them, against mainnet.
   */
  it('produces a fixture that reads back against its own runtime as no drift', () => {
    const fixture: ArityFixture = {
      specVersion: 1,
      source: 'substrate static metadata',
      modules: { balances: real.events.balances },
    };
    const drift = eventDrift(fixture, real);

    expect([drift.added, drift.removed, drift.reshaped]).toEqual([[], [], []]);
  });
});

describe('sectionId', () => {
  it('maps a metadata pallet name onto the api section name', () => {
    expect(sectionId('ExternalAgents')).toBe('externalAgents');
    expect(sectionId('Asset')).toBe('asset');
  });
});

describe('arityFixtureFor', () => {
  it('captures a pallet it was asked for, rather than writing an empty fixture', () => {
    const captured = arityFixtureFor(
      snapshot({ events: { asset: { AssetCreated: 8 }, notCaptured: { Whatever: 1 } } })
    );

    expect(captured.modules).toEqual({ asset: { AssetCreated: 8 } });
  });
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
      snapshot({ events: { balances: { Zebra: 1, Apple: 1, BalanceSet: 2 } } })
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
    modules: { balances: { BalanceSet: 4, Gone: 1 } },
  };

  it('names an event whose parameter count changed, which positional decoding cannot see', () => {
    expect(eventDrift(fixture, snapshot()).reshaped).toEqual(['balances.BalanceSet: 4 -> 2']);
  });

  it('names an event the runtime added since the fixture was captured', () => {
    expect(eventDrift(fixture, snapshot()).added).toEqual(['balances.TransferWithMemo']);
  });

  it('names an event the runtime no longer has', () => {
    expect(eventDrift(fixture, snapshot()).removed).toEqual(['balances.Gone']);
  });

  it('reports nothing when the runtime matches the fixture', () => {
    const same = snapshot({ events: { balances: { BalanceSet: 4, Gone: 1 } } });
    const drift = eventDrift(fixture, same);

    expect([drift.added, drift.removed, drift.reshaped]).toEqual([[], [], []]);
  });
});

describe('unhandledEvents', () => {
  it('lists an event of a subscribed pallet that no handler reads', () => {
    const unhandled = unhandledEvents(
      snapshot({ events: { asset: { AssetCreated: 8, ClassicTickerClaimed: 2 } } })
    );

    expect(unhandled).toContain('asset.ClassicTickerClaimed');
    expect(unhandled).not.toContain('asset.AssetCreated');
  });

  it('ignores pallets the indexer does not subscribe to at all', () => {
    expect(unhandledEvents(snapshot({ events: { notAPallet: { Whatever: 1 } } }))).toEqual([]);
  });
});
