import { decodeEvent } from '../../src/decode';
import {
  handlePolyxLimitUpdated,
  handleSubsidyAccepted,
  handleSubsidyApproved,
  handleSubsidyDebited,
  handleSubsidyRemoved,
} from '../../src/mappings/entities/relayer/mapSubsidy';
import { AccountKeyRole } from '../../src/types';
import { codec, mockLedgerAccountQuery, mockStore, tupleEvent } from './helpers';

const USER_KEY = '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY';
const PAYING_KEY = '5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty';
const SUBSIDY_ID = `${USER_KEY}/${PAYING_KEY}`;

/** `getOrCreateAccount` short-circuits on an existing row, so seeding both keys skips the chain read */
const seedAccounts = () => ({
  Account: {
    [USER_KEY]: { id: USER_KEY },
    [PAYING_KEY]: { id: PAYING_KEY },
  },
});

type ChainSubsidies = {
  /** `relayer.subsidies(user)`: the subsidy the user has, if any */
  live?: { payingKey: string; remaining: number };
  /** `relayer.pendingSubsidies(user, payer)` (8.0): the limit of the offer pending, if any */
  pending?: number;
  /** paying-key authorizations pending for the user: `[authId, payingKey, limit]` */
  offers?: [number, string, number][];
};

/** The end-of-block subsidy state a handler reads. */
const chainSubsidies = ({ live, pending, offers = [] }: ChainSubsidies = {}) => ({
  relayer: {
    subsidies: jest.fn().mockResolvedValue({ toJSON: () => live ?? null }),
    pendingSubsidies: jest.fn().mockResolvedValue({ toJSON: () => pending ?? null }),
  },
  identity: {
    authorizations: {
      entries: jest
        .fn()
        .mockResolvedValue(
          offers.map(([authId, payingKey, limit]) => [
            { args: [codec({ Account: USER_KEY }), codec(authId)] },
            codec({ authorizationData: { addRelayerPayingKey: [USER_KEY, payingKey, limit] } }),
          ])
        ),
    },
  },
});

/** `relayer.subsidies` holding no entry for the user key, and no offer pending. */
const noSubsidyEntry = () => chainSubsidies();

/** `mockStore`, over a chain holding no subsidy and no offer for the user key */
const mockStoreAndChain: typeof mockStore = db => {
  const stored = mockStore(db);
  (globalThis as any).api.query = noSubsidyEntry();
  return stored;
};

describe('v8 subsidy lifecycle', () => {
  it('approve → accept → debit → remove produces one row through the full lifecycle', async () => {
    const db = mockStoreAndChain(seedAccounts());

    await handleSubsidyApproved(
      tupleEvent({
        section: 'relayer',
        method: 'ApprovedSubsidy',
        data: [codec(USER_KEY), codec(PAYING_KEY), codec(1_000)],
      })
    );

    expect(db.Subsidy[SUBSIDY_ID]).toMatchObject({
      beneficiaryAccountId: USER_KEY,
      payingAccountId: PAYING_KEY,
      allowance: BigInt(1_000),
      totalDebited: BigInt(0),
      isAccepted: false,
      isRemoved: false,
    });

    await handleSubsidyAccepted(
      tupleEvent({
        section: 'relayer',
        method: 'AcceptedSubsidy',
        data: [codec(USER_KEY), codec(PAYING_KEY), codec(1_000)],
        idx: 1,
      })
    );

    expect(db.Subsidy[SUBSIDY_ID].isAccepted).toBe(true);

    await handleSubsidyDebited(
      tupleEvent({
        section: 'relayer',
        method: 'SubsidyDebited',
        data: [codec(USER_KEY), codec(PAYING_KEY), codec(300)],
        idx: 2,
      })
    );

    expect(db.Subsidy[SUBSIDY_ID]).toMatchObject({
      totalDebited: BigInt(300),
      allowance: BigInt(700),
    });

    await handleSubsidyRemoved(
      tupleEvent({
        section: 'relayer',
        method: 'RemovedSubsidy',
        data: [codec(USER_KEY), codec(PAYING_KEY), codec(700)],
        idx: 3,
      })
    );

    // `RemovedSubsidy`'s third field is the allowance left when it ended, not an amount drawn
    expect(db.Subsidy[SUBSIDY_ID]).toMatchObject({ isRemoved: true, allowance: BigInt(700) });
  });
});

