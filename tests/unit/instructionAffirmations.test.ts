import {
  handleAffirmationWithdrawn,
  handleAutomaticAffirmation,
  handleInstructionCreated,
  handleInstructionFinalizedEvent,
  handleInstructionRejected,
  handleInstructionUpdate,
  handleReceiptClaimed,
  handleSettlementManuallyExecuted,
} from '../../src/mappings/entities/settlements/mapSettlement';
import {
  codec,
  MockDb,
  mockBulkWrites,
  mockLedgerAccountQuery,
  mockStore,
  tupleEvent,
} from './helpers';

const I = '0000000042';
const ASSET = '0xa3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3';
const DID_A = '0x0a'.padEnd(66, '0');
const DID_B = '0x0b'.padEnd(66, '0');
const CUSTODIAN = '0x0c'.padEnd(66, '0');
const ACCOUNT_C = '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY';
const ACCOUNT_X = '5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty';
const SIGNER = '5DAAnrj7VHTznn2AWBemMuyBwZWs6FNFjdyVXUeYum3PTXFy';

const portfolio = (did: string, number = 0) => ({
  portfolio: { did, kind: number ? { user: number } : { default: null } },
});
const account = (address: string) => ({ account: address });
const leg = (sender: unknown, receiver: unknown) => ({
  fungible: { sender, receiver, assetId: ASSET, amount: 100 },
});
const signed = { idx: 1, extrinsic: { signer: { toString: () => SIGNER } } };

const created = (legs: unknown[], idx = 1, extra: Record<string, unknown> = {}) =>
  tupleEvent({
    section: 'settlement',
    method: 'InstructionCreated',
    data: [
      codec(DID_A),
      codec(7),
      codec(42),
      codec({ settleOnAffirmation: null }),
      codec(''),
      codec(''),
      codec(legs),
      codec(''),
    ],
    idx,
    extrinsic: signed,
    ...extra,
  });
const holderEvent = (
  method: string,
  caller: string,
  holder: unknown,
  idx = 2,
  extra: Record<string, unknown> = {}
) =>
  tupleEvent({
    section: 'settlement',
    method,
    data: [codec(caller), codec(holder), codec(42)],
    idx,
    extrinsic: signed,
    ...extra,
  });

// the block's own record of the creating event, in the same extrinsic as the re-scanned ones
const createdRecord = {
  phase: { toString: () => '{"applyExtrinsic":1}' },
  event: { section: 'settlement', method: 'InstructionCreated', data: [] },
};

