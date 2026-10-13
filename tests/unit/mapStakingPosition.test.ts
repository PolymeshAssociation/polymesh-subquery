/**
 * `StakingPosition.bonded`/`unbonding` must read the same `staking.ledger` chain state
 * `AccountBalance.bonded`/`.locks`/`.holds` already track (`readStakingLedger` in
 * `src/utils/staking.ts`), not accumulate an independent delta that can drift from it.
 */
import {
  handlePositionBonded,
  handlePositionUnbonded,
  handlePositionWithdrawn,
  handlePositionCurrencyMigrated,
  handleBatchedStakingCalls,
  handlePositionAfterProposal,
  handleRebond,
  handleSetController,
} from '../../src/mappings/entities/events/mapStakingPosition';
import { IndexerAnomaly } from '../../src/types';
import { __resetStakingCaches } from '../../src/utils/staking';
import { __resetBlockContext } from '../../src/mappings/blockContext';
import {
  codec,
  mockLedgerAccountQuery,
  mockSelfControlled,
  mockStore,
  namedEvent,
  tupleEvent,
} from './helpers';

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
  __resetBlockContext();
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

  it('fails the block when the ledger read fails, rather than estimating from the event', async () => {
    const db = mockStore();
    (globalThis as any).api.query = {
      ...mockLedgerAccountQuery(),
      staking: {
        ...mockSelfControlled(),
        ledger: jest.fn().mockRejectedValue(new Error('WebSocket is not connected')),
      },
    };

    await expect(
      handlePositionBonded(
        namedEvent({
          section: 'staking',
          method: 'Bonded',
          fields: { stash: ALICE, amount: '4000' },
        })
      )
    ).rejects.toThrow('WebSocket is not connected');
    expect(db.StakingPosition?.[ALICE]?.bonded ?? BigInt(0)).toBe(BigInt(0));
  });
});

