/**
 * Which chain events reach the catch-all `handleEvent`, and so get a raw `Event` row.
 *
 * `filters` in project.ts lists modules. A listed module is subscribed whole (every event it emits
 * is stored), except `system` and `utility`, which are subscribed event by event. A module that is
 * not listed is never stored at all. A runtime that adds an event to a listed module with no entry
 * in `filters`
 * therefore goes unnoticed (it is stored, but no handler or review ever names it), and one that adds
 * an event to `system` is silently dropped. These checks make every such change a decision.
 *
 * `event-history.json` records every event any mainnet or testnet runtime has declared, with the
 * spec versions it has been declared for, read from each runtime's metadata. The guard is only as
 * current as that file: regenerate it with `scripts/survey-event-history.ts` after a runtime
 * upgrade, and a newly declared event then fails here until it is decided.
 */
import fs from 'fs';
import path from 'path';
import ts from 'typescript';
import history from '../fixtures/event-history.json';

interface Range {
  from: number;
  to: number;
}

const declared = history.events as Record<string, Range[]>;

const PARTIAL_MODULES = ['system', 'utility'];

const source = fs.readFileSync(path.join(__dirname, '..', '..', 'project.ts'), 'utf8');

/** `filters` read from the source of project.ts: module -> event -> handler names. */
function readFilters(): Record<string, Record<string, string[]>> {
  const file = ts.createSourceFile('project.ts', source, ts.ScriptTarget.ES2020, true);
  const out: Record<string, Record<string, string[]>> = {};
  const name = (n: ts.PropertyName): string =>
    ts.isIdentifier(n) || ts.isStringLiteral(n) ? n.text : n.getText();
  file.forEachChild(node => {
    if (!ts.isVariableStatement(node)) return;
    node.declarationList.declarations.forEach(decl => {
      if (!ts.isIdentifier(decl.name) || decl.name.text !== 'filters') return;
      const object = decl.initializer as ts.ObjectLiteralExpression;
      object.properties.forEach(mod => {
        if (!ts.isPropertyAssignment(mod)) {
          throw new Error(`filters has a ${ts.SyntaxKind[mod.kind]}; write module: { … } entries`);
        }
        const events: Record<string, string[]> = {};
        (mod.initializer as ts.ObjectLiteralExpression).properties.forEach(ev => {
          if (!ts.isPropertyAssignment(ev)) {
            throw new Error(`filters.${name(mod.name)} has a ${ts.SyntaxKind[ev.kind]}`);
          }
          events[name(ev.name)] = (ev.initializer as ts.ArrayLiteralExpression).elements.map(
            e => (e as ts.StringLiteral).text
          );
        });
        out[name(mod.name)] = events;
      });
    });
  });
  return out;
}

const filters = readFilters();

const byModule: Record<string, Map<string, number>> = {};
Object.entries(declared).forEach(([key, ranges]) => {
  const [module, event] = key.split('.');
  byModule[module] = byModule[module] ?? new Map();
  byModule[module].set(event, Math.min(...ranges.map(r => r.from)));
});

/**
 * Declared events a listed module has no entry for, with why. Everything else a listed module
 * declares must have an entry in `filters`, `[]` for "stored, no handler". A new runtime event that
 * is not here and has no entry fails the test; add it to `filters` if it matters to an entity, here
 * if it is deliberately left without one.
 */
