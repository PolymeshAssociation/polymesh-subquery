jest.mock('../../src/utils/storageAtParent', () => ({
  ...jest.requireActual('../../src/utils/storageAtParent'),
  storageAtParent: jest.fn(),
  parentStateReadable: jest.fn(),
}));

import { handleInstructionCreated } from '../../src/mappings/entities/settlements/mapSettlement';
import { parentStateReadable, storageAtParent } from '../../src/utils/storageAtParent';
import { codec, MockDb, mockBulkWrites, mockStore, tupleEvent } from './helpers';

/**
 * v6.0.x affirms a pre-approved receiver when the instruction is created, with no event. The rule
 * is the runtime's `skip_portfolio_affirmation`, over the state the creation was checked against.
 */
const I = '0000000042';
const DID_A = '0x0a'.padEnd(66, '0');
const DID_B = '0x0b'.padEnd(66, '0');
const SIGNER = '5DAAnrj7VHTznn2AWBemMuyBwZWs6FNFjdyVXUeYum3PTXFy';
// `ACME` and `BETA` as 12-byte tickers
const ACME = '0x41434d450000000000000000';
const BETA = '0x424554410000000000000000';

const portfolio = (did: string, number = 0) => ({
  did,
  kind: number ? { user: number } : { default: null },
});
const leg = (sender: unknown, receiver: unknown, ticker = ACME) => ({
  fungible: { sender, receiver, ticker, amount: 100 },
});
const key = (did: string, number = 0) => ({ did, kind: number ? { User: number } : 'Default' });

/** chain state as `section.item(keys)` → value; anything absent is not stored */
const chainState = (state: Record<string, unknown>) =>
  (storageAtParent as jest.Mock).mockImplementation(
    async (_block: unknown, section: string, item: string, ...keys: unknown[]) => {
      const value = state[`${section}.${item}(${JSON.stringify(keys)})`];
      return value === undefined ? undefined : codec(value);
    }
  );

const created = (legs: unknown[], specVersion = 6_000_004) =>
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
    idx: 1,
    specVersion,
    extrinsic: { idx: 1, extrinsic: { signer: { toString: () => SIGNER } } },
  });

describe('v6.0.x silent pre-approval', () => {
  let db: MockDb;

  beforeEach(() => {
    db = mockStore({
      Identity: Object.fromEntries([DID_A, DID_B].map(did => [did, { id: did, did }])),
    });
    mockBulkWrites(db, 'InstructionAffirmation');
    (globalThis as any).api.runtimeVersion = { specName: { toString: () => 'polymesh' } };
    (parentStateReadable as jest.Mock).mockResolvedValue(true);
    chainState({});
  });

  const row = (holder: string) => db.InstructionAffirmation[`${I}/${holder}`];

  it('affirms a receiver whose identity pre-approved the ticker, as the chain does', async () => {
    chainState({ [`asset.preApprovedTicker(${JSON.stringify([DID_B, ACME])})`]: true });

    await handleInstructionCreated(created([leg(portfolio(DID_A), portfolio(DID_B))]));

    expect(row(`${DID_B}/0`)).toMatchObject({
      status: 'Affirmed',
      isAutomaticallyAffirmed: true,
      affirmedById: DID_A,
      signerId: SIGNER,
      updatedEventId: '0000001000/0000000001',
    });
    expect(row(`${DID_A}/0`).status).toBe('Pending');
  });

  it('affirms a receiver of an exempt ticker, and one whose portfolio pre-approved it', async () => {
    chainState({
      [`asset.tickersExemptFromAffirmation(${JSON.stringify([ACME])})`]: true,
      [`portfolio.preApprovedPortfolios(${JSON.stringify([key(DID_A, 2), BETA])})`]: true,
    });

    await handleInstructionCreated(
      created([
        leg(portfolio(DID_A), portfolio(DID_B)),
        leg(portfolio(DID_B, 1), portfolio(DID_A, 2), BETA),
      ])
    );

    expect(row(`${DID_B}/0`).status).toBe('Affirmed');
    expect(row(`${DID_A}/2`).status).toBe('Affirmed');
    expect(row(`${DID_B}/1`).status).toBe('Pending');
  });

  it("ignores an identity's ticker pre-approval for a portfolio under custody", async () => {
    chainState({
      [`asset.preApprovedTicker(${JSON.stringify([DID_B, ACME])})`]: true,
      [`portfolio.portfolioCustodian(${JSON.stringify([key(DID_B)])})`]: DID_A,
    });

    await handleInstructionCreated(created([leg(portfolio(DID_A), portfolio(DID_B))]));

    expect(row(`${DID_B}/0`).status).toBe('Pending');
  });

  it('keeps a pre-approved receiver pending when it also sends, or receives on an unapproved leg', async () => {
    chainState({ [`asset.preApprovedTicker(${JSON.stringify([DID_B, ACME])})`]: true });

    await handleInstructionCreated(
      created([
        leg(portfolio(DID_A), portfolio(DID_B)),
        leg(portfolio(DID_B), portfolio(DID_A)),
        leg(portfolio(DID_A), portfolio(DID_B, 1)),
        leg(portfolio(DID_A, 1), portfolio(DID_B, 1), BETA),
      ])
    );

    expect(row(`${DID_B}/0`).status).toBe('Pending');
    expect(row(`${DID_B}/1`).status).toBe('Pending');
  });

  it('records an anomaly and leaves the receiver pending when the state cannot be read', async () => {
    (parentStateReadable as jest.Mock).mockResolvedValue(false);

    await handleInstructionCreated(created([leg(portfolio(DID_A), portfolio(DID_B))]));

    expect(row(`${DID_B}/0`).status).toBe('Pending');
    expect(Object.values(db.IndexerAnomaly ?? {})).toContainEqual(
      expect.objectContaining({ kind: 'UnreadableValue' })
    );
  });

  it.each([
    ['6.1.0, which emits an event instead', 6_001_000, leg(portfolio(DID_A), portfolio(DID_B))],
    ['5.x', 5_004_000, { from: portfolio(DID_A), to: portfolio(DID_B), asset: ACME, amount: 100 }],
  ])('reads nothing from %s', async (_runtime, specVersion, oneLeg) => {
    await handleInstructionCreated(created([oneLeg], specVersion));

    expect(storageAtParent).not.toHaveBeenCalled();
    expect(row(`${DID_B}/0`).status).toBe('Pending');
  });
});
