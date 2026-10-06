/**
 * `StakersElected` carries no payload in either era — the era index and elected validator set are
 * resolved from chain storage (`staking.currentEra()` / `staking.erasStakers(eraIndex)` keys, NOT
 * `activeEra()` / `session.validators()` — see `src/utils/staking.ts` for why those are stale at
 * `StakersElected` time), not decoded from the event. `EraPaid` then closes the era it opened.
 */
import { handleEraPaid, handleStakersElected } from '../../src/mappings/entities/events/mapEra';
import { IndexerAnomaly } from '../../src/types';
import {
  mockGetByFields,
  mockLedgerAccountQuery,
  mockSelfControlled,
  mockStore,
  namedEvent,
  tupleEvent,
} from './helpers';

const VAL_OLD = '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY';
const VAL_NEW = '5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty';

const key = (stash: string) => ({ args: [{}, { toString: () => stash }] });
const amount = (value: number) => ({ toString: () => String(value) });

/**
 * An election for `eraIndex`. Before v8 the exposures are in `erasStakers`; `'v8'` stores them in
 * `erasStakersOverview` instead, which is the only map a v8 runtime writes.
 */
const mockElection = (
  eraIndex: number | null,
  validators: string[] | 'unreadable',
  runtime: 'pre-v8' | 'v8' = 'pre-v8'
) => {
  const read = (rows: () => unknown[]) =>
    validators === 'unreadable'
      ? jest.fn().mockRejectedValue(new Error('no such storage'))
      : jest.fn().mockResolvedValue(rows());
  const stashes = validators === 'unreadable' ? [] : validators;

  const exposures =
    runtime === 'v8'
      ? {
          erasStakersOverview: {
            entries: read(() =>
              stashes.map((stash, i) => [
                key(stash),
                {
                  isNone: false,
                  unwrap: () => ({
                    own: amount(100 * (i + 1)),
                    total: amount(1_000 * (i + 1)),
                    nominatorCount: { toNumber: () => 3 },
                  }),
                },
              ])
            ),
          },
        }
      : {
          erasStakers: {
            entries: read(() =>
              stashes.map((stash, i) => [
                key(stash),
                { own: amount(100 * (i + 1)), total: amount(1_000 * (i + 1)), others: [{}, {}] },
              ])
            ),
          },
        };

  (globalThis as any).api.query = {
    ...mockLedgerAccountQuery(),
    staking: {
      ...mockSelfControlled(),
      currentEra: jest.fn().mockResolvedValue({ toJSON: () => eraIndex }),
      ...exposures,
      erasValidatorPrefs: {
        entries: jest
          .fn()
          .mockResolvedValue(
            stashes.map(stash => [
              key(stash),
              { toJSON: () => ({ commission: 50_000_000, blocked: false }) },
            ])
          ),
      },
    },
  };
};

describe('handleStakersElected', () => {
  it('creates an Era and marks exactly the resolved validator set active', async () => {
    const db = mockStore({
      Validator: {
        [VAL_OLD]: {
          id: VAL_OLD,
          accountId: VAL_OLD,
          isActive: true,
          blocked: false,
          isPermissioned: false,
        },
      },
    });
    mockGetByFields(db, 'Validator');
    mockElection(5, [VAL_NEW]);

    await handleStakersElected(
      namedEvent({ section: 'staking', method: 'StakersElected', fields: {} })
    );

    expect(Object.values(db.Era)).toHaveLength(1);
    expect(Object.values(db.Era)[0]).toMatchObject({ eraIndex: 5 });
    expect(db.Validator[VAL_OLD].isActive).toBe(false);
    expect(db.Validator[VAL_NEW]).toMatchObject({ accountId: VAL_NEW, isActive: true });
  });

  it("records each elected validator's stake and commission for the era", async () => {
    const db = mockStore();
    mockGetByFields(db, 'Validator');
    mockElection(5, [VAL_NEW]);

    await handleStakersElected(
      namedEvent({ section: 'staking', method: 'StakersElected', fields: {} })
    );

    expect(Object.values(db.Era)[0]).toMatchObject({ eraIndex: 5, validatorCount: 1 });
    expect(db.ValidatorEra[`0000000005/${VAL_NEW}`]).toMatchObject({
      eraId: '0000000005',
      eraIndex: 5,
      validatorId: VAL_NEW,
      ownStake: BigInt(100),
      totalStake: BigInt(1_000),
      nominatorCount: 2,
      commission: BigInt(50_000_000),
      blocked: false,
    });
  });

  /** v8 writes only `erasStakersOverview`, so reading `erasStakers` found nobody elected. */
  it('reads a v8 election from erasStakersOverview', async () => {
    const db = mockStore({
      Validator: {
        [VAL_OLD]: {
          id: VAL_OLD,
          accountId: VAL_OLD,
          isActive: true,
          blocked: false,
          isPermissioned: false,
        },
      },
    });
    mockGetByFields(db, 'Validator');
    mockElection(7, [VAL_OLD, VAL_NEW], 'v8');

    await handleStakersElected(
      namedEvent({ section: 'staking', method: 'StakersElected', fields: {} })
    );

    expect(db.Validator[VAL_OLD].isActive).toBe(true);
    expect(db.Validator[VAL_NEW].isActive).toBe(true);
    expect(db.ValidatorEra[`0000000007/${VAL_NEW}`]).toMatchObject({
      ownStake: BigInt(200),
      totalStake: BigInt(2_000),
      nominatorCount: 3,
    });
  });

  /**
   * The event has no payload, so the era it opens is only knowable from chain state. Without it there
   * is nothing to write — but an era boundary the index skipped is a gap, so it is reported.
   */
  it('writes nothing and reports the gap when the chain has no current era', async () => {
    const db = mockStore();
    mockGetByFields(db, 'Validator');
    mockElection(null, []);
    const anomaly = jest.spyOn(IndexerAnomaly.prototype, 'save').mockResolvedValue(undefined);

    await expect(
      handleStakersElected(namedEvent({ section: 'staking', method: 'StakersElected', fields: {} }))
    ).resolves.not.toThrow();

    expect(Object.keys(db.Era ?? {})).toHaveLength(0);
    expect(anomaly).toHaveBeenCalledTimes(1);
  });

  it('fails the block when the validator-set read fails, leaving the active set untouched', async () => {
    const db = mockStore({
      Validator: {
        [VAL_OLD]: {
          id: VAL_OLD,
          accountId: VAL_OLD,
          isActive: true,
          blocked: false,
          isPermissioned: false,
        },
      },
    });
    mockGetByFields(db, 'Validator');
    mockElection(5, 'unreadable');

    await expect(
      handleStakersElected(namedEvent({ section: 'staking', method: 'StakersElected', fields: {} }))
    ).rejects.toThrow('no such storage');

    // a failed read is not "nobody elected"
    expect(db.Validator[VAL_OLD].isActive).toBe(true);
  });

  it('handles the pre-v7 StakingElection the same way, ignoring its ElectionCompute payload', async () => {
    const db = mockStore();
    mockGetByFields(db, 'Validator');
    mockElection(3, [VAL_NEW]);

    await handleStakersElected(
      tupleEvent({
        section: 'staking',
        method: 'StakingElection',
        data: ['OnChain'],
        specVersion: 3000,
      })
    );

    expect(Object.values(db.Era)[0]).toMatchObject({ eraIndex: 3 });
    expect(db.Validator[VAL_NEW]).toMatchObject({ accountId: VAL_NEW, isActive: true });
  });
});

