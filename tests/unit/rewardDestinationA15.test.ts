/**
 * Defect A15 — pre-v8 staking rewards and the account that received them.
 *
 * Measured across a spread of eras (`scripts/measure-a15-payees.ts`): a large share of pre-v8
 * mainnet rewards were paid to a `Controller` or an explicit `Account`, not the stash. So
 * `handleStakingEvent` now reads `staking.payee(stash)` from chain storage at the reward block
 * (`resolveLegacyRewardDestination`) rather than recording `LegacyUnknown`.
 *
 * These tests pin: the storage read resolves `Controller`/`Account`/`Staked`; and the
 * `LegacyUnknown` placeholder still stands when the read is not possible (a pruned node), so it
 * is never silently resolved to something wrong.
 */

import { SubstrateEvent } from '@subql/types';
import { handleStakingEvent } from '../../src/mappings/entities/events/mapStakingEvent';

const STASH = '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY';
const PAYEE = '5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty';
const CONTROLLER = '5DAAnrj7VHTznn2AWBemMuyBwZWs6FNFjdyVXUeYum3PTXFy';

const storeSet = (): jest.Mock => (globalThis as any).store.set as jest.Mock;

const mockPayee = (payee: any, bonded?: string) => {
  (globalThis as any).api.query = {
    staking: {
      payee: jest.fn().mockResolvedValue({ toJSON: () => payee }),
      bonded: jest.fn().mockResolvedValue({ toJSON: () => bonded ?? null }),
    },
  };
};

const codec = (value: string) => ({ toString: () => value, toJSON: () => value });

const rewardEvent = (
  method: 'Reward' | 'Rewarded',
  data: any[],
  specVersion: number
): SubstrateEvent =>
  ({
    idx: 1,
    block: {
      block: { header: { number: { toString: () => '5000' } } },
      timestamp: new Date('2022-01-01T00:00:00Z'),
      specVersion,
    },
    event: {
      section: 'staking',
      method,
      data,
      meta: { fields: data.map(() => ({ name: { isSome: false }, typeName: { isSome: false } })) },
    },
    extrinsic: undefined,
  } as unknown as SubstrateEvent);

const savedStakingEvent = () =>
  storeSet()
    .mock.calls.filter(([entity]) => entity === 'StakingEvent')
    .map(([, , row]) => row)
    .at(-1);

beforeEach(() => {
  (globalThis as any).api.runtimeVersion.specName = { toString: () => 'polymesh' };
  (globalThis as any).api.query = {};
});

describe('A15 — pre-v8 reward destination', () => {
  it('reads staking.payee and resolves a Controller payee to the controller account', async () => {
    mockPayee('Controller', CONTROLLER);

    await handleStakingEvent(
      rewardEvent('Reward', [codec('0x00'), codec(STASH), codec('1000')], 7_004_001)
    );

    const row = savedStakingEvent();
    expect(row.rewardDestination).toBe('Controller');
    expect(row.rewardDestinationAccount).toBe(CONTROLLER);
    expect(row.stashAccount).toBe(STASH);
  });

  it('resolves an explicit Account payee', async () => {
    mockPayee({ account: PAYEE });

    await handleStakingEvent(
      rewardEvent('Rewarded', [codec('0x00'), codec(STASH), codec('2000')], 7_000_000)
    );

    const row = savedStakingEvent();
    expect(row.rewardDestination).toBe('Account');
    expect(row.rewardDestinationAccount).toBe(PAYEE);
  });

  it('resolves Staked/Stash to the stash itself', async () => {
    mockPayee('Staked');

    await handleStakingEvent(
      rewardEvent('Reward', [codec('0x00'), codec(STASH), codec('1500')], 7_004_001)
    );

    expect(savedStakingEvent()).toMatchObject({
      rewardDestination: 'Staked',
      rewardDestinationAccount: STASH,
    });
  });

  it('falls back to LegacyUnknown when the payee read is not possible, never to the stash', async () => {
    // api.query.staking absent — a pruned node or a runtime with no such storage
    await handleStakingEvent(
      rewardEvent('Reward', [codec('0x00'), codec(STASH), codec('1000')], 7_004_001)
    );

    const row = savedStakingEvent();
    expect(row.rewardDestination).toBe('LegacyUnknown');
    expect(row.rewardDestinationAccount).toBeUndefined();
  });

  it('v8 resolves the destination account for an explicit Account payee', async () => {
    await handleStakingEvent(
      rewardEvent(
        'Rewarded',
        [codec(STASH), { toJSON: () => ({ Account: PAYEE }) }, codec('3000')],
        8_000_000
      )
    );

    const row = savedStakingEvent();
    expect(row.rewardDestination).toBe('Account');
    expect(row.rewardDestinationAccount).toBe(PAYEE);
  });

  it('v8 resolves Staked/Stash to the stash itself', async () => {
    await handleStakingEvent(
      rewardEvent('Rewarded', [codec(STASH), { toJSON: () => 'Staked' }, codec('4000')], 8_000_000)
    );

    const row = savedStakingEvent();
    expect(row.rewardDestination).toBe('Staked');
    expect(row.rewardDestinationAccount).toBe(STASH);
  });
});
