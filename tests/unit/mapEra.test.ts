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

const mockElection = (eraIndex: number | null, validators: string[] | 'unreadable') => {
  (globalThis as any).api.query = {
    ...mockLedgerAccountQuery(),
    staking: {
      ...mockSelfControlled(),
      currentEra: jest.fn().mockResolvedValue({ toJSON: () => eraIndex }),
      erasStakers: {
        keys:
          validators === 'unreadable'
            ? jest.fn().mockRejectedValue(new Error('no such storage'))
            : jest
                .fn()
                .mockResolvedValue(validators.map(v => ({ args: [{}, { toString: () => v }] }))),
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

describe('handleEraPaid', () => {
  it('closes the era with payout/remainder and the erasTotalStake chain read', async () => {
    const db = mockStore();

    (globalThis as any).api.query = {
      staking: { erasTotalStake: jest.fn().mockResolvedValue({ toString: () => '900000' }) },
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
      staking: { erasTotalStake: jest.fn().mockResolvedValue({ toString: () => '700' }) },
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
