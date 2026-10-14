/**
 * The tuple-style events that actually occur on mainnet or testnet are stored by name, not by
 * position, in every runtime they occur in.
 *
 * Each is checked at every spec version of its unnamed ranges in `event-history.json`, through the
 * same `argumentNames` the event indexer stores arguments by, so a historical event's `args` keys
 * can't fall back to `"0"`, `"1"`, …
 */
import { SubstrateEvent } from '@subql/types';
import history from '../fixtures/event-history.json';
import { argumentNames } from '../../src/decode';
import { encodeArgs } from '../../src/mappings/args/encode';

type Names = { from: number; to: number; names: string[] }[];

/** One range of spec versions, from the first runtime up to `to`, under one list of names */
const upTo = (to: number, ...names: string[]): Names => [{ from: 0, to, names }];

const CALLER = 'callerDid';
const AGENT = 'agentDid';
const FUNDRAISER = [AGENT, 'fundraiserId'];
const TRANSFER_MANAGER = [CALLER, 'ticker', 'transferManager'];
const EXEMPTIONS = [...TRANSFER_MANAGER, 'scopeIds'];
const BRIDGE_TX = [CALLER, 'bridgeTx'];
const COMPUTE = ['compute'];
const COUNCIL = 'governanceCouncillDid';
const INVESTED_BY_ASSET = [
  'investorDid',
  'fundraiserId',
  'offeringAsset',
  'fundingAsset',
  'offeringAmount',
  'raiseAmount',
];

/** The names each event's arguments are stored under, in parameter order, per spec range */
const NAMED: Record<string, Names> = {
  'bridge.AdminChanged': upTo(6_999_999, CALLER, 'newAdmin'),
  'bridge.BridgeTxScheduled': upTo(6_999_999, CALLER, 'bridgeTx', 'executionBlock'),
  'bridge.Bridged': upTo(6_999_999, ...BRIDGE_TX),
  'bridge.FreezeAdminAdded': upTo(6_999_999, CALLER, 'freezeAdmin'),
  'bridge.Frozen': upTo(6_999_999, CALLER),
  'bridge.FrozenTx': upTo(6_999_999, ...BRIDGE_TX),
  'bridge.TxsHandled': upTo(6_999_999, 'handledTxs'),
  'bridge.Unfrozen': upTo(6_999_999, CALLER),
  'bridge.UnfrozenTx': upTo(6_999_999, ...BRIDGE_TX),
  'multiSig.ProposalExecutionFailed': upTo(6_999_999, 'error'),
  'multiSig.ProposalFailedToExecute': upTo(6_999_999, CALLER, 'multisig', 'proposalId', 'error'),
  'portfolio.MovedBetweenPortfolios': upTo(
    5_999_999,
    'did',
    'fromPortfolio',
    'toPortfolio',
    'ticker',
    'amount',
    'memo'
  ),
  'settlement.InstructionRescheduled': upTo(7_999_999, CALLER, 'instructionId'),
  'settlement.InstructionV2Created': upTo(
    5_999_999,
    CALLER,
    'venueId',
    'instructionId',
    'settlementType',
    'tradeDate',
    'valueDate',
    'legs',
    'memo'
  ),
  'settlement.SchedulingFailed': [
    ...upTo(6_999_999, 'error'),
    { from: 7_000_000, to: 7_999_999, names: ['instructionId', 'error'] },
  ],
  'staking.InvalidatedNominators': upTo(
    6_999_999,
    COUNCIL,
    'governanceCouncillAccount',
    'expiredNominators'
  ),
  'staking.MinimumBondThresholdUpdated': upTo(6_999_999, COUNCIL, 'newValue'),
  'staking.SlashingAllowedForChanged': upTo(6_999_999, 'slashingSwitch'),
  'staking.SolutionStored': upTo(6_999_999, ...COMPUTE),
  'staking.StakingElection': upTo(6_999_999, ...COMPUTE),
  'statistics.ExemptionsAdded': upTo(4_999_999, ...EXEMPTIONS),
  'statistics.ExemptionsRemoved': upTo(4_999_999, ...EXEMPTIONS),
  'statistics.TransferManagerAdded': upTo(4_999_999, ...TRANSFER_MANAGER),
  'statistics.TransferManagerRemoved': upTo(4_999_999, ...TRANSFER_MANAGER),
  'sto.FundraiserClosed': upTo(7_002_999, ...FUNDRAISER),
  'sto.FundraiserCreated': upTo(7_002_999, ...FUNDRAISER, 'fundraiserName', 'fundraiser'),
  'sto.FundraiserFrozen': upTo(7_002_999, ...FUNDRAISER),
  'sto.FundraiserUnfrozen': upTo(7_002_999, ...FUNDRAISER),
  'sto.FundraiserWindowModified': upTo(
    7_002_999,
    ...FUNDRAISER,
    'oldStart',
    'oldEnd',
    'newStart',
    'newEnd'
  ),
  'sto.Invested': [
    ...upTo(
      6_999_999,
      'investorDid',
      'fundraiserId',
      'offeringTicker',
      'fundingTicker',
      'offeringAmount',
      'raiseAmount'
    ),
    { from: 7_000_000, to: 7_002_999, names: INVESTED_BY_ASSET },
  ],
  'system.ExtrinsicFailed': upTo(4_999_999, 'dispatchError', 'dispatchInfo'),
  'system.ExtrinsicSuccess': upTo(4_999_999, 'dispatchInfo'),
  'system.NewAccount': upTo(4_999_999, 'account'),
};

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

/** A tuple-style event as the chain delivers it: no field names in the metadata */
const tupleEvent = (event: string, arity: number, specVersion: number): SubstrateEvent => {
  const [section, method] = event.split('.');
  const value = { toString: () => 'x' };

  return {
    block: { specVersion },
    event: {
      section,
      method,
      data: Array.from({ length: arity }, () => value),
      meta: {
        fields: Array.from({ length: arity }, () => ({
          name: { isSome: false },
          typeName: { isSome: true, unwrap: () => ({ toString: () => 'Dummy' }) },
        })),
      },
    },
  } as unknown as SubstrateEvent;
};

const unnamedRuntimes = (event: string) =>
  events[event].flatMap(range =>
    range.fields.every(Boolean)
      ? []
      : specs
          .filter(spec => spec >= range.from && spec <= range.to)
          .map(spec => ({ spec, arity: range.types.length }))
  );

describe('tuple-style events that occur on the chains are stored by name', () => {
  it('covers the 33 types the chains emit', () => {
    expect(Object.keys(NAMED)).toHaveLength(33);
  });

  describe.each(Object.keys(NAMED))('%s', event => {
    it('is named at every spec version it is unnamed in', () => {
      const runtimes = unnamedRuntimes(event);
      expect(runtimes.length).toBeGreaterThan(0);

      for (const { spec, arity } of runtimes) {
        const expected = NAMED[event].find(({ from, to }) => spec >= from && spec <= to);
        expect(`${event} at ${spec}: ${argumentNames(tupleEvent(event, arity, spec))}`).toBe(
          `${event} at ${spec}: ${expected?.names}`
        );
      }
    });

    it('is stored under its names, not its positions', () => {
      const { spec, arity } = unnamedRuntimes(event)[0];
      const values = Array.from({ length: arity }, () => ({
        toRawType: () => 'Null',
        toString: () => 'x',
      })) as never[];
      const { args } = encodeArgs(
        values,
        argumentNames(tupleEvent(event, arity, spec)),
        values.map(() => 'Null')
      );

      expect(Object.keys(args)).not.toContain('0');
      expect(Object.keys(args)).toHaveLength(arity);
    });
  });
});
