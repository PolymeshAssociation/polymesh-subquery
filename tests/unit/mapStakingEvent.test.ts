import { handleStakingEvent } from '../../src/mappings/entities/events/mapStakingEvent';
import { codec, mockStore, namedEvent, tupleEvent } from './helpers';

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
});
