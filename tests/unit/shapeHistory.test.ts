/**
 * The shape table against every runtime mainnet and testnet have run.
 *
 * `event-history.json` records, per event, the spec versions over which its parameters stayed the
 * same, read from each runtime's metadata by `scripts/survey-event-history.ts`. An event's stored
 * argument keys come from the shape covering its spec version, so these checks are what keep a
 * historical event's keys from changing once they are right.
 */
import history from '../fixtures/event-history.json';
import { acceptedArity, EventShape, registeredShapes } from '../../src/decode';

interface Range {
  from: number;
  to: number;
  fields: (string | null)[];
  types: string[];
}

const events = history.events as Record<string, Range[]>;

const specs = Array.from(
  new Set(
    Object.values(history.chains).flatMap(({ runtimes }) =>
      runtimes.map(({ specVersion }) => specVersion)
    )
  )
).sort((a, b) => a - b);

const newest = specs[specs.length - 1];

const shapes = new Map(
  Array.from(registeredShapes().entries()).map(([key, entries]) => [key.toLowerCase(), entries])
);

const shapesOf = (event: string): readonly EventShape[] => shapes.get(event.toLowerCase()) ?? [];

const covering = (entries: readonly EventShape[], spec: number) =>
  entries.filter(({ from, to }) => spec >= from && (to === undefined || spec <= to));

const accepting = (entries: readonly EventShape[], arity: number) =>
  entries.find(shape => {
    const { min, max } = acceptedArity(shape);
    return arity >= min && arity <= max;
  });

const named = (range: Range) => range.fields.every(Boolean);

/** Every runtime spec version in a range, with the event's parameters there */
const runtimes = Object.entries(events).flatMap(([event, ranges]) =>
  ranges.flatMap(range =>
    specs
      .filter(spec => spec >= range.from && spec <= range.to)
      .map(spec => ({ event, spec, range }))
  )
);

/**
 * Tuple-style events no shape names in some era, so their arguments are stored by position
 * there. Listed so a new gap is a decision, not an accident.
 */
const POSITIONAL = new Set<string>([
  'asset.ExtensionRemoved',
  'asset.IsIssuable',
  'asset.TransferWithData',
  'base.UnexpectedError',
  'bridge.BridgeLimitUpdated',
  'bridge.BridgeTxFailed',
  'bridge.BridgeTxScheduleFailed',
  'bridge.ControllerChanged',
  'bridge.ExemptedUpdated',
  'bridge.FreezeAdminRemoved',
  'bridge.TimelockChanged',
  'bridge.TxRemoved',
  'cddServiceProviders.ActiveLimitChanged',
  'cddServiceProviders.Dummy',
  'cddServiceProviders.MemberAdded',
  'cddServiceProviders.MemberRemoved',
  'cddServiceProviders.MemberRevoked',
  'cddServiceProviders.MembersReset',
  'cddServiceProviders.MembersSwapped',
  'committeeMembership.Dummy',
  'corporateAction.CAATransferred',
  'grandpa.NewAuthorities',
  'identity.CddClaimsInvalidated',
  'identity.CddRequirementForPrimaryKeyUpdated',
  'identity.MockInvestorUIDCreated',
  'identity.OffChainAuthorizationRevoked',
  'imOnline.HeartbeatReceived',
  'imOnline.SomeOffline',
  'indices.IndexAssigned',
  'indices.IndexFreed',
  'indices.IndexFrozen',
  'multiSig.SchedulingFailed',
  'offences.Offence',
  'polymeshContracts.ApiHashUpdated',
  'polymeshContracts.SCRuntimeCall',
  'rewards.ItnRewardClaimed',
  'scheduler.Canceled',
  'scheduler.Scheduled',
  'session.NewSession',
  'settlement.ReceiptUnclaimed',
  'settlement.ReceiptValidityChanged',
  'staking.CommissionCapUpdated',
  'staking.OldSlashingReportDiscarded',
  'staking.RewardPaymentSchedulingInterrupted',
  'sudo.KeyChanged',
  'sudo.Sudid',
  'sudo.SudoAsDone',
  'system.KilledAccount',
  'technicalCommitteeMembership.Dummy',
  'testUtils.CddStatus',
  'testUtils.DidStatus',
  'testUtils.MockInvestorUIDCreated',
  'upgradeCommitteeMembership.Dummy',
  'utility.BatchCompleted',
  'utility.BatchCompletedOld',
]);