describe('the accounts a subsidy names', () => {
  it('creates both, even when the chain holds no key record for them', async () => {
    const db = mockStore({});
    (globalThis as any).api.query = { ...noSubsidyEntry(), ...mockLedgerAccountQuery() };

    await handleSubsidyApproved(
      tupleEvent({
        section: 'relayer',
        method: 'ApprovedSubsidy',
        data: [codec(USER_KEY), codec(PAYING_KEY), codec(1_000)],
      })
    );

    expect(db.Account[USER_KEY]).toMatchObject({
      address: USER_KEY,
      keyRole: AccountKeyRole.Unlinked,
    });
    expect(db.Account[PAYING_KEY]).toMatchObject({
      address: PAYING_KEY,
      keyRole: AccountKeyRole.Unlinked,
    });
  });
});

describe('pre-v8 paying-key lifecycle', () => {
  const PRE_V8_SPEC = 6_000_000;

  it('authorize → accept → remove produces the equivalent row, reading initialPolyxLimit from params[3]', async () => {
    const db = mockStoreAndChain(seedAccounts());

    await handleSubsidyApproved(
      tupleEvent({
        section: 'relayer',
        method: 'AuthorizedPayingKey',
        data: [codec(TEST_DID), codec(USER_KEY), codec(PAYING_KEY), codec(500), codec(9)],
        specVersion: PRE_V8_SPEC,
      })
    );

    // nothing accumulates a debited total before v8, and a null says so where a zero would not
    expect(db.Subsidy[SUBSIDY_ID]).toMatchObject({ allowance: BigInt(500), isAccepted: false });
    expect(db.Subsidy[SUBSIDY_ID].totalDebited).toBeUndefined();

    await handleSubsidyAccepted(
      tupleEvent({
        section: 'relayer',
        method: 'AcceptedPayingKey',
        data: [codec(TEST_DID), codec(USER_KEY), codec(PAYING_KEY)],
        specVersion: PRE_V8_SPEC,
        idx: 1,
      })
    );

    // pre-v8 `AcceptedPayingKey` carries no limit — the allowance from the approval stands
    expect(db.Subsidy[SUBSIDY_ID]).toMatchObject({ isAccepted: true, allowance: BigInt(500) });

    await handleSubsidyRemoved(
      tupleEvent({
        section: 'relayer',
        method: 'RemovedPayingKey',
        data: [codec(TEST_DID), codec(USER_KEY), codec(PAYING_KEY)],
        specVersion: PRE_V8_SPEC,
        idx: 2,
      })
    );

    // `RemovedPayingKey` carries no figure, so the allowance stands as it was
    expect(db.Subsidy[SUBSIDY_ID]).toMatchObject({ isRemoved: true, allowance: BigInt(500) });
  });

  /**
   * The sequence a testnet resync tripped over: the paying key offered again while its subsidy was
   * live, and the acceptance removed the old subsidy and accepted the new one in the same call.
   * The row ended up both accepted and removed, so the ledger stopped charging the paying key and
   * debited the user for fees the chain had taken from the paying key.
   */
  it('keeps a subsidy live through a re-offer and its acceptance', async () => {
    const db = mockStoreAndChain(seedAccounts());
    // the chain's subsidy after the first acceptance, then after the second
    (globalThis as any).api.query = chainSubsidies({
      live: { payingKey: PAYING_KEY, remaining: 700 },
    });
    (globalThis as any).api.query.relayer.subsidies.mockResolvedValueOnce({
      toJSON: () => ({ payingKey: PAYING_KEY, remaining: 500 }),
    });
    const pairEvent = (method: string, idx: number, extra: unknown[] = []) =>
      tupleEvent({
        section: 'relayer',
        method,
        data: [
          codec(TEST_DID),
          codec(USER_KEY),
          codec(PAYING_KEY),
          ...extra.map(v => codec(v as number)),
        ],
        specVersion: PRE_V8_SPEC,
        idx,
      });

    await handleSubsidyApproved(pairEvent('AuthorizedPayingKey', 0, [500, 1]));
    await handleSubsidyAccepted(pairEvent('AcceptedPayingKey', 1));
    await handleSubsidyApproved(pairEvent('AuthorizedPayingKey', 2, [700, 2]));

    // an offer changes nothing while the earlier subsidy is live
    expect(db.Subsidy[SUBSIDY_ID]).toMatchObject({
      isAccepted: true,
      isRemoved: false,
      allowance: BigInt(500),
    });

    await handleSubsidyRemoved(pairEvent('RemovedPayingKey', 3));
    await handleSubsidyAccepted(pairEvent('AcceptedPayingKey', 4));

    expect(db.Subsidy[SUBSIDY_ID]).toMatchObject({
      isAccepted: true,
      isRemoved: false,
      allowance: BigInt(700),
    });
  });

  /**
   * `RemovedPendingSubsidy`'s third field is the initial limit of the offer being withdrawn, not an
   * allowance that was ever live — so it must not be written over one.
   */
  it('leaves the allowance alone when a pending subsidy is withdrawn', async () => {
    const db = mockStoreAndChain(seedAccounts());
    db.Subsidy = { [SUBSIDY_ID]: { id: SUBSIDY_ID, allowance: BigInt(500), isRemoved: false } };

    await handleSubsidyRemoved(
      tupleEvent({
        section: 'relayer',
        method: 'RemovedPendingSubsidy',
        data: [codec(USER_KEY), codec(PAYING_KEY), codec(999)],
      })
    );

    expect(db.Subsidy[SUBSIDY_ID]).toMatchObject({ isRemoved: true, allowance: BigInt(500) });
  });
});