describe('holder affirmations', () => {
  let db: MockDb;

  beforeEach(() => {
    db = mockStore({
      Asset: { [ASSET]: { id: ASSET, ticker: 'ACME' } },
      Identity: Object.fromEntries([DID_A, DID_B].map(did => [did, { id: did, did }])),
      Portfolio: Object.fromEntries(
        [DID_A, DID_B].flatMap(did =>
          [0, 1].map(n => [`${did}/${n}`, { id: `${did}/${n}`, identityId: did, number: n }])
        )
      ),
      Account: { [ACCOUNT_C]: { id: ACCOUNT_C, address: ACCOUNT_C, identityId: DID_B } },
    });
    mockBulkWrites(db, 'InstructionAffirmation');
    (globalThis as any).api.runtimeVersion = { specName: { toString: () => 'polymesh' } };
    (globalThis as any).api.query = mockLedgerAccountQuery();
  });

  it('creates a pending row for each holder on the legs', async () => {
    await handleInstructionCreated(
      created([
        leg(portfolio(DID_A), portfolio(DID_B)),
        leg(portfolio(DID_A, 1), account(ACCOUNT_C)),
      ])
    );

    expect(Object.keys(db.InstructionAffirmation).sort()).toEqual(
      [`${I}/${DID_A}/0`, `${I}/${DID_B}/0`, `${I}/${DID_A}/1`, `${I}/${ACCOUNT_C}`].sort()
    );
    expect(db.InstructionAffirmation[`${I}/${ACCOUNT_C}`]).toMatchObject({
      instructionId: I,
      status: 'Pending',
      identityId: DID_B,
      accountId: ACCOUNT_C,
      partyId: `${I}/${DID_B}/false`,
      isMediator: false,
      isAutomaticallyAffirmed: false,
    });
    expect(db.InstructionAffirmation[`${I}/${DID_A}/1`]).toMatchObject({
      portfolioId: `${DID_A}/1`,
      identityId: DID_A,
      partyId: `${I}/${DID_A}/false`,
    });
    Object.values(db.InstructionAffirmation).forEach(row => {
      expect(row.affirmedById).toBeUndefined();
      expect(row.signerId).toBeUndefined();
    });
  });

  it('one row for a holder on two legs', async () => {
    await handleInstructionCreated(
      created([leg(portfolio(DID_A), portfolio(DID_B)), leg(portfolio(DID_B), portfolio(DID_A))])
    );

    expect(Object.keys(db.InstructionAffirmation).sort()).toEqual(
      [`${I}/${DID_A}/0`, `${I}/${DID_B}/0`].sort()
    );
  });

  it("a custodian's affirmation records the custodian as actor and the owner as holder", async () => {
    await handleInstructionCreated(created([leg(portfolio(DID_A), portfolio(DID_B))]));
    await handleInstructionUpdate(holderEvent('InstructionAffirmed', CUSTODIAN, portfolio(DID_A)));

    expect(db.InstructionAffirmation[`${I}/${DID_A}/0`]).toMatchObject({
      status: 'Affirmed',
      identityId: DID_A,
      portfolioId: `${DID_A}/0`,
      affirmedById: CUSTODIAN,
      signerId: SIGNER,
      partyId: `${I}/${DID_A}/false`,
      isAutomaticallyAffirmed: false,
      updatedEventId: '0000001000/0000000002',
    });
    expect(db.InstructionEvent['0000001000/0000000002']).toMatchObject({
      event: 'InstructionAffirmed',
      identityId: CUSTODIAN,
      signerId: SIGNER,
      portfolioId: `${DID_A}/0`,
    });
    expect(db.InstructionAffirmation[`${I}/${DID_B}/0`].status).toBe('Pending');
  });

  it('one call affirming two holders of one DID', async () => {
    await handleInstructionCreated(
      created([leg(portfolio(DID_A), portfolio(DID_B)), leg(portfolio(DID_A, 1), portfolio(DID_B))])
    );
    await handleInstructionUpdate(holderEvent('InstructionAffirmed', DID_A, portfolio(DID_A), 2));
    await handleInstructionUpdate(
      holderEvent('InstructionAffirmed', DID_A, portfolio(DID_A, 1), 3)
    );

    for (const id of [`${I}/${DID_A}/0`, `${I}/${DID_A}/1`]) {
      expect(db.InstructionAffirmation[id]).toMatchObject({
        status: 'Affirmed',
        partyId: `${I}/${DID_A}/false`,
      });
    }
    expect(Object.keys(db.InstructionParty).sort()).toEqual(
      [`${I}/${DID_A}/false`, `${I}/${DID_B}/false`].sort()
    );
  });

  it('withdrawal returns the row to pending', async () => {
    await handleInstructionCreated(created([leg(portfolio(DID_A), portfolio(DID_B))]));
    await handleInstructionUpdate(holderEvent('InstructionAffirmed', DID_A, portfolio(DID_A), 2));
    await handleAffirmationWithdrawn(
      holderEvent('AffirmationWithdrawn', CUSTODIAN, portfolio(DID_A), 3)
    );

    expect(db.InstructionAffirmation[`${I}/${DID_A}/0`]).toMatchObject({
      status: 'Pending',
      affirmedById: CUSTODIAN,
      signerId: SIGNER,
      updatedEventId: '0000001000/0000000003',
    });
    expect(db.InstructionEvent['0000001000/0000000003']).toMatchObject({
      event: 'AffirmationWithdrawn',
      identityId: CUSTODIAN,
      portfolioId: `${DID_A}/0`,
    });
  });

  it('affirms a holder with no pending row', async () => {
    db.Instruction = { [I]: { id: I, legCount: 0, mediators: [] } };

    await handleInstructionUpdate(holderEvent('InstructionAffirmed', DID_A, portfolio(DID_A, 1)));

    expect(db.InstructionAffirmation[`${I}/${DID_A}/1`]).toMatchObject({
      status: 'Affirmed',
      identityId: DID_A,
      portfolioId: `${DID_A}/1`,
      affirmedById: DID_A,
      partyId: `${I}/${DID_A}/false`,
      createdEventId: '0000001000/0000000002',
    });
    expect(db.InstructionParty[`${I}/${DID_A}/false`]).toMatchObject({
      instructionId: I,
      identityId: DID_A,
      isMediator: false,
    });
  });

  it('account with no identity', async () => {
    db.Instruction = { [I]: { id: I, legCount: 0, mediators: [] } };

    await handleInstructionUpdate(holderEvent('InstructionAffirmed', DID_A, account(ACCOUNT_X)));

    const row = db.InstructionAffirmation[`${I}/${ACCOUNT_X}`];
    expect(row).toMatchObject({
      status: 'Affirmed',
      accountId: ACCOUNT_X,
      partyId: `${I}/${ACCOUNT_X}/false`,
    });
    expect(row.identityId).toBeUndefined();
    expect(db.InstructionParty[`${I}/${ACCOUNT_X}/false`]).toMatchObject({ accountId: ACCOUNT_X });
  });

  it('created and executed in one extrinsic', async () => {
    const legs = [leg(portfolio(DID_A), account(ACCOUNT_C))];

    await handleInstructionCreated(created(legs, 1));
    await handleAutomaticAffirmation(
      holderEvent('InstructionAutomaticallyAffirmed', DID_A, account(ACCOUNT_C), 2)
    );
    await handleInstructionUpdate(holderEvent('InstructionAffirmed', DID_A, portfolio(DID_A), 3));
    await handleInstructionFinalizedEvent(
      tupleEvent({
        section: 'settlement',
        method: 'InstructionExecuted',
        data: [codec(DID_A), codec(42)],
        idx: 4,
        extrinsic: signed,
      })
    );

    expect(db.InstructionAffirmation[`${I}/${ACCOUNT_C}`]).toMatchObject({
      status: 'Affirmed',
      isAutomaticallyAffirmed: true,
      affirmedById: DID_A,
    });
    expect(db.InstructionAffirmation[`${I}/${DID_A}/0`]).toMatchObject({
      status: 'Affirmed',
      isAutomaticallyAffirmed: false,
    });
    expect(db.Instruction[I].status).toBe('Executed');
  });

  const v6Leg = {
    fungible: {
      sender: { did: DID_A, kind: { default: null } },
      receiver: { did: DID_B, kind: { default: null } },
      assetId: ASSET,
      amount: 100,
    },
  };
  const autoRecord = (instruction: number) => ({
    phase: { toString: () => '{"applyExtrinsic":1}' },
    event: {
      section: 'settlement',
      method: 'InstructionAutomaticallyAffirmed',
      data: [codec(DID_A), codec({ did: DID_B, kind: { default: null } }), codec(instruction)],
    },
  });
  const preCreation = (specVersion: number, instruction = 42) => {
    const events = [autoRecord(instruction), createdRecord];
    return {
      auto: tupleEvent({
        section: 'settlement',
        method: 'InstructionAutomaticallyAffirmed',
        data: autoRecord(instruction).event.data,
        idx: 0,
        extrinsic: signed,
        specVersion,
        events,
      }),
      created: created([v6Leg], 1, { specVersion, events }),
    };
  };

  it.each([
    ['6.1.0 to 6.3.0', 6_002_000],
    ['the last runtime with that order', 6_003_001],
  ])(
    'keeps an automatic affirmation emitted before its instruction is created (%s)',
    async (_window, specVersion) => {
      const { auto, created: creation } = preCreation(specVersion);

      await handleAutomaticAffirmation(auto);
      await handleInstructionCreated(creation);

      expect(db.InstructionAffirmation[`${I}/${DID_B}/0`]).toMatchObject({
        status: 'Affirmed',
        isAutomaticallyAffirmed: true,
        affirmedById: DID_A,
        signerId: SIGNER,
      });
      expect(db.InstructionAffirmation[`${I}/${DID_A}/0`].status).toBe('Pending');
      expect(db.InstructionEvent['0000001000/0000000000']).toMatchObject({
        event: 'InstructionAutomaticallyAffirmed',
        identityId: DID_A,
        portfolioId: `${DID_B}/0`,
      });
    }
  );

  it('keeps an early automatic affirmation on the private chain too', async () => {
    (globalThis as any).api.runtimeVersion = {
      specName: { toString: () => 'polymesh_private_dev' },
    };
    const { auto, created: creation } = preCreation(1_000_000);

    await handleAutomaticAffirmation(auto);
    await handleInstructionCreated(creation);

    expect(db.InstructionAffirmation[`${I}/${DID_B}/0`]).toMatchObject({
      status: 'Affirmed',
      isAutomaticallyAffirmed: true,
    });
  });

  it("does not take another instruction's early automatic affirmation", async () => {
    const { auto, created: creation } = preCreation(6_002_000, 43);

    await handleAutomaticAffirmation(auto);
    await handleInstructionCreated(creation);

    expect(db.InstructionAffirmation[`${I}/${DID_B}/0`].status).toBe('Pending');
    expect(db.InstructionAffirmation[`0000000043/${DID_B}/0`].status).toBe('Affirmed');
  });
});

