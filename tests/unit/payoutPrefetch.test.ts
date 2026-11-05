/**
 * A pre-v8 payout block's payee reads, batched (`prefetchPayees`, src/utils/staking.ts): each
 * reward is a different stash, so per-stash reads cost one round-trip each. The block's payees,
 * and the controllers of those paid to their controller, are read in one multi-read each instead,
 * and the handlers find them in the per-block cache.
 */
import { __resetStakingCaches, resolveLegacyRewardDestination } from '../../src/utils/staking';

const [STAKED_A, STAKED_B, VIA_CONTROLLER, CONTROLLER] = [
  '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY',
  '5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty',
  '5FLSigC9HGRKVhB9FiEo4Y3koPsNmBmLJbpXg2mp1hXcS59Y',
  '5DAAnrj7VHTznn2AWBemMuyBwZWs6FNFjdyVXUeYum3PTXFy',
];

const reward = (stash: string) => ({
  event: {
    section: 'staking',
    method: 'Reward',
    data: [{ toString: () => '0xdid' }, { toString: () => stash }, { toString: () => '100' }],
  },
});

const block = (specVersion: number) =>
  ({
    specVersion,
    block: { header: { number: { toString: () => '5261433' } } },
    events: [reward(STAKED_A), reward(STAKED_B), reward(VIA_CONTROLLER)],
  } as never);

const json = (value: unknown) => ({ toJSON: () => value });

describe('pre-v8 payout reads, batched per block', () => {
  let query: Record<string, jest.Mock & { multi: jest.Mock }>;

  beforeEach(() => {
    __resetStakingCaches();
    const storage = (single: unknown, multi: (keys: string[]) => unknown[]) =>
      Object.assign(jest.fn().mockResolvedValue(json(single)), {
        multi: jest.fn((keys: string[]) => Promise.resolve(multi(keys).map(json))),
      });
    query = {
      payee: storage('Stash', keys =>
        keys.map(stash => (stash === VIA_CONTROLLER ? 'Controller' : 'Staked'))
      ),
      bonded: storage(null, keys =>
        keys.map(stash => (stash === VIA_CONTROLLER ? CONTROLLER : null))
      ),
      ledger: storage(null, keys =>
        keys.map(() => ({ total: '5000', active: '4500', unlocking: [] }))
      ),
    };
    (globalThis as any).api.query = { staking: query };
  });

  it('reads every stash the block rewards in one multi-read per item, and nothing per stash', async () => {
    const b = block(5_000_004);

    const destinations = await Promise.all(
      [STAKED_A, STAKED_B, VIA_CONTROLLER].map(stash =>
        resolveLegacyRewardDestination(stash, '0005261433', b)
      )
    );

    expect(destinations).toEqual([
      { rewardDestination: 'Staked', rewardDestinationAccount: STAKED_A },
      { rewardDestination: 'Staked', rewardDestinationAccount: STAKED_B },
      { rewardDestination: 'Controller', rewardDestinationAccount: CONTROLLER },
    ]);
    expect(query.payee.multi).toHaveBeenCalledTimes(1);
    expect(query.bonded.multi).toHaveBeenCalledTimes(1);
    expect(query.bonded.multi).toHaveBeenCalledWith([VIA_CONTROLLER]);
    expect(query.payee).not.toHaveBeenCalled();
    expect(query.bonded).not.toHaveBeenCalled();
  });

  it('leaves a v8 block to its events, which name each destination', async () => {
    await resolveLegacyRewardDestination(STAKED_A, '0025000000', block(8_000_020));

    expect(query.payee.multi).not.toHaveBeenCalled();
    expect(query.payee).toHaveBeenCalledTimes(1);
  });

  it('reads again when the block is retried after a failed read', async () => {
    query.payee.multi.mockRejectedValueOnce(new Error('WebSocket is not connected'));

    await expect(
      resolveLegacyRewardDestination(STAKED_A, '0005261433', block(5_000_004))
    ).rejects.toThrow('WebSocket is not connected');
    expect(await resolveLegacyRewardDestination(STAKED_A, '0005261433', block(5_000_004))).toEqual({
      rewardDestination: 'Staked',
      rewardDestinationAccount: STAKED_A,
    });
    expect(query.payee.multi).toHaveBeenCalledTimes(2);
  });
});