describe('UpdatedPolyxLimit', () => {
  it('decodes 5 params pre-v8 and 4 params at v8+ with no arity error, setting allowance either way', async () => {
    const db = mockStoreAndChain(seedAccounts());
    db.Subsidy = { [SUBSIDY_ID]: { id: SUBSIDY_ID, allowance: BigInt(0) } };

    const preV8Event = tupleEvent({
      section: 'relayer',
      method: 'UpdatedPolyxLimit',
      data: [codec(TEST_DID), codec(USER_KEY), codec(PAYING_KEY), codec(200), codec(500)],
      specVersion: 6_000_000,
    });

    expect(() => decodeEvent(preV8Event)).not.toThrow();
    await handlePolyxLimitUpdated(preV8Event);
    expect(db.Subsidy[SUBSIDY_ID].allowance).toBe(BigInt(200));

    const v8Event = tupleEvent({
      section: 'relayer',
      method: 'UpdatedPolyxLimit',
      data: [codec(USER_KEY), codec(PAYING_KEY), codec(900), codec(200)],
      specVersion: 8_000_000,
      idx: 1,
    });

    expect(() => decodeEvent(v8Event)).not.toThrow();
    await handlePolyxLimitUpdated(v8Event);
    expect(db.Subsidy[SUBSIDY_ID].allowance).toBe(BigInt(900));
  });
});

/**
 * A paying key can be authorised through `identity.add_authorization` with
 * `AuthorizationData::AddRelayerPayingKey` instead of `relayer.set_paying_key`. That path emits
 * only `identity.AuthorizationAdded` — no `relayer.AuthorizedPayingKey` — so nothing creates the
 * row ahead of the acceptance. Seen on testnet at block 1,747,041 (authorization 0000002617),
 * where the acceptance and its later removal both reported a missing Subsidy.
 */