const rewardPoints = (total: number, individual: Record<string, number>) =>
  jest.fn().mockResolvedValue({
    total: { toNumber: () => total },
    individual: new Map(
      Object.entries(individual).map(([stash, points]) => [
        { toString: () => stash },
        { toNumber: () => points },
      ])
    ),
  });

describe('handleEraPaid', () => {
  it('gives each validator elected for the era its points, and 0 to one that earned none', async () => {
    const db = mockStore({
      ValidatorEra: {
        [`0000000005/${VAL_OLD}`]: {
          id: `0000000005/${VAL_OLD}`,
          eraIndex: 5,
          validatorId: VAL_OLD,
        },
        [`0000000005/${VAL_NEW}`]: {
          id: `0000000005/${VAL_NEW}`,
          eraIndex: 5,
          validatorId: VAL_NEW,
        },
      },
    });
    mockGetByFields(db, 'ValidatorEra');

    (globalThis as any).api.query = {
      staking: {
        erasTotalStake: jest.fn().mockResolvedValue({ toString: () => '900000' }),
        erasRewardPoints: rewardPoints(140, { [VAL_OLD]: 140 }),
      },
    };

    await handleEraPaid(
      namedEvent({
        section: 'staking',
        method: 'EraPaid',
        fields: { eraIndex: 5, validatorPayout: '100000', remainder: '5000' },
      })
    );

    expect(Object.values(db.Era)[0]).toMatchObject({ totalPoints: 140 });
    expect(db.ValidatorEra[`0000000005/${VAL_OLD}`].points).toBe(140);
    expect(db.ValidatorEra[`0000000005/${VAL_NEW}`].points).toBe(0);
  });

  it('closes the era with payout/remainder and the erasTotalStake chain read', async () => {
    const db = mockStore();

    (globalThis as any).api.query = {
      staking: {
        erasTotalStake: jest.fn().mockResolvedValue({ toString: () => '900000' }),
        erasRewardPoints: rewardPoints(0, {}),
      },
    };

    await handleEraPaid(
      namedEvent({
        section: 'staking',
        method: 'EraPaid',
        fields: { eraIndex: 5, validatorPayout: '100000', remainder: '5000' },
      })
    );

    const [era] = Object.values(db.Era) as any[];

    expect(era).toMatchObject({
      eraIndex: 5,
      validatorPayout: BigInt(100_000),
      remainder: BigInt(5_000),
      totalStaked: BigInt(900_000),
    });
    expect(era.endEventId).toBeDefined();
  });

  it('closes the era from the pre-v7 EraPayout tuple', async () => {
    const db = mockStore();

    (globalThis as any).api.query = {
      staking: {
        erasTotalStake: jest.fn().mockResolvedValue({ toString: () => '700' }),
        erasRewardPoints: rewardPoints(0, {}),
      },
    };

    await handleEraPaid(
      tupleEvent({
        section: 'staking',
        method: 'EraPayout',
        data: ['2', '300', '40'],
        specVersion: 3000,
      })
    );

    expect(Object.values(db.Era)[0]).toMatchObject({
      eraIndex: 2,
      validatorPayout: BigInt(300),
      remainder: BigInt(40),
      totalStaked: BigInt(700),
    });
  });
});