/**
 * Events whose parameters the chain reordered, not renamed, when it named them: `sto.Invested`
 * moved the fundraiser id after the offering asset. Their names must be the same set.
 */
const REORDERED = new Set<string>(['sto.Invested']);

/**
 * Events that kept their arity but changed what the parameters are when the chain named them:
 * `utility.BatchInterrupted` held the event counts and a failing `(index, error)` pair, and now
 * holds the index and the error directly. Reusing the new names for the old values would mislabel
 * them.
 */
const RETYPED = new Set<string>(['utility.BatchInterrupted']);

describe('the shape table against the chains’ runtime history', () => {
  it('has the runtimes of both chains', () => {
    expect(Object.keys(history.chains).sort()).toEqual(['mainnet', 'testnet']);
    expect(specs.length).toBeGreaterThan(50);
  });

  it('accepts the parameter count of every runtime it covers', () => {
    const disagreements = runtimes
      .filter(({ event, spec, range }) => {
        const applicable = covering(shapesOf(event), spec);
        return !named(range) && applicable.length > 0 && !accepting(applicable, range.types.length);
      })
      .map(({ event, spec, range }) => `${event} at ${spec}: ${range.types.length} parameters`);

    expect(disagreements).toEqual([]);
  });

  it('names every tuple-style event of the newest runtime', () => {
    const unnamed = Object.entries(events)
      .filter(([, ranges]) => ranges.some(range => range.to === newest && !named(range)))
      .filter(([event, ranges]) => {
        const range = ranges.find(({ to }) => to === newest) as Range;
        return !accepting(covering(shapesOf(event), newest), range.types.length);
      })
      .map(([event]) => event);

    expect(unnamed).toEqual([]);
  });

  it('uses the metadata’s names wherever a runtime names the fields a shape covers', () => {
    const renamed = runtimes
      .filter(({ range }) => named(range))
      .flatMap(({ event, spec, range }) => {
        const shape = accepting(covering(shapesOf(event), spec), range.fields.length);
        return shape && shape.fields.join() !== range.fields.join()
          ? [`${event} at ${spec}: ${shape.fields.join()} vs ${range.fields.join()}`]
          : [];
      });

    expect(Array.from(new Set(renamed))).toEqual([]);
  });

  it('keeps a field’s name where the chain starts naming an event of the same arity', () => {
    const renamed = Object.entries(events).flatMap(([event, ranges]) =>
      ranges.slice(1).flatMap((range, i) => {
        const before = ranges[i];
        if (
          RETYPED.has(event) ||
          !named(range) ||
          named(before) ||
          range.fields.length !== before.types.length
        ) {
          return [];
        }
        const shape = accepting(covering(shapesOf(event), before.to), before.types.length);
        const same = REORDERED.has(event)
          ? [...(shape?.fields ?? [])].sort().join() === [...range.fields].sort().join()
          : shape?.fields.join() === range.fields.join();
        return shape && !same
          ? [`${event} at ${range.from}: ${shape.fields.join()} -> ${range.fields.join()}`]
          : [];
      })
    );

    expect(renamed).toEqual([]);
  });

  it('stores only the listed events by position', () => {
    const positional = runtimes
      .filter(({ event, spec, range }) => {
        return !named(range) && !accepting(covering(shapesOf(event), spec), range.types.length);
      })
      .map(({ event }) => event);

    expect(Array.from(new Set(positional)).sort()).toEqual(Array.from(POSITIONAL).sort());
  });
});
