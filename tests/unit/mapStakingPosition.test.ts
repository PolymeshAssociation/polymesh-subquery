/**
 * `StakingPosition.bonded`/`unbonding` must read the same `staking.ledger` chain state
 * `AccountBalance.bonded`/`.locks`/`.holds` already track (`readStakingLedger` in
 * `src/utils/staking.ts`), not accumulate an independent delta that can drift from it.
 */
import {
  handlePositionBonded,
  handlePositionUnbonded,
  handlePositionWithdrawn,
  handleSetController,
} from '../../src/mappings/entities/events/mapStakingPosition';
import { IndexerAnomaly } from '../../src/types';
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
        // a later block: within one, every ledger read returns the block's end state
        blockNumber: '1001',
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
        blockNumber: '1002',
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

/**
 * The controller is a relation, and `set_controller` can name an account nothing else has indexed —
 * so the row it points at has to exist before the pointer moves, as it does at creation.
 */
describe('a controller change', () => {
  it('ensures the new controller has an Account row before pointing at it', async () => {
    const db = mockStore();

    mockLedger('4200', [], 'CONTROLLER_A');
    await handlePositionBonded(
      namedEvent({
        section: 'staking',
        method: 'Bonded',
        fields: { stash: ALICE, amount: '1' },
        blockNumber: '3000',
      })
    );
    mockLedger('4200', [], 'CONTROLLER_B');
    await handlePositionBonded(
      namedEvent({
        section: 'staking',
        method: 'Bonded',
        fields: { stash: ALICE, amount: '1' },
        blockNumber: '3001',
      })
    );

    expect(db.StakingPosition[ALICE].controllerId).toBe('CONTROLLER_B');
    expect(db.Account.CONTROLLER_B).toBeDefined();
  });
});

/**
 * When `staking.ledger` cannot be read the figures are estimated from the event, which is worth
 * knowing — and the unlocking schedule cannot be estimated at all, so it is dropped rather than left
 * describing a ledger the estimate has moved past.
 */
describe('the ledger fallback', () => {
  it('reports the estimate and drops the unlocking schedule it cannot reconstruct', async () => {
    const db = mockStore({
      StakingPosition: {
        [ALICE]: {
          id: ALICE,
          stashId: ALICE,
          controllerId: ALICE,
          bonded: BigInt(5000),
          unbonding: BigInt(0),
          unlocking: [{ value: BigInt(10), era: 3 }],
        },
      },
    });
    (globalThis as any).api.query = { ...mockLedgerAccountQuery() };
    const anomaly = jest.spyOn(IndexerAnomaly.prototype, 'save').mockResolvedValue(undefined);

    await handlePositionUnbonded(
      namedEvent({
        section: 'staking',
        method: 'Unbonded',
        fields: { stash: ALICE, amount: '1000' },
      })
    );

    expect(db.StakingPosition[ALICE]).toMatchObject({
      bonded: BigInt(4000),
      unbonding: BigInt(1000),
    });
    expect(db.StakingPosition[ALICE].unlocking).toBeUndefined();
    expect(anomaly).toHaveBeenCalled();
  });
});

/**
 * `set_controller` emits nothing, so a position used to keep naming the old controller until some
 * other event re-read the ledger — for an idle stash, possibly never. The call itself is the signal.
 */
describe('handleSetController', () => {
  const setControllerCall = (blockNumber: string) =>
    ({
      idx: 1,
      block: {
        block: {
          header: {
            number: { toString: () => blockNumber },
            parentHash: '0xparent',
            hash: { toHex: () => `0xhash${blockNumber}` },
          },
        },
        timestamp: new Date('2024-01-01T00:00:00Z'),
        specVersion: 7_004_000,
        events: [
          {
            phase: { isApplyExtrinsic: true, asApplyExtrinsic: { toNumber: () => 1 } },
            event: {
              section: 'system',
              method: 'ExtrinsicSuccess',
              data: [],
              meta: { fields: [] },
            },
          },
        ],
      },
      extrinsic: {
        signer: { toString: () => ALICE },
        method: { section: 'staking', method: 'setController' },
      },
      success: true,
    } as any);

  // the call handler checks the block's spec label against the runtime that executed it
  const runtimeVersion = () => {
    (globalThis as any).api.rpc = {
      state: {
        getRuntimeVersion: jest.fn(async () => ({ specVersion: { toNumber: () => 7_004_000 } })),
      },
    };
  };

  it('moves the position to the new controller at the call, with its row and provenance', async () => {
    runtimeVersion();
    const db = mockStore({
      StakingPosition: {
        [ALICE]: {
          id: ALICE,
          stashId: ALICE,
          controllerId: 'CONTROLLER_A',
          bonded: BigInt(1),
          unbonding: BigInt(0),
        },
      },
    });
    mockLedger('4200', [], 'CONTROLLER_B');

    await handleSetController(setControllerCall('5000'));

    expect(db.StakingPosition[ALICE]).toMatchObject({
      controllerId: 'CONTROLLER_B',
      updatedEventId: '0000005000/0000000000',
    });
    expect(db.Account.CONTROLLER_B).toBeDefined();
    expect(db.Event['0000005000/0000000000']).toBeDefined();
  });

  it('does nothing for a stash the index has no position for', async () => {
    runtimeVersion();
    const db = mockStore();
    mockLedger('4200', [], 'CONTROLLER_B');

    await handleSetController(setControllerCall('5001'));

    expect(db.StakingPosition).toBeUndefined();
  });
});
