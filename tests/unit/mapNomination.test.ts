import {
  handleChilled,
  handleKicked,
  handleNominated,
} from '../../src/mappings/entities/events/mapNomination';
import {
  codec,
  mockGetByFields,
  mockLedgerAccountQuery,
  mockStore,
  namedEvent,
  tupleEvent,
} from './helpers';

const STASH = '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY';
const VALIDATOR_A = '5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty';
const VALIDATOR_B = '5DAAnrj7VHTznn2AWBemMuyBwZWs6FNFjdyVXUeYum3PTXFy';
const VALIDATOR_C = '5CiPPseXPECbkjWCa6MnjNokrgYjMqmKndv2rSnekmSK2DjL';

const mockActiveEra = (index: number | null) => {
  (globalThis as any).api.query = {
    ...mockLedgerAccountQuery(),
    staking: {
      activeEra: jest.fn().mockResolvedValue({ toJSON: () => (index === null ? null : { index }) }),
    },
  };
};

describe('handleNominated', () => {
  it('nominate A+B then B+C closes A, keeps B open unchanged, opens C', async () => {
    const db = mockStore();
    mockGetByFields(db, 'Nomination');
    mockActiveEra(500);

    await handleNominated(
      namedEvent({
        section: 'validators',
        method: 'Nominated',
        fields: { nominatorIdentity: TEST_DID, stash: STASH, targets: [VALIDATOR_A, VALIDATOR_B] },
      })
    );

    const afterFirst = Object.values(db.Nomination) as any[];
    expect(afterFirst).toHaveLength(2);
    const bRowId = afterFirst.find(r => r.validatorId === VALIDATOR_B).id;

    await handleNominated(
      namedEvent({
        section: 'validators',
        method: 'Nominated',
        fields: { nominatorIdentity: TEST_DID, stash: STASH, targets: [VALIDATOR_B, VALIDATOR_C] },
        idx: 1,
      })
    );

    const rows = Object.values(db.Nomination) as any[];
    const aRow = rows.find(r => r.validatorId === VALIDATOR_A);
    const bRow = rows.find(r => r.validatorId === VALIDATOR_B);
    const cRow = rows.find(r => r.validatorId === VALIDATOR_C);

    expect(aRow.validToEventId).toBeDefined();
    expect(bRow.id).toBe(bRowId);
    expect(bRow.validToEventId).toBeUndefined();
    expect(cRow).toBeDefined();
    expect(cRow.validToEventId).toBeUndefined();
    expect(rows.every(r => r.eraIndex === 500)).toBe(true);
  });

  it('persists the StakingPosition it creates, and links an Account row for the nomination target', async () => {
    const db = mockStore();
    mockGetByFields(db, 'Nomination');
    mockActiveEra(500);

    await handleNominated(
      namedEvent({
        section: 'validators',
        method: 'Nominated',
        fields: { nominatorIdentity: TEST_DID, stash: STASH, targets: [VALIDATOR_A] },
      })
    );

    expect(db.StakingPosition[STASH]).toMatchObject({ stashId: STASH, isChilled: false });
    expect(db.Account[VALIDATOR_A]).toBeDefined();
  });

  it('decodes a pre-v8 tuple Nominated event through the same handler', async () => {
    const db = mockStore();
    mockGetByFields(db, 'Nomination');
    mockActiveEra(null);

    await handleNominated(
      tupleEvent({
        section: 'staking',
        method: 'Nominated',
        data: [codec(TEST_DID), codec(STASH), codec([VALIDATOR_A])],
        specVersion: 7_004_001,
      })
    );

    const [row] = Object.values(db.Nomination) as any[];
    expect(row).toMatchObject({ positionId: STASH, validatorId: VALIDATOR_A });
    expect(row.eraIndex).toBeUndefined();
  });
});

describe('handleChilled', () => {
  it('decodes a pre-v8 tuple Chilled event through the registered shape', async () => {
    const db = mockStore();
    mockGetByFields(db, 'Nomination');
    (globalThis as any).api.query = { ...mockLedgerAccountQuery() };

    await expect(
      handleChilled(
        tupleEvent({
          section: 'staking',
          method: 'Chilled',
          data: [codec(STASH)],
          specVersion: 7_004_001,
        })
      )
    ).resolves.not.toThrow();

    expect(db.StakingPosition[STASH].isChilled).toBe(true);
  });

  it('closes all open nominations and marks the position chilled', async () => {
    const db = mockStore();
    mockGetByFields(db, 'Nomination');
    mockActiveEra(500);

    await handleNominated(
      namedEvent({
        section: 'validators',
        method: 'Nominated',
        fields: { nominatorIdentity: TEST_DID, stash: STASH, targets: [VALIDATOR_A] },
      })
    );

    await handleChilled(
      namedEvent({ section: 'staking', method: 'Chilled', fields: { stash: STASH }, idx: 1 })
    );

    expect(db.StakingPosition[STASH].isChilled).toBe(true);
    expect((Object.values(db.Nomination) as any[]).every(r => r.validToEventId)).toBe(true);
  });
});

describe('handleKicked', () => {
  it('decodes a pre-v8 tuple Kicked event through the registered shape', async () => {
    const db = mockStore();
    mockGetByFields(db, 'Nomination');
    mockActiveEra(500);

    await handleNominated(
      namedEvent({
        section: 'validators',
        method: 'Nominated',
        fields: { nominatorIdentity: TEST_DID, stash: STASH, targets: [VALIDATOR_A] },
      })
    );

    await expect(
      handleKicked(
        tupleEvent({
          section: 'staking',
          method: 'Kicked',
          data: [codec(STASH), codec(VALIDATOR_A)],
          specVersion: 7_004_001,
          idx: 1,
        })
      )
    ).resolves.not.toThrow();

    const [row] = Object.values(db.Nomination) as any[];
    expect(row.validToEventId).toBeDefined();
  });

  it('closes only the nomination between the kicked nominator and that validator', async () => {
    const db = mockStore();
    mockGetByFields(db, 'Nomination');
    mockActiveEra(500);

    await handleNominated(
      namedEvent({
        section: 'validators',
        method: 'Nominated',
        fields: { nominatorIdentity: TEST_DID, stash: STASH, targets: [VALIDATOR_A, VALIDATOR_B] },
      })
    );

    await handleKicked(
      namedEvent({
        section: 'staking',
        method: 'Kicked',
        fields: { nominator: STASH, stash: VALIDATOR_A },
        idx: 1,
      })
    );

    const rows = Object.values(db.Nomination) as any[];
    expect(rows.find(r => r.validatorId === VALIDATOR_A).validToEventId).toBeDefined();
    expect(rows.find(r => r.validatorId === VALIDATOR_B).validToEventId).toBeUndefined();
  });
});
