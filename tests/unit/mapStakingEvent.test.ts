import { handlePositionBonded } from '../../src/mappings/entities/events/mapStakingPosition';
import { handleStakingEvent } from '../../src/mappings/entities/events/mapStakingEvent';
import { handlePayoutStarted } from '../../src/mappings/entities/identities/mapPolyxLedger';
import { codec, mockLedgerAccountQuery, mockStore, namedEvent, tupleEvent } from './helpers';

const ALICE = '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY';
const BOB = '5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty';

describe('handleStakingEvent', () => {
  it('B3: an unhandled v8 staking event records an IndexerAnomaly instead of silently dropping amount', async () => {
    const db = mockStore();

    // `Chilled` isn't registered against `handleStakingEvent` in project.ts today, but exercises
    // the same `get8xStakingEventDetails` fallthrough any future registration would hit.
    await handleStakingEvent(
      namedEvent({ section: 'staking', method: 'Chilled', fields: { stash: ALICE } })
    );

    const [row] = Object.values(db.StakingEvent) as any[];

    expect(row).toMatchObject({ stashAccount: ALICE });
    expect(row.amount).toBeUndefined();
    expect(Object.keys(db.IndexerAnomaly ?? {})).toHaveLength(1);
  });

  it('B4: an unhandled v8 event with no stash field records an anomaly instead of throwing', async () => {
    const db = mockStore();

    // `EraPaid` isn't registered against `handleStakingEvent` in project.ts, but has no `stash`
    // field at all — exercising the default branch's safe (`'stash' in decoded`) read.
    await expect(
      handleStakingEvent(
        namedEvent({
          section: 'staking',
          method: 'EraPaid',
          fields: { eraIndex: 5, validatorPayout: '100', remainder: '5' },
        })
      )
    ).resolves.not.toThrow();

    const [row] = Object.values(db.StakingEvent) as any[];

    expect(row.stashAccount).toBeUndefined();
    expect(Object.keys(db.IndexerAnomaly ?? {})).toHaveLength(1);
  });

  it('decodes a pre-v8 tuple Nominated event without needing a registered decode shape', async () => {
    const db = mockStore();

    await expect(
      handleStakingEvent(
        tupleEvent({
          section: 'staking',
          method: 'Nominated',
          data: [codec(TEST_DID), codec(ALICE), codec(['0xvalidator1'])],
          specVersion: 7_004_001,
        })
      )
    ).resolves.not.toThrow();

    const [row] = Object.values(db.StakingEvent) as any[];

    expect(row).toMatchObject({ stashAccount: ALICE, nominatedValidators: ['0xvalidator1'] });
  });

  it('v8 Rewarded decodes the RewardDestination and resolves the recipient account', async () => {
    const db = mockStore();

    await handleStakingEvent(
      namedEvent({
        section: 'staking',
        method: 'Rewarded',
        fields: { stash: ALICE, dest: { account: BOB }, amount: '500' },
      })
    );

    const [row] = Object.values(db.StakingEvent) as any[];

    expect(row).toMatchObject({
      stashAccount: ALICE,
      amount: BigInt(500),
      rewardDestination: 'Account',
      rewardDestinationAccount: BOB,
    });
  });

  it('SlashReported logs the reported validator, not an anomaly, at either era', async () => {
    const db = mockStore();

    await handleStakingEvent(
      namedEvent({
        section: 'staking',
        method: 'SlashReported',
        fields: { validator: ALICE, fraction: 100_000, slashEra: 12 },
      })
    );

    expect(Object.values(db.StakingEvent)[0]).toMatchObject({ stashAccount: ALICE });
    expect(db.IndexerAnomaly ?? {}).toEqual({});

    await handleStakingEvent(
      tupleEvent({
        section: 'staking',
        method: 'SlashReported',
        data: [codec(ALICE), codec(100_000), codec(12)],
        specVersion: 7_004_001,
        idx: 1,
      })
    );

    expect(Object.values(db.StakingEvent)).toHaveLength(2);
    expect(db.IndexerAnomaly ?? {}).toEqual({});
  });

  it('v8 Bonded/Unbonded still decode amount through the named-field path', async () => {
    const db = mockStore();

    await handleStakingEvent(
      namedEvent({ section: 'staking', method: 'Bonded', fields: { stash: ALICE, amount: '4000' } })
    );

    const [row] = Object.values(db.StakingEvent) as any[];

    expect(row).toMatchObject({ stashAccount: ALICE, amount: BigInt(4000) });
  });

  it('stamps eraIndex from the same PayoutStarted cache PolyxEntry already uses, and links the position', async () => {
    const db = mockStore({
      StakingPosition: {
        [ALICE]: {
          id: ALICE,
          stashId: ALICE,
          bonded: BigInt(0),
          unbonding: BigInt(0),
          isValidator: false,
          isChilled: false,
          totalRewarded: BigInt(0),
          totalSlashed: BigInt(0),
        },
      },
    });

    await handlePayoutStarted(
      namedEvent({
        section: 'staking',
        method: 'PayoutStarted',
        fields: { eraIndex: 7, validatorStash: ALICE },
      })
    );

    await handleStakingEvent(
      namedEvent({
        section: 'staking',
        method: 'Rewarded',
        fields: { stash: ALICE, dest: { account: BOB }, amount: '500' },
        idx: 1,
      })
    );

    const [row] = Object.values(db.StakingEvent) as any[];

    expect(row).toMatchObject({ stashAccount: ALICE, eraIndex: 7, positionId: ALICE });
    expect(db.StakingPosition[ALICE]).toMatchObject({
      totalRewarded: BigInt(500),
      rewardDestination: 'Account',
      rewardDestinationAccountId: BOB,
    });
  });

  it("links StakingEvent.position on a stash's very first Bonded (project.ts must run handlePositionBonded before handleStakingEvent)", async () => {
    const db = mockStore();
    (globalThis as any).api.query = {
      ...mockLedgerAccountQuery(),
      staking: { bonded: jest.fn().mockRejectedValue(new Error('no ledger')) },
    };

    const event = namedEvent({
      section: 'staking',
      method: 'Bonded',
      fields: { stash: ALICE, amount: '4000' },
    });

    // project.ts registers `Bonded: ['handlePositionBonded', 'handleStakingEvent', ...]` — in
    // that order, so the position exists by the time `handleStakingEvent` looks it up.
    await handlePositionBonded(event);
    await handleStakingEvent(event);

    const [row] = Object.values(db.StakingEvent) as any[];

    expect(row).toMatchObject({ positionId: ALICE });
  });
});

