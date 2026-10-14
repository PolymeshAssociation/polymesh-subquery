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

/** The names each event's arguments are stored under, in parameter order, per spec range */
const NAMED: Record<string, { from: number; to: number; names: string[] }[]> = {
  'bridge.AdminChanged': [{ from: 0, to: 6_999_999, names: ['callerDid', 'newAdmin'] }],
  'bridge.BridgeTxScheduled': [
    { from: 0, to: 6_999_999, names: ['callerDid', 'bridgeTx', 'executionBlock'] },
  ],
  'bridge.Bridged': [{ from: 0, to: 6_999_999, names: ['callerDid', 'bridgeTx'] }],
  'bridge.FreezeAdminAdded': [{ from: 0, to: 6_999_999, names: ['callerDid', 'freezeAdmin'] }],
  'bridge.Frozen': [{ from: 0, to: 6_999_999, names: ['callerDid'] }],
  'bridge.FrozenTx': [{ from: 0, to: 6_999_999, names: ['callerDid', 'bridgeTx'] }],
  'bridge.TxsHandled': [{ from: 0, to: 6_999_999, names: ['handledTxs'] }],
  'bridge.Unfrozen': [{ from: 0, to: 6_999_999, names: ['callerDid'] }],
  'bridge.UnfrozenTx': [{ from: 0, to: 6_999_999, names: ['callerDid', 'bridgeTx'] }],
  'multiSig.ProposalExecutionFailed': [{ from: 0, to: 6_999_999, names: ['error'] }],
  'multiSig.ProposalFailedToExecute': [
    { from: 0, to: 6_999_999, names: ['callerDid', 'multisig', 'proposalId', 'error'] },
  ],
  'portfolio.MovedBetweenPortfolios': [
    {
      from: 0,
      to: 5_999_999,
      names: ['did', 'fromPortfolio', 'toPortfolio', 'ticker', 'amount', 'memo'],
    },
  ],
  'settlement.InstructionRescheduled': [
    { from: 0, to: 7_999_999, names: ['callerDid', 'instructionId'] },
  ],
  'settlement.InstructionV2Created': [
    {
      from: 0,
      to: 5_999_999,
      names: [
        'callerDid',
        'venueId',
        'instructionId',
        'settlementType',
        'tradeDate',
        'valueDate',
        'legs',
        'memo',
      ],
    },
  ],
  'settlement.SchedulingFailed': [
    { from: 0, to: 6_999_999, names: ['error'] },
    { from: 7_000_000, to: 7_999_999, names: ['instructionId', 'error'] },
  ],
  'staking.InvalidatedNominators': [
    {
      from: 0,
      to: 6_999_999,
      names: ['governanceCouncillDid', 'governanceCouncillAccount', 'expiredNominators'],
    },
  ],
  'staking.MinimumBondThresholdUpdated': [
    { from: 0, to: 6_999_999, names: ['governanceCouncillDid', 'newValue'] },
  ],
  'staking.SlashingAllowedForChanged': [{ from: 0, to: 6_999_999, names: ['slashingSwitch'] }],
  'staking.SolutionStored': [{ from: 0, to: 6_999_999, names: ['compute'] }],
  'staking.StakingElection': [{ from: 0, to: 6_999_999, names: ['compute'] }],
  'statistics.ExemptionsAdded': [
    { from: 0, to: 4_999_999, names: ['callerDid', 'ticker', 'transferManager', 'scopeIds'] },
  ],
  'statistics.ExemptionsRemoved': [
    { from: 0, to: 4_999_999, names: ['callerDid', 'ticker', 'transferManager', 'scopeIds'] },
  ],
  'statistics.TransferManagerAdded': [
    { from: 0, to: 4_999_999, names: ['callerDid', 'ticker', 'transferManager'] },
  ],
  'statistics.TransferManagerRemoved': [
    { from: 0, to: 4_999_999, names: ['callerDid', 'ticker', 'transferManager'] },
  ],
  'sto.FundraiserClosed': [{ from: 0, to: 7_002_999, names: ['agentDid', 'fundraiserId'] }],
  'sto.FundraiserCreated': [
    {
      from: 0,
      to: 7_002_999,
      names: ['agentDid', 'fundraiserId', 'fundraiserName', 'fundraiser'],
    },
  ],
  'sto.FundraiserFrozen': [{ from: 0, to: 7_002_999, names: ['agentDid', 'fundraiserId'] }],
  'sto.FundraiserUnfrozen': [{ from: 0, to: 7_002_999, names: ['agentDid', 'fundraiserId'] }],
  'sto.FundraiserWindowModified': [
    {
      from: 0,
      to: 7_002_999,
      names: ['agentDid', 'fundraiserId', 'oldStart', 'oldEnd', 'newStart', 'newEnd'],
    },
  ],
  'sto.Invested': [
    {
      from: 0,
      to: 6_999_999,
      names: [
        'investorDid',
        'fundraiserId',
        'offeringTicker',
        'fundingTicker',
        'offeringAmount',
        'raiseAmount',
      ],
    },
    {
      from: 7_000_000,
      to: 7_002_999,
      names: [
        'investorDid',
        'fundraiserId',
        'offeringAsset',
        'fundingAsset',
        'offeringAmount',
        'raiseAmount',
      ],
    },
  ],
  'system.ExtrinsicFailed': [{ from: 0, to: 4_999_999, names: ['dispatchError', 'dispatchInfo'] }],
  'system.ExtrinsicSuccess': [{ from: 0, to: 4_999_999, names: ['dispatchInfo'] }],
  'system.NewAccount': [{ from: 0, to: 4_999_999, names: ['account'] }],
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