describe('a ledger that does not decode', () => {
  it('records an anomaly and leaves the position as it was', async () => {
    const db = mockStore();
    mockLedger('4200');
    await handlePositionBonded(
      namedEvent({ section: 'staking', method: 'Bonded', fields: { stash: ALICE, amount: '4000' } })
    );
    __resetStakingCaches();
    const anomaly = jest.spyOn(IndexerAnomaly.prototype, 'save').mockResolvedValue(undefined);
    (globalThis as any).api.query.staking.ledger = jest
      .fn()
      .mockRejectedValue(new Error('createType(StakingLedger):: Struct: failed on total: u128'));

    await handlePositionUnbonded(
      namedEvent({
        section: 'staking',
        method: 'Unbonded',
        fields: { stash: ALICE, amount: '1000' },
        blockNumber: '1001',
      })
    );

    expect(anomaly).toHaveBeenCalledTimes(1);
    anomaly.mockRestore();
    expect(db.StakingPosition[ALICE]).toMatchObject({ bonded: BigInt(4200), unbonding: BigInt(0) });
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
    expect(db.StakingPosition[ALICE].unlocking).toEqual([{ amount: '1000', era: 50 }]);

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
    __resetBlockContext(); // the indexer opens each block as it reaches it
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
    __resetBlockContext(); // the indexer opens each block as it reaches it
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
    __resetBlockContext(); // the indexer opens each block as it reaches it
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

describe('handleRebond', () => {
  const STASH = 'STASH_A';

  const rebondCall = (
    blockNumber: string,
    extraEvents: { section: string; method: string }[] = []
  ) =>
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
        timestamp: new Date('2020-01-01T00:00:00Z'),
        specVersion: 3_002,
        events: [...extraEvents, { section: 'system', method: 'ExtrinsicSuccess' }].map(
          ({ section, method }) => ({
            phase: { isApplyExtrinsic: true, asApplyExtrinsic: { toNumber: () => 1 } },
            event: { section, method, data: [], meta: { fields: [] } },
          })
        ),
      },
      extrinsic: {
        signer: { toString: () => 'CONTROLLER_A' },
        method: { section: 'staking', method: 'rebond' },
      },
      success: true,
    } as any);

  const chain = (active: string, unlocking: { value: string; era: number }[]) => {
    const total = unlocking.reduce((sum, c) => sum + BigInt(c.value), BigInt(active));
    (globalThis as any).api.rpc = {
      state: {
        getRuntimeVersion: jest.fn(async () => ({ specVersion: { toNumber: () => 3_002 } })),
      },
    };
    (globalThis as any).api.query = {
      ...mockLedgerAccountQuery(),
      staking: {
        bonded: jest.fn().mockResolvedValue({ toJSON: () => 'CONTROLLER_A' }),
        ledger: jest.fn().mockResolvedValue({
          toJSON: () => ({ stash: STASH, total: total.toString(), active, unlocking }),
        }),
      },
    };
  };

  const position = () => ({
    StakingPosition: {
      [STASH]: {
        id: STASH,
        stashId: STASH,
        controllerId: 'CONTROLLER_A',
        bonded: BigInt(0),
        unbonding: BigInt(5000),
      },
    },
  });

  it('moves the rebonded amount back to bonded, which no event announces before v7', async () => {
    const db = mockStore(position());
    chain('2000', [{ value: '3000', era: 10 }]);

    await handleRebond(rebondCall('1893033'));

    expect(db.StakingPosition[STASH]).toMatchObject({
      bonded: BigInt(2000),
      unbonding: BigInt(3000),
      updatedEventId: '0001893033/0000000000',
    });
  });

  it('leaves a rebond that emitted Bonded to the Bonded handler', async () => {
    const db = mockStore(position());
    chain('2000', [{ value: '3000', era: 10 }]);

    await handleRebond(rebondCall('1893034', [{ section: 'staking', method: 'Bonded' }]));

    expect(db.StakingPosition[STASH]).toMatchObject({ bonded: BigInt(0), unbonding: BigInt(5000) });
  });

  it('does nothing for a stash the index has no position for', async () => {
    const db = mockStore();
    chain('2000', [{ value: '3000', era: 10 }]);

    await handleRebond(rebondCall('1893035'));

    expect(db.StakingPosition).toBeUndefined();
  });
});

describe('handlePositionCurrencyMigrated', () => {
  it('re-reads a position whose ledger the v8 migration cut', async () => {
    const db = mockStore({
      StakingPosition: {
        [ALICE]: {
          id: ALICE,
          stashId: ALICE,
          controllerId: ALICE,
          bonded: BigInt(7040),
          unbonding: BigInt(0),
        },
      },
    });
    mockLedger('7039', [], ALICE);

    await handlePositionCurrencyMigrated(
      namedEvent({
        section: 'staking',
        method: 'CurrencyMigrated',
        fields: { stash: ALICE, forceWithdraw: '1' },
      })
    );

    expect(db.StakingPosition[ALICE]).toMatchObject({ bonded: BigInt(7039), unbonding: BigInt(0) });
  });

  it('leaves a position alone when nothing was withdrawn', async () => {
    const db = mockStore({
      StakingPosition: {
        [ALICE]: {
          id: ALICE,
          stashId: ALICE,
          controllerId: ALICE,
          bonded: BigInt(7040),
          unbonding: BigInt(0),
        },
      },
    });
    mockLedger('1', [], ALICE);

    await handlePositionCurrencyMigrated(
      namedEvent({
        section: 'staking',
        method: 'CurrencyMigrated',
        fields: { stash: ALICE, forceWithdraw: '0' },
      })
    );

    expect(db.StakingPosition[ALICE]).toMatchObject({ bonded: BigInt(7040) });
  });
});

describe('staking calls nested in a batch or a multisig proposal', () => {
  const call = (section: string, method: string, args: unknown[] = []) => ({
    section,
    method,
    args,
  });

  const batchCall = (blockNumber: string, method: unknown) =>
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
        specVersion: 7_001_000,
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
      extrinsic: { signer: { toString: () => ALICE }, method },
      success: true,
    } as any);

  const runtimeVersion = () => {
    (globalThis as any).api.rpc = {
      state: {
        getRuntimeVersion: jest.fn(async () => ({ specVersion: { toNumber: () => 7_001_000 } })),
      },
    };
  };

  const alicePosition = () => ({
    StakingPosition: {
      [ALICE]: {
        id: ALICE,
        stashId: ALICE,
        controllerId: 'CONTROLLER_A',
        bonded: BigInt(4200),
        unbonding: BigInt(0),
      },
    },
  });

  it("re-reads the signer's position after a batch that moved its controller", async () => {
    runtimeVersion();
    const db = mockStore(alicePosition());
    mockLedger('4200', [], 'CONTROLLER_B');

    await handleBatchedStakingCalls(
      batchCall(
        '17569823',
        call('utility', 'batchAll', [[call('staking', 'setController', ['CONTROLLER_B'])]])
      )
    );

    expect(db.StakingPosition[ALICE]).toMatchObject({
      controllerId: 'CONTROLLER_B',
      updatedEventId: '0017569823/0000000000',
    });
  });

  it('finds the call inside a batch nested in a batch', async () => {
    runtimeVersion();
    const db = mockStore(alicePosition());
    mockLedger('4200', [], 'CONTROLLER_B');

    const inner = call('utility', 'batch', [[call('staking', 'setController', ['CONTROLLER_B'])]]);
    await handleBatchedStakingCalls(batchCall('17569824', call('utility', 'batch', [[inner]])));

    expect(db.StakingPosition[ALICE].controllerId).toBe('CONTROLLER_B');
  });

  it('reads nothing for a batch with no such call', async () => {
    runtimeVersion();
    const db = mockStore(alicePosition());
    mockLedger('4200', [], 'CONTROLLER_B');
    const { bonded } = (globalThis as any).api.query.staking;

    await handleBatchedStakingCalls(
      batchCall('17569825', call('utility', 'batch', [[call('balances', 'transfer', [])]]))
    );

    expect(bonded).not.toHaveBeenCalled();
    expect(db.StakingPosition[ALICE].controllerId).toBe('CONTROLLER_A');
  });

  const proposal = (id: string, proposals: { module: string; call: string; args: string }[]) => ({
    [`${ALICE}/${id}`]: {
      id: `${ALICE}/${id}`,
      params: { isBatch: false, isBridge: false, proposals },
    },
  });

  const executed = (proposalId: string) =>
    namedEvent({
      section: 'multiSig',
      method: 'ProposalExecuted',
      fields: { callerDid: '0xdid', multisig: ALICE, proposalId, result: { ok: null } },
      blockNumber: '17569830',
    });

  it('re-reads a multisig stash position when its executed proposal set its controller', async () => {
    const db = mockStore({
      ...alicePosition(),
      MultiSigProposal: proposal('7', [{ module: 'staking', call: 'set_controller', args: '{}' }]),
    });
    mockLedger('4200', [], 'CONTROLLER_B');

    await handlePositionAfterProposal(executed('7'));

    expect(db.StakingPosition[ALICE].controllerId).toBe('CONTROLLER_B');
  });

  it('finds a set_controller in a batch inside the proposal', async () => {
    // the call's `toHuman()` args, as `handleMultiSigProposalAdded` stores them
    const nested = [
      { args: { controller: 'CONTROLLER_B' }, method: 'setController', section: 'staking' },
    ];
    const db = mockStore({
      ...alicePosition(),
      MultiSigProposal: proposal('9', [
        { module: 'utility', call: 'batch', args: JSON.stringify({ calls: nested }) },
      ]),
    });
    mockLedger('4200', [], 'CONTROLLER_B');

    await handlePositionAfterProposal(executed('9'));

    expect(db.StakingPosition[ALICE].controllerId).toBe('CONTROLLER_B');
  });

  it('reads nothing after a proposal that made no such call', async () => {
    const db = mockStore({
      ...alicePosition(),
      MultiSigProposal: proposal('10', [{ module: 'balances', call: 'transfer', args: '{}' }]),
    });
    mockLedger('4200', [], 'CONTROLLER_B');
    const { bonded } = (globalThis as any).api.query.staking;

    await handlePositionAfterProposal(executed('10'));

    expect(bonded).not.toHaveBeenCalled();
    expect(db.StakingPosition[ALICE].controllerId).toBe('CONTROLLER_A');
  });

  it("re-reads a multisig stash's position when the index has no record of the proposal", async () => {
    const db = mockStore(alicePosition());
    mockLedger('4200', [], 'CONTROLLER_B');

    await handlePositionAfterProposal(
      namedEvent({
        section: 'multiSig',
        method: 'ProposalExecuted',
        fields: { callerDid: '0xdid', multisig: ALICE, proposalId: '7', result: { ok: null } },
        blockNumber: '17569830',
      })
    );

    expect(db.StakingPosition[ALICE]).toMatchObject({ controllerId: 'CONTROLLER_B' });
  });

  it('does nothing for a multisig that neither stakes nor controls a stash', async () => {
    const db = mockStore();
    mockLedger('4200', [], 'CONTROLLER_B');
    ((globalThis as any).api.query.staking.ledger as jest.Mock).mockResolvedValue({
      toJSON: () => null,
    });

    await handlePositionAfterProposal(
      namedEvent({
        section: 'multiSig',
        method: 'ProposalExecuted',
        fields: { callerDid: '0xdid', multisig: ALICE, proposalId: '8', result: { ok: null } },
      })
    );

    expect(db.StakingPosition).toBeUndefined();
  });
});