describe('signers on creation', () => {
  it('writes no signer on the legs of an instruction created without one', async () => {
    const db = mockStore({ Asset: { [ASSET]: { id: ASSET, ticker: 'ACME' } } });
    mockBulkWrites(db, 'Leg');
    (globalThis as any).api.runtimeVersion = { specName: { toString: () => 'polymesh' } };

    await handleInstructionCreated(
      created([leg(portfolio(DID_A), portfolio(DID_B))], 1, { extrinsic: undefined })
    );

    expect(db.Leg[`${I}/0`].addresses).toStrictEqual([]);
    expect(db.InstructionEvent['0000001000/0000000001'].signerId).toBeUndefined();
  });
});

describe('rejection and callers', () => {
  const ISSUER = '0x0d'.padEnd(66, '0');
  const VENUE_OWNER = '0x0e'.padEnd(66, '0');
  const MEDIATOR = '0x0f'.padEnd(66, '0');
  const seeded = () => ({
    [`${I}/${DID_A}/0`]: { id: `${I}/${DID_A}/0`, status: 'Affirmed', affirmedById: DID_A },
    [`${I}/${DID_B}/0`]: { id: `${I}/${DID_B}/0`, status: 'Pending' },
  });
  let db: MockDb;

  beforeEach(() => {
    db = mockStore({
      Instruction: { [I]: { id: I, status: 'Created', legCount: 0, mediators: [MEDIATOR] } },
      InstructionAffirmation: seeded(),
    });
  });

  const callerEvent = (method: string, caller: string, extra: Record<string, unknown> = {}) =>
    tupleEvent({
      section: 'settlement',
      method,
      data: [codec(caller), codec(42)],
      idx: 3,
      extrinsic: signed,
      ...extra,
    });

  it('rejection by a holder records who rejected', async () => {
    await handleInstructionRejected(callerEvent('InstructionRejected', DID_A));

    expect(db.Instruction[I]).toMatchObject({
      status: 'Rejected',
      rejectedById: DID_A,
      rejectedBySignerId: SIGNER,
      updatedEventId: '0000001000/0000000003',
    });
    expect(db.InstructionEvent['0000001000/0000000003']).toMatchObject({
      event: 'InstructionRejected',
      identityId: DID_A,
      signerId: SIGNER,
    });
    expect(db.InstructionAffirmation).toEqual(seeded());
  });

  it.each([
    ['a caller that is no party', ISSUER],
    ['a custodian', CUSTODIAN],
    ["the venue's creator", VENUE_OWNER],
    ['a mediator', MEDIATOR],
  ])('rejection by %s changes no affirmation', async (_who, caller) => {
    await handleInstructionRejected(callerEvent('InstructionRejected', caller));

    expect(db.InstructionAffirmation).toEqual(seeded());
    expect(db.Instruction[I]).toMatchObject({ status: 'Rejected', rejectedById: caller });
  });

  it.each([
    ['InstructionExecuted', 'Executed'],
    ['InstructionLocked', 'Locked'],
    ['InstructionUnlocked', 'Created'],
  ])('%s records its caller and signer', async (method, status) => {
    await handleInstructionFinalizedEvent(callerEvent(method, VENUE_OWNER));

    expect(db.Instruction[I].status).toBe(status);
    expect(db.InstructionEvent['0000001000/0000000003']).toMatchObject({
      event: method,
      identityId: VENUE_OWNER,
      signerId: SIGNER,
    });
  });

  it('a scheduled execution has no signer', async () => {
    await handleInstructionFinalizedEvent(
      callerEvent('InstructionExecuted', VENUE_OWNER, { extrinsic: undefined })
    );

    const event = db.InstructionEvent['0000001000/0000000003'];
    expect(event.identityId).toBe(VENUE_OWNER);
    expect(event.signerId).toBeUndefined();
  });

  it('a manual execution records its signer', async () => {
    await handleSettlementManuallyExecuted(callerEvent('SettlementManuallyExecuted', DID_A));

    expect(db.InstructionEvent['0000001000/0000000003']).toMatchObject({
      event: 'SettlementManuallyExecuted',
      identityId: DID_A,
      signerId: SIGNER,
    });
  });

  it('a receipt claim records its signer', async () => {
    await handleReceiptClaimed(
      tupleEvent({
        section: 'settlement',
        method: 'ReceiptClaimed',
        data: [codec(DID_A), codec(42), codec(0), codec(7), codec(ACCOUNT_X), codec('')],
        idx: 3,
        extrinsic: signed,
      })
    );

    expect(db.InstructionEvent['0000001000/0000000003/receipt/0']).toMatchObject({
      identityId: DID_A,
      signerId: SIGNER,
    });
  });
});