describe('an acceptance with no preceding relayer approval', () => {
  it('creates the Subsidy rather than reporting it missing', async () => {
    const db = mockStoreAndChain(seedAccounts());

    (globalThis as any).api.query = {
      relayer: {
        subsidies: jest.fn().mockResolvedValue({
          toJSON: () => ({ payingKey: PAYING_KEY, remaining: 1_000_000_000 }),
        }),
      },
    };

    await handleSubsidyAccepted(
      tupleEvent({
        section: 'relayer',
        method: 'AcceptedPayingKey',
        data: [codec('0xdid'), codec(USER_KEY), codec(PAYING_KEY)],
        specVersion: 3002,
      })
    );

    expect(db.Subsidy[SUBSIDY_ID]).toMatchObject({
      beneficiaryAccountId: USER_KEY,
      payingAccountId: PAYING_KEY,
      isAccepted: true,
      isRemoved: false,
      // pre-v8 `AcceptedPayingKey` carries no limit, so it comes from chain state
      allowance: BigInt(1_000_000_000),
    });
    expect(Object.keys(db.IndexerAnomaly ?? {})).toHaveLength(0);
  });

  it('starts at a zero allowance when the chain holds no subsidy entry', async () => {
    const db = mockStoreAndChain(seedAccounts());
    (globalThis as any).api.query = noSubsidyEntry();

    await handleSubsidyAccepted(
      tupleEvent({
        section: 'relayer',
        method: 'AcceptedPayingKey',
        data: [codec('0xdid'), codec(USER_KEY), codec(PAYING_KEY)],
        specVersion: 3002,
      })
    );

    expect(db.Subsidy[SUBSIDY_ID]).toMatchObject({ isAccepted: true, allowance: BigInt(0) });
  });

  it('fails the block when the subsidy read fails', async () => {
    mockStoreAndChain(seedAccounts());
    (globalThis as any).api.query = {
      relayer: { subsidies: jest.fn().mockRejectedValue(new Error('WebSocket is not connected')) },
    };

    await expect(
      handleSubsidyAccepted(
        tupleEvent({
          section: 'relayer',
          method: 'AcceptedPayingKey',
          data: [codec('0xdid'), codec(USER_KEY), codec(PAYING_KEY)],
          specVersion: 3002,
        })
      )
    ).rejects.toThrow('WebSocket is not connected');
  });

  it('a later removal then finds the row instead of anomalying', async () => {
    const db = mockStoreAndChain(seedAccounts());
    (globalThis as any).api.query = noSubsidyEntry();

    await handleSubsidyAccepted(
      tupleEvent({
        section: 'relayer',
        method: 'AcceptedPayingKey',
        data: [codec('0xdid'), codec(USER_KEY), codec(PAYING_KEY)],
        specVersion: 3002,
      })
    );
    await handleSubsidyRemoved(
      tupleEvent({
        section: 'relayer',
        method: 'RemovedPayingKey',
        data: [codec('0xdid'), codec(USER_KEY), codec(PAYING_KEY)],
        specVersion: 3002,
        idx: 1,
      })
    );

    expect(db.Subsidy[SUBSIDY_ID].isRemoved).toBe(true);
    expect(Object.keys(db.IndexerAnomaly ?? {})).toHaveLength(0);
  });
});

/**
 * The chain keeps an offer apart from the subsidy it would replace: before 8.0 each offer is a
 * paying-key authorization, from 8.0 a `relayer.pendingSubsidies` entry. One row holds the pair,
 * so when the subsidy or an offer ends, the row shows an offer still pending rather than nothing.
 */
