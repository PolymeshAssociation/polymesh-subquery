import { __resetStakingCaches, readStakingLedger } from '../../src/utils/staking';

const STASH = '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY';

describe('readStakingLedger', () => {
  let ledger: jest.Mock;

  beforeEach(() => {
    __resetStakingCaches();
    ledger = jest.fn().mockResolvedValue({
      toJSON: () => ({ total: '100', active: '80', unlocking: [{ value: '20', era: 7 }] }),
    });
    (globalThis as any).api.query = {
      staking: {
        bonded: jest.fn().mockResolvedValue({ toJSON: () => null }),
        ledger,
      },
    };
  });

  it("reads a stash's ledger once per block, however many handlers ask", async () => {
    // a payout block restakes many rewards, and both the balance ledger and `StakingPosition` read
    // each stash's ledger; `api.query` returns the block's end state, so one read answers both
    const first = await readStakingLedger(STASH, '0000000100');
    const second = await readStakingLedger(STASH, '0000000100');

    expect(ledger).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
    expect(first).toEqual({
      total: BigInt(100),
      active: BigInt(80),
      unlocking: [{ amount: BigInt(20), era: 7 }],
    });
  });

  it('reads it again in the next block', async () => {
    await readStakingLedger(STASH, '0000000100');
    await readStakingLedger(STASH, '0000000101');

    expect(ledger).toHaveBeenCalledTimes(2);
  });

  it('fails on a failed read rather than reporting an empty ledger', async () => {
    ledger.mockRejectedValueOnce(new Error('WebSocket is not connected'));

    await expect(readStakingLedger(STASH, '0000000100')).rejects.toThrow(
      'WebSocket is not connected'
    );
    expect(await readStakingLedger(STASH, '0000000100')).toBeDefined();
  });
});