const WITHOUT_ENTRY: Record<string, Record<string, string>> = {
  system: {
    ExtrinsicSuccess:
      'An extrinsic row is written only when one of its events is stored, and `Extrinsic.success` already records the outcome.',
    ExtrinsicFailed:
      'An extrinsic row is written only when one of its events is stored, and `Extrinsic.success` already records the outcome.',
    KilledAccount: 'Account removal is not tracked.',
    Remarked: 'Carries only a hash.',
    UpgradeAuthorized: 'Only authorises a later code update; CodeUpdated records the upgrade.',
    RejectedInvalidAuthorizedUpgrade: 'A rejected upgrade authorisation changes nothing.',
  },
  utility: {
    BatchCompleted: 'A batch that ran every call; nothing to record beyond the extrinsic.',
    BatchCompletedOld: 'The older form of BatchCompleted.',
    ItemCompleted: 'One per call of a batch: frequent, and says only that the call ran.',
    DispatchedAs:
      "Not stored: a failed dispatched call is neither flagged nor stored; a successful one's own events record its effect.",
    RelayedTx:
      "Not stored: a failed relayed call is neither flagged nor stored; a successful one's own events record its effect.",
  },
  // The remaining modules are subscribed whole, so these are stored raw; they just have no handler.
  corporateAction: { CAATransferred: 'Agent change is recorded from the authorization.' },
  didRegistrars: {
    ActiveLimitChanged: 'Registrar membership is not indexed.',
    MemberAdded: 'Registrar membership is not indexed.',
    MemberRemoved: 'Registrar membership is not indexed.',
    MemberRevoked: 'Registrar membership is not indexed.',
    MembersReset: 'Registrar membership is not indexed.',
    MembersSwapped: 'Registrar membership is not indexed.',
  },
  electionProviderMultiPhase: {
    ElectionFailed: 'Election internals are not indexed.',
    ElectionFinalized: 'Election internals are not indexed.',
    PhaseTransitioned: 'Election internals are not indexed.',
    Rewarded: 'Election internals are not indexed.',
    Slashed: 'Election internals are not indexed.',
    SolutionStored: 'Election internals are not indexed.',
  },
  identity: {
    MockInvestorUIDCreated: 'Test-only event.',
    OffChainAuthorizationRevoked: 'Off-chain authorizations are not indexed.',
  },
  multiBlockMigrations: {
    HistoricCleared: 'Migration bookkeeping is not indexed.',
    MigrationAdvanced: 'Migration bookkeeping is not indexed.',
    MigrationCompleted: 'Migration bookkeeping is not indexed.',
    MigrationFailed: 'Migration bookkeeping is not indexed.',
    MigrationSkipped: 'Migration bookkeeping is not indexed.',
    UpgradeCompleted: 'Migration bookkeeping is not indexed.',
    UpgradeFailed: 'Migration bookkeeping is not indexed.',
    UpgradeStarted: 'Migration bookkeeping is not indexed.',
  },
  protocolFee: {
    CoefficientSet: 'Fee schedule changes are not indexed.',
    FeeSet: 'Fee schedule changes are not indexed.',
  },
  revive: {
    ContractEmitted: 'Contract logs are not indexed.',
    EthExtrinsicRevert: 'The reverted transaction is read from the extrinsic.',
    Instantiated: 'Contract deployment is not indexed.',
  },
  settlement: {
    MandatoryReceiverAffirmationSet: 'Confidential-asset flag with no entity.',
    ReceiptUnclaimed: 'Receipts are tracked through ReceiptClaimed only.',
    ReceiptValidityChanged: 'Receipt validity is not tracked.',
  },
  stateTrieMigration: {
    AutoMigrationFinished: 'State migration bookkeeping is not indexed.',
    Halted: 'State migration bookkeeping is not indexed.',
    Migrated: 'State migration bookkeeping is not indexed.',
    Slashed: 'State migration bookkeeping is not indexed.',
  },
  validators: {
    AutomaticPayoutFinished: 'Payout bookkeeping is not indexed.',
    ValidatorPayoutFailed: 'Payout bookkeeping is not indexed.',
  },
};

/**
 * Modules a runtime has declared that `filters` does not list, so none of their events is stored.
 * Listing one (to store its events) or a new runtime adding a module changes this set.
 */
const UNLISTED_MODULES = [
  'base',
  'cddServiceProviders',
  'committeeMembership',
  'contracts',
  'grandpa',
  'historical',
  'imOnline',
  'indices',
  'offences',
  'polymeshCommittee',
  'polymeshContracts',
  'preimage',
  'rewards',
  'scheduler',
  'session',
  'sudo',
  'technicalCommittee',
  'technicalCommitteeMembership',
  'testUtils',
  'upgradeCommittee',
  'upgradeCommitteeMembership',
];

/**
 * Modules `filters` lists that no surveyed runtime declares an event for: one that was never
 * deployed to a production chain, and pallets that declare no events. Listing them subscribes them
 * in case a runtime adds events, which then fail the checks above until decided.
 */
