import { handlePositionBonded } from '../../src/mappings/entities/events/mapStakingPosition';
import { handleStakingEvent } from '../../src/mappings/entities/events/mapStakingEvent';
import { handlePayoutStarted } from '../../src/mappings/entities/identities/mapPolyxLedger';
import {
  codec,
  mockLedgerAccountQuery,
  mockStore,
  namedEvent,
  tupleEvent,
  unnamedMeta,
} from './helpers';

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

  describe('the identity of a pre-v8 Unbonded', () => {
    const STASH_DID = '0x0200000000000000000000000000000000000000000000000000000000000000';
    const ZERO_DID = `0x${'00'.repeat(32)}`;
    const SUDO_DID = '0x0300000000000000000000000000000000000000000000000000000000000000';

    const seedStash = () =>
      mockStore({ Account: { [ALICE]: { id: ALICE, address: ALICE, identityId: STASH_DID } } });

    const extrinsicPhase = (extrinsicIdx: number) => ({
      type: 'ApplyExtrinsic',
      isApplyExtrinsic: true,
      asApplyExtrinsic: { toNumber: () => extrinsicIdx },
    });
    const namedPhase = (type: string) => ({ type, isApplyExtrinsic: false });

    const record = (method: string, data: unknown[], phase: unknown = extrinsicPhase(1)) => ({
      phase,
      event: { section: 'staking', method, data, meta: unnamedMeta(data.length) },
    });

    const unbonded = (did: string, events: unknown[] = [], extrinsicIdx = 1) =>
      tupleEvent({
        section: 'staking',
        method: 'Unbonded',
        data: [codec(did), codec(ALICE), codec('500')],
        specVersion: 6_003_050,
        idx: 0,
        extrinsic: { idx: extrinsicIdx, extrinsic: { hash: { toJSON: () => '0xab' } } },
        events,
      });

    it('keeps the caller identity of an ordinary unbond', async () => {
      const db = seedStash();

      await handleStakingEvent(unbonded(STASH_DID));

      expect(Object.values(db.StakingEvent)[0]).toMatchObject({ identityId: STASH_DID });
    });

    it('falls back to the stash identity when the origin was root (zero DID)', async () => {
      const db = seedStash();

      await handleStakingEvent(unbonded(ZERO_DID));

      expect(Object.values(db.StakingEvent)[0]).toMatchObject({ identityId: STASH_DID });
    });

    it('falls back to the stash identity when a CDD expiry run by a signed caller emitted it', async () => {
      const db = seedStash();
      const events = [
        record('Unbonded', []),
        record('InvalidatedNominators', [codec(SUDO_DID), codec(BOB), codec([ALICE])]),
      ];

      await handleStakingEvent(unbonded(SUDO_DID, events));

      expect(Object.values(db.StakingEvent)[0]).toMatchObject({ identityId: STASH_DID });
    });

    it('ignores an InvalidatedNominators from a different extrinsic', async () => {
      const db = seedStash();
      const events = [
        record('Unbonded', []),
        record(
          'InvalidatedNominators',
          [codec(SUDO_DID), codec(BOB), codec([ALICE])],
          extrinsicPhase(2)
        ),
      ];

      await handleStakingEvent(unbonded(SUDO_DID, events));

      expect(Object.values(db.StakingEvent)[0]).toMatchObject({ identityId: SUDO_DID });
    });

    const invalidated = (phase: unknown, nominators = [ALICE]) =>
      record('InvalidatedNominators', [codec(SUDO_DID), codec(BOB), codec(nominators)], phase);

    it('recognises a CDD expiry that ran outside any extrinsic, in the Initialization phase', async () => {
      const db = seedStash();
      const initialization = namedPhase('Initialization');
      const events = [record('Unbonded', [], initialization), invalidated(initialization)];

      await handleStakingEvent({ ...unbonded(SUDO_DID, events), extrinsic: undefined } as any);

      expect(Object.values(db.StakingEvent)[0]).toMatchObject({ identityId: STASH_DID });
    });

    it('stops scanning at a change of phase', async () => {
      const db = seedStash();
      const events = [record('Unbonded', []), invalidated(namedPhase('Finalization'))];

      await handleStakingEvent(unbonded(SUDO_DID, events));

      expect(Object.values(db.StakingEvent)[0]).toMatchObject({ identityId: SUDO_DID });
    });

    it('does not take another stash being expired for this one', async () => {
      const db = seedStash();
      const events = [record('Unbonded', []), invalidated(extrinsicPhase(1), [BOB])];

      await handleStakingEvent(unbonded(SUDO_DID, events));

      expect(Object.values(db.StakingEvent)[0]).toMatchObject({ identityId: SUDO_DID });
    });
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

  it("records which validator's payout paid each reward, and nothing on other events", async () => {
    const db = mockStore();
    const CAROL = '5FLSigC9HGRKVhB9FiEo4Y3koPsNmBmLJbpXg2mp1hXcS59Y';
    const payout = (validator: string, idx: number) =>
      handlePayoutStarted(
        namedEvent({
          section: 'staking',
          method: 'PayoutStarted',
          fields: { eraIndex: 7, validatorStash: validator, page: 0, next: null },
          blockNumber: '2000',
          idx,
        })
      );
    const event = (method: string, fields: Record<string, unknown>, idx: number) =>
      handleStakingEvent(
        namedEvent({ section: 'staking', method, fields, blockNumber: '2000', idx })
      );

    // two payouts back to back in one block, each paying a nominator
    await payout(ALICE, 0);
    await event('Rewarded', { stash: BOB, dest: 'Staked', amount: '10' }, 1);
    await payout(CAROL, 2);
    await event('Rewarded', { stash: BOB, dest: 'Staked', amount: '20' }, 3);
    await event('Bonded', { stash: BOB, amount: '5' }, 4);

    const rows = Object.values(db.StakingEvent) as any[];
    expect(rows.map(row => [row.eventId, row.validatorId])).toEqual([
      ['Rewarded', ALICE],
      ['Rewarded', CAROL],
      ['Bonded', undefined],
    ]);
  });

  /** Before v7.0 no `PayoutStarted` names the validator, so a reward records none. */
  it('records no validator for a pre-v7 reward', async () => {
    const db = mockStore();

    await handleStakingEvent(
      tupleEvent({
        section: 'staking',
        method: 'Reward',
        data: [codec('0xdid'), codec(BOB), codec('10')],
        specVersion: 6_000_000,
        blockNumber: '3000',
      })
    );

    expect(Object.values(db.StakingEvent)[0]).toMatchObject({ validatorId: undefined });
  });

  it("links StakingEvent.position on a stash's very first Bonded (project.ts must run handlePositionBonded before handleStakingEvent)", async () => {
    const db = mockStore();
    (globalThis as any).api.query = {
      ...mockLedgerAccountQuery(),
      staking: {
        bonded: jest.fn().mockResolvedValue({ toJSON: () => null }),
        ledger: jest.fn().mockResolvedValue({ toJSON: () => ({ total: '4000', active: '4000' }) }),
      },
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
 * `StakingPosition.bonded`/`unbonding` are a view onto `staking.ledger`, but two events
 * rewrite that ledger without emitting `Bonded`/`Unbonded`/`Withdrawn`: a compounded
 * (`RewardDestination::Staked`) reward, which `make_payout` adds straight onto `active`/`total`,
 * and a slash, which `do_slash` subtracts. Refreshing only on the three registered events left the
 * position falling further behind the real bond every era.
 */
/**
 * A v8 payout's events for one reward, as `make_payout` emits them: the mint's `Deposit`, then,
 * when the ledger write took, the `Staking` hold, then `Rewarded` (which the test event stands for).
 */
const payoutEvents = (stash: string, amount: string, held: boolean) =>
  [
    { section: 'balances', method: 'Deposit', data: [codec(stash), codec(amount)] },
    ...(held
      ? [
          {
            section: 'balances',
            method: 'Held',
            data: [codec({ staking: 'Staking' }), codec(stash), codec(amount)],
          },
        ]
      : []),
    { section: 'staking', method: 'Rewarded', data: [] },
  ].map(event => ({ event }));

describe('a ledger change with no Bonded event still refreshes the position', () => {
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

  it('a compounded Staked reward adds to the bond on v8, without reading the ledger', async () => {
    const db = mockStore();

    mockLedger('4000');
    await handlePositionBonded(
      namedEvent({ section: 'staking', method: 'Bonded', fields: { stash: ALICE, amount: '4000' } })
    );
    expect(db.StakingPosition[ALICE].bonded).toBe(BigInt(4000));

    // the payout compounded 150 into the bond: make_payout's `active += amount` is the whole
    // change, and the hold it writes announces it, so nothing is read
    mockLedger('4150');
    const { ledger } = (globalThis as any).api.query.staking;
    await handleStakingEvent(
      namedEvent({
        section: 'staking',
        method: 'Rewarded',
        fields: { stash: ALICE, dest: 'Staked', amount: '150' },
        blockNumber: '1001',
        idx: 2,
        events: payoutEvents(ALICE, '150', true),
      })
    );

    expect(db.StakingPosition[ALICE]).toMatchObject({
      bonded: BigInt(4150),
      totalRewarded: BigInt(150),
    });
    expect(ledger).not.toHaveBeenCalled();
  });

  /**
   * Testnet 25,037,006–25,106,271: a stash whose currency hadn't migrated to holds got 19
   * `Rewarded { dest: Staked }`, each with a `Deposit` and no `Held`. `make_payout` ignores a
   * failed ledger write, so the reward stayed free and `active` didn't move.
   */
  it('a v8 Staked reward with no Staking hold before it leaves the bond alone', async () => {
    const db = mockStore();

    mockLedger('4000');
    await handlePositionBonded(
      namedEvent({ section: 'staking', method: 'Bonded', fields: { stash: ALICE, amount: '4000' } })
    );

    await handleStakingEvent(
      namedEvent({
        section: 'staking',
        method: 'Rewarded',
        fields: { stash: ALICE, dest: 'Staked', amount: '150' },
        blockNumber: '1001',
        idx: 1,
        events: payoutEvents(ALICE, '150', false),
      })
    );

    expect(db.StakingPosition[ALICE]).toMatchObject({
      bonded: BigInt(4000),
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
