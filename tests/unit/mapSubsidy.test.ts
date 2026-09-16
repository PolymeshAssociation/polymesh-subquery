import { decodeEvent } from '../../src/decode';
import {
  handlePolyxLimitUpdated,
  handleSubsidyAccepted,
  handleSubsidyApproved,
  handleSubsidyDebited,
  handleSubsidyRemoved,
} from '../../src/mappings/entities/relayer/mapSubsidy';
import { codec, mockStore, tupleEvent } from './helpers';

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

describe('v8 subsidy lifecycle', () => {
  it('approve → accept → debit → remove produces one row through the full lifecycle', async () => {
    const db = mockStore(seedAccounts());

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

    expect(db.Subsidy[SUBSIDY_ID].isRemoved).toBe(true);
  });
});

describe('pre-v8 paying-key lifecycle', () => {
  const PRE_V8_SPEC = 6_000_000;

  it('authorize → accept → remove produces the equivalent row, reading initialPolyxLimit from params[3]', async () => {
    const db = mockStore(seedAccounts());

    await handleSubsidyApproved(
      tupleEvent({
        section: 'relayer',
        method: 'AuthorizedPayingKey',
        data: [codec(TEST_DID), codec(USER_KEY), codec(PAYING_KEY), codec(500), codec(9)],
        specVersion: PRE_V8_SPEC,
      })
    );

    expect(db.Subsidy[SUBSIDY_ID]).toMatchObject({ allowance: BigInt(500), isAccepted: false });

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

    expect(db.Subsidy[SUBSIDY_ID].isRemoved).toBe(true);
  });
});

describe('UpdatedPolyxLimit', () => {
  it('decodes 5 params pre-v8 and 4 params at v8+ with no arity error, setting allowance either way', async () => {
    const db = mockStore(seedAccounts());
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
    const db = mockStore(seedAccounts());

    (globalThis as any).api.query = {
      relayer: {
        subsidies: jest
          .fn()
          .mockResolvedValue({
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

  it('falls back to a zero allowance when chain state cannot be read', async () => {
    const db = mockStore(seedAccounts());
    (globalThis as any).api.query = {};

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

  it('a later removal then finds the row instead of anomalying', async () => {
    const db = mockStore(seedAccounts());
    (globalThis as any).api.query = {};

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