/**
 * S1 — `StakingPosition.bonded`/`unbonding` are a view onto `staking.ledger`, but two events
 * rewrite that ledger without emitting `Bonded`/`Unbonded`/`Withdrawn`: a compounded
 * (`RewardDestination::Staked`) reward, which `make_payout` adds straight onto `active`/`total`,
 * and a slash, which `do_slash` subtracts. Refreshing only on the three registered events left the
 * position falling further behind the real bond every era.
 */
describe('a ledger change with no Bonded event still refreshes the position (S1)', () => {
  const mockLedger = (active: string) => {
    (globalThis as any).api.query = {
      ...mockLedgerAccountQuery(),
      staking: {
        bonded: jest.fn().mockResolvedValue({ toJSON: () => null }),
        ledger: jest.fn().mockResolvedValue({
          toJSON: () => ({ total: active, active, unlocking: [] }),
        }),
      },
    };
  };

  it('a compounded Staked reward re-reads the ledger', async () => {
    const db = mockStore();

    mockLedger('4000');
    await handlePositionBonded(
      namedEvent({ section: 'staking', method: 'Bonded', fields: { stash: ALICE, amount: '4000' } })
    );
    expect(db.StakingPosition[ALICE].bonded).toBe(BigInt(4000));

    // the payout compounded 150 into the bond; only `Rewarded` is emitted
    mockLedger('4150');
    await handleStakingEvent(
      namedEvent({
        section: 'staking',
        method: 'Rewarded',
        fields: { stash: ALICE, dest: 'Staked', amount: '150' },
        blockNumber: '1001',
      })
    );

    expect(db.StakingPosition[ALICE]).toMatchObject({
      bonded: BigInt(4150),
      totalRewarded: BigInt(150),
    });
  });

  it('a slash re-reads the ledger', async () => {
    const db = mockStore();

    mockLedger('4000');
    await handlePositionBonded(
      namedEvent({ section: 'staking', method: 'Bonded', fields: { stash: ALICE, amount: '4000' } })
    );

    mockLedger('3600');
    await handleStakingEvent(
      namedEvent({
        section: 'staking',
        method: 'Slashed',
        fields: { staker: ALICE, amount: '400' },
        blockNumber: '1001',
      })
    );

    expect(db.StakingPosition[ALICE]).toMatchObject({
      bonded: BigInt(3600),
      totalSlashed: BigInt(400),
    });
  });

  it('a reward paid out to a free balance does not re-read the ledger', async () => {
    const db = mockStore();

    mockLedger('4000');
    await handlePositionBonded(
      namedEvent({ section: 'staking', method: 'Bonded', fields: { stash: ALICE, amount: '4000' } })
    );

    const ledgerRead = (globalThis as any).api.query.staking.ledger as jest.Mock;
    ledgerRead.mockClear();

    await handleStakingEvent(
      namedEvent({
        section: 'staking',
        method: 'Rewarded',
        fields: { stash: ALICE, dest: 'Stash', amount: '150' },
        blockNumber: '1001',
      })
    );

    expect(ledgerRead).not.toHaveBeenCalled();
    expect(db.StakingPosition[ALICE]).toMatchObject({
      bonded: BigInt(4000),
      totalRewarded: BigInt(150),
    });
  });
});