const LISTED_WITHOUT_DECLARED_EVENTS = ['beefy', 'confidentialAsset', 'polymeshTransactionPayment'];

describe('event coverage', () => {
  it('reads the filters and the fixture', () => {
    expect(Object.keys(filters).length).toBeGreaterThan(30);
    expect(Object.keys(declared).length).toBeGreaterThan(400);
  });

  it('declares every module and event in filters in event-history.json', () => {
    const unknown: string[] = [];
    Object.entries(filters).forEach(([module, events]) => {
      if (byModule[module] === undefined) {
        if (!LISTED_WITHOUT_DECLARED_EVENTS.includes(module)) unknown.push(`${module} (module)`);
      } else
        Object.keys(events).forEach(event => {
          if (!byModule[module].has(event)) unknown.push(`${module}.${event}`);
        });
    });
    expect(unknown).toEqual([]);
  });

  it('stores every module project.ts lists whole, and only system and utility event by event', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const project = require('../../project').default;
    const catchAll: any[] = project.dataSources.flatMap((d: any) => d.mapping.handlers);
    const wholeModules = catchAll
      .filter((h: any) => h.handler === 'handleEvent' && h.filter.method === undefined)
      .map((h: any) => h.filter.module)
      .sort();
    expect(wholeModules).toEqual(
      Object.keys(filters)
        .filter(m => !PARTIAL_MODULES.includes(m))
        .sort()
    );
    PARTIAL_MODULES.forEach(module => {
      const events = catchAll
        .filter((h: any) => h.handler === 'handleEvent' && h.filter.module === module)
        .map((h: any) => h.filter.method)
        .sort();
      expect(events).toEqual(Object.keys(filters[module]).sort());
    });
  });

  it('has an entry in filters, or a stated reason, for every declared event of a listed module', () => {
    const missing: string[] = [];
    Object.keys(filters).forEach(module => {
      byModule[module]?.forEach((from, event) => {
        if (filters[module][event] !== undefined) return;
        if (WITHOUT_ENTRY[module]?.[event] !== undefined) return;
        const stored = PARTIAL_MODULES.includes(module) ? 'NOT stored' : 'stored raw only';
        missing.push(`${module}.${event} (declared from spec ${from}; ${stored})`);
      });
    });
    const message =
      'Declared by a runtime but absent from `filters` in project.ts. Add an entry (handler ' +
      'names, or [] for stored with no handler) or, if deliberately left, add it to WITHOUT_ENTRY.';
    expect({ message, missing }).toEqual({ message, missing: [] });
  });

  it('keeps the allow-list minimal', () => {
    const stale: string[] = [];
    LISTED_WITHOUT_DECLARED_EVENTS.forEach(module => {
      if (filters[module] === undefined) stale.push(`${module} is no longer listed in filters`);
      if (byModule[module] !== undefined) stale.push(`${module} now declares events`);
    });
    Object.entries(WITHOUT_ENTRY).forEach(([module, events]) => {
      if (filters[module] === undefined) stale.push(`${module} is no longer listed in filters`);
      Object.keys(events).forEach(event => {
        if (!byModule[module]?.has(event)) stale.push(`${module}.${event} is not declared`);
        else if (filters[module]?.[event] !== undefined)
          stale.push(`${module}.${event} now has an entry in filters`);
      });
    });
    expect(stale).toEqual([]);
  });

  it('pins the modules whose events are never stored', () => {
    const unlisted = Object.keys(byModule)
      .filter(module => filters[module] === undefined)
      .sort();
    const added = unlisted.filter(m => !UNLISTED_MODULES.includes(m));
    const removed = UNLISTED_MODULES.filter(m => !unlisted.includes(m));
    const message =
      'The set of modules project.ts does not list changed. A new module (or one now listed) ' +
      'must be decided: list it in `filters`, or update UNLISTED_MODULES to say it is never stored.';
    expect({ message, newlyUnlisted: added, noLongerUnlisted: removed }).toEqual({
      message,
      newlyUnlisted: [],
      noLongerUnlisted: [],
    });
  });
});
