/**
 * `StakingPosition.bonded`/`unbonding` must read the same `staking.ledger` chain state
 * `AccountBalance.bonded`/`.locks`/`.holds` already track (`readStakingLedger` in
 * `src/utils/staking.ts`), not accumulate an independent delta that can drift from it.
 */
import {
  handlePositionBonded,
  handlePositionUnbonded,
  handlePositionWithdrawn,
} from '../../src/mappings/entities/events/mapStakingPosition';
import { __resetStakingCaches } from '../../src/utils/staking';
import { codec, mockLedgerAccountQuery, mockStore, namedEvent, tupleEvent } from './helpers';

const ALICE = '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY';

const mockLedger = (
  active: string,
  unlocking: { value: string; era: number }[] = [],
  bonded: string | null = null
) => {
  const total = unlocking.reduce((sum, c) => sum + BigInt(c.value), BigInt(active));

  (globalThis as any).api.query = {
    ...mockLedgerAccountQuery(),
    staking: {
      bonded: jest.fn().mockResolvedValue({ toJSON: () => bonded }),
      ledger: jest.fn().mockResolvedValue({
        toJSON: () => ({ total: total.toString(), active, unlocking }),
      }),
    },
  };
};

beforeEach(() => {
  __resetStakingCaches();
});

describe('handlePositionBonded', () => {
  it('sets bonded from the staking ledger active amount, not the event amount', async () => {
    const db = mockStore();
    mockLedger('4200');

    await handlePositionBonded(
      namedEvent({ section: 'staking', method: 'Bonded', fields: { stash: ALICE, amount: '4000' } })
    );

    expect(db.StakingPosition[ALICE]).toMatchObject({
      stashId: ALICE,
      bonded: BigInt(4200),
      unbonding: BigInt(0),
    });
  });

  it('v7 Bonded (tuple event) resolves bonded through the same ledger read', async () => {
    const db = mockStore();
    mockLedger('4200');

    await handlePositionBonded(
      tupleEvent({
        section: 'staking',
        method: 'Bonded',
        data: [codec('0xdid'), codec(ALICE), codec('4000')],
        specVersion: 7_004_001,
      })
    );

    expect(db.StakingPosition[ALICE].bonded).toBe(BigInt(4200));
  });

  it('falls back to accumulating the event amount when the ledger cannot be read', async () => {
    const db = mockStore();
    (globalThis as any).api.query = { ...mockLedgerAccountQuery() };

    await handlePositionBonded(
      namedEvent({ section: 'staking', method: 'Bonded', fields: { stash: ALICE, amount: '4000' } })
    );

    expect(db.StakingPosition[ALICE].bonded).toBe(BigInt(4000));
  });

  it('floors the fallback delta at zero instead of going negative on a first, ledger-unreadable Unbonded', async () => {
    const db = mockStore();
    (globalThis as any).api.query = { ...mockLedgerAccountQuery() };

    // No prior `Bonded` seen (e.g. mid-resync) — the fallback has nothing to subtract from.
    await handlePositionUnbonded(
      namedEvent({
        section: 'staking',
        method: 'Unbonded',
        fields: { stash: ALICE, amount: '1000' },
      })
    );

    expect(db.StakingPosition[ALICE].bonded).toBe(BigInt(0));
    expect(db.StakingPosition[ALICE].unbonding).toBe(BigInt(1000));
  });
});

describe('handlePositionUnbonded / handlePositionWithdrawn', () => {
  it('moves bonded to unbonding with an UnlockChunk, then Withdrawn decrements unbonding', async () => {
    const db = mockStore();
    mockLedger('4000');

    await handlePositionBonded(
      namedEvent({ section: 'staking', method: 'Bonded', fields: { stash: ALICE, amount: '4000' } })
    );

    mockLedger('3000', [{ value: '1000', era: 50 }]);

    await handlePositionUnbonded(
      namedEvent({
        section: 'staking',
        method: 'Unbonded',
        fields: { stash: ALICE, amount: '1000' },
        idx: 1,
      })
    );

    expect(db.StakingPosition[ALICE]).toMatchObject({
      bonded: BigInt(3000),
      unbonding: BigInt(1000),
    });
    expect(db.StakingPosition[ALICE].unlocking).toEqual([{ amount: BigInt(1000), era: 50 }]);

    mockLedger('3000', []);

    await handlePositionWithdrawn(
      namedEvent({
        section: 'staking',
        method: 'Withdrawn',
        fields: { stash: ALICE, amount: '1000' },
        idx: 2,
      })
    );

    expect(db.StakingPosition[ALICE]).toMatchObject({ bonded: BigInt(3000), unbonding: BigInt(0) });
  });
});

/**
 * The payee and controller reads used to be cached for the life of the process, which made the
 * answer depend on where the sync happened to start and left `set_payee` / `set_controller`
 * permanently unnoticed — neither emits an event to invalidate on.
 */
describe('the staking reads are cached per block, not per process (F6)', () => {
  it('picks up a controller change in a later block', async () => {
    const db = mockStore();

    mockLedger('4200', [], 'CONTROLLER_A');
    await handlePositionBonded(
      namedEvent({
        section: 'staking',
        method: 'Bonded',
        fields: { stash: ALICE, amount: '4000' },
        blockNumber: '1000',
      })
    );

    expect(db.StakingPosition[ALICE].controllerId).toBe('CONTROLLER_A');

    // `set_controller` moves the ledger to a new key and emits nothing
    mockLedger('4200', [], 'CONTROLLER_B');
    await handlePositionBonded(
      namedEvent({
        section: 'staking',
        method: 'Bonded',
        fields: { stash: ALICE, amount: '4000' },
        blockNumber: '1001',
      })
    );

    expect(db.StakingPosition[ALICE].controllerId).toBe('CONTROLLER_B');
  });

  it('does not pin the stash fallback for a stash that has not bonded yet', async () => {
    const db = mockStore();

    // `bonded(stash)` is empty before the bond lands, so the controller resolves to the stash…
    mockLedger('0', [], null);
    await handlePositionBonded(
      namedEvent({
        section: 'staking',
        method: 'Bonded',
        fields: { stash: ALICE, amount: '0' },
        blockNumber: '2000',
      })
    );

    expect(db.StakingPosition[ALICE].controllerId).toBe(ALICE);

    // …and the real controller is picked up as soon as the chain names one
    mockLedger('4200', [], 'CONTROLLER_A');
    await handlePositionBonded(
      namedEvent({
        section: 'staking',
        method: 'Bonded',
        fields: { stash: ALICE, amount: '4000' },
        blockNumber: '2001',
      })
    );

    expect(db.StakingPosition[ALICE].controllerId).toBe('CONTROLLER_A');
  });
});