describe('an offer still pending when a subsidy ends', () => {
  const PRE_V8_SPEC = 6_000_000;
  const OTHER_KEY = '5DAAnrj7VHTznn2AWBemMuyBwZWs6FNFjdyVXUeYum3PTXFy';
  const live = (allowance: number) => ({
    id: SUBSIDY_ID,
    beneficiaryAccountId: USER_KEY,
    payingAccountId: PAYING_KEY,
    allowance: BigInt(allowance),
    totalDebited: BigInt(40),
    isAccepted: true,
    isRemoved: false,
  });
  const preV8 = (method: string, extra: unknown[] = []) =>
    tupleEvent({
      section: 'relayer',
      method,
      data: [codec(TEST_DID), codec(USER_KEY), codec(PAYING_KEY), ...extra.map(v => codec(v))],
      specVersion: PRE_V8_SPEC,
    });
  const v8 = (method: string, amount: number) =>
    tupleEvent({
      section: 'relayer',
      method,
      data: [codec(USER_KEY), codec(PAYING_KEY), codec(amount)],
    });

  it('before 8.0, a removed subsidy shows the offer its paying key made while it was live', async () => {
    const db = mockStoreAndChain({ ...seedAccounts(), Subsidy: { [SUBSIDY_ID]: live(500) } });
    (globalThis as any).api.query = chainSubsidies({ offers: [[15429, PAYING_KEY, 100]] });

    await handleSubsidyRemoved(preV8('RemovedPayingKey'));

    expect(db.Subsidy[SUBSIDY_ID]).toMatchObject({
      isAccepted: false,
      isRemoved: false,
      allowance: BigInt(100),
    });
    expect(db.Subsidy[SUBSIDY_ID].totalDebited).toBeUndefined();
  });

  it('shows the latest of several pending offers, and only offers from its paying key', async () => {
    const db = mockStoreAndChain({ ...seedAccounts(), Subsidy: { [SUBSIDY_ID]: live(500) } });
    (globalThis as any).api.query = chainSubsidies({
      offers: [
        [10, PAYING_KEY, 300],
        [12, PAYING_KEY, 200],
        [13, OTHER_KEY, 999],
      ],
    });

    await handleSubsidyRemoved(preV8('RemovedPayingKey'));

    expect(db.Subsidy[SUBSIDY_ID]).toMatchObject({ isAccepted: false, allowance: BigInt(200) });
  });

  it('from 8.0, a removed subsidy shows the pending subsidy from the same paying key', async () => {
    const db = mockStoreAndChain({ ...seedAccounts(), Subsidy: { [SUBSIDY_ID]: live(500) } });
    (globalThis as any).api.query = chainSubsidies({ pending: 900 });

    await handleSubsidyRemoved(v8('RemovedSubsidy', 450));

    expect(db.Subsidy[SUBSIDY_ID]).toMatchObject({
      isAccepted: false,
      isRemoved: false,
      allowance: BigInt(900),
      totalDebited: BigInt(0),
    });
  });

  it('is removed, with what it had left, when no offer is pending', async () => {
    const db = mockStoreAndChain({ ...seedAccounts(), Subsidy: { [SUBSIDY_ID]: live(500) } });

    await handleSubsidyRemoved(v8('RemovedSubsidy', 450));

    expect(db.Subsidy[SUBSIDY_ID]).toMatchObject({ isRemoved: true, allowance: BigInt(450) });
  });

  it('a withdrawn pending subsidy leaves the live subsidy it would have replaced', async () => {
    const db = mockStoreAndChain({ ...seedAccounts(), Subsidy: { [SUBSIDY_ID]: live(500) } });

    await handleSubsidyRemoved(v8('RemovedPendingSubsidy', 900));

    expect(db.Subsidy[SUBSIDY_ID]).toMatchObject({
      isAccepted: true,
      isRemoved: false,
      allowance: BigInt(500),
    });
  });

  it('before 8.0, an acceptance takes the allowance of the offer accepted, from the chain', async () => {
    // two offers were pending, and the earlier one was accepted (testnet block 13,259,435)
    const db = mockStoreAndChain(seedAccounts());
    await handleSubsidyApproved(preV8('AuthorizedPayingKey', [100, 57751]));
    await handleSubsidyApproved(preV8('AuthorizedPayingKey', [20, 57914]));
    (globalThis as any).api.query = chainSubsidies({
      live: { payingKey: PAYING_KEY, remaining: 100 },
    });

    await handleSubsidyAccepted(preV8('AcceptedPayingKey'));

    expect(db.Subsidy[SUBSIDY_ID]).toMatchObject({ isAccepted: true, allowance: BigInt(100) });
  });

  it("ignores the chain's subsidy when it is from another paying key", async () => {
    const db = mockStoreAndChain(seedAccounts());
    await handleSubsidyApproved(preV8('AuthorizedPayingKey', [20, 57914]));
    (globalThis as any).api.query = chainSubsidies({
      live: { payingKey: OTHER_KEY, remaining: 5 },
    });

    await handleSubsidyAccepted(preV8('AcceptedPayingKey'));

    expect(db.Subsidy[SUBSIDY_ID]).toMatchObject({ isAccepted: true, allowance: BigInt(20) });
  });
});
