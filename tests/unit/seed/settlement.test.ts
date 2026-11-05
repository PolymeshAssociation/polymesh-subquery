/**
 * Settlement in flight: venues, and each instruction the chain still holds, with its legs, parties
 * and approvals as the creation and affirmation handlers leave them.
 */
import { SEED_EVENT_ID } from '../../../src/mappings/consts';
import { seed } from '../../../src/seed/seeder';
import { SEEDERS } from '../../../src/seed/seeders';
import { accountRows } from '../../../src/seed/seeders/identities';
import { snapshotAtParent } from '../../../src/seed/snapshot';
import { fakeChain, FakeChain } from './fakeChain';
import { byId } from './goldens';

const ASSET = '0x1234567890abcdef1234567890abcdef';
const SENDER = `0x${'01'.repeat(32)}`;
const RECEIVER = `0x${'02'.repeat(32)}`;
const MEDIATOR = `0x${'03'.repeat(32)}`;
const KEY = '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY';
const SIGNER = '5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty';

const ENTITIES = ['Venue', 'Instruction', 'Leg', 'InstructionParty', 'InstructionAffirmation'];
const portfolio = (did: string, number = 0) => ({
  did,
  kind: number ? { User: number } : { Default: null },
});
const details = (id: number) => ({
  instructionId: id,
  venueId: 4,
  settlementType: { SettleOnAffirmation: null },
  createdAt: 1_700_000_000_000,
  tradeDate: null,
  valueDate: null,
});

describe('from 8.0', () => {
  let chain: FakeChain;
  const rows = (entity: string) => byId(chain.rows(entity));

  beforeAll(async () => {
    chain = fakeChain(8_001_020);
    chain.put('identity.keyRecords', [KEY], { PrimaryKey: RECEIVER });
    chain.put('settlement.venueInfo', [4], { creator: SENDER, venueType: 'Exchange' });
    chain.put('settlement.details', [4], 'A venue');
    chain.put('settlement.venueSigners', [4, SIGNER], true);

    // 7: two fungible legs, a portfolio to an account and back, a mediator who affirmed
    chain.put('settlement.instructionDetails', [7], details(7));
    chain.put('settlement.instructionStatuses', [7], { Pending: null });
    chain.put('settlement.instructionMemos', [7], `0x${'61'.repeat(32)}`);
    chain.put('settlement.instructionLegs', [7, 0], {
      Fungible: {
        sender: { Portfolio: portfolio(SENDER) },
        receiver: { Account: KEY },
        assetId: ASSET,
        amount: 500,
      },
    });
    chain.put('settlement.instructionLegs', [7, 1], {
      Fungible: {
        sender: { Account: KEY },
        receiver: { Portfolio: portfolio(SENDER) },
        assetId: ASSET,
        amount: 7,
      },
    });
    chain.put('settlement.instructionMediatorsAffirmations', [7, MEDIATOR], {
      Affirmed: { expiry: 1_900_000_000_000 },
    });
    chain.put('settlement.affirmsReceived', [7, { Portfolio: portfolio(SENDER) }], 'Affirmed');
    chain.put('settlement.userAffirmations', [{ Portfolio: portfolio(SENDER) }, 7], 'Affirmed');
    chain.put('settlement.userAffirmations', [{ Account: KEY }, 7], 'Pending');

    // 8: a pre-6.0 leg 6.0 migrated off-chain, whose portfolios' affirmations the chain still holds
    chain.put('settlement.instructionDetails', [8], details(8));
    chain.put('settlement.instructionStatuses', [8], { Pending: null });
    chain.put('settlement.instructionLegs', [8, 0], {
      OffChain: {
        senderIdentity: SENDER,
        receiverIdentity: RECEIVER,
        ticker: `0x${'00'.repeat(8)}a0025120`,
        amount: 1_000,
      },
    });
    chain.put('settlement.userAffirmations', [{ Portfolio: portfolio(SENDER) }, 8], 'Pending');
    chain.put('settlement.userAffirmations', [{ Portfolio: portfolio(RECEIVER) }, 8], 'Pending');

    // 9: failed; 10: locked for execution; 11: never given a status, by a runtime that never pruned it
    chain.put('settlement.instructionDetails', [9], details(9));
    chain.put('settlement.instructionStatuses', [9], { Failed: null });
    chain.put('settlement.instructionDetails', [10], details(10));
    chain.put('settlement.instructionStatuses', [10], { LockedForExecution: null });
    chain.put('settlement.instructionDetails', [11], details(11));

    await seed(
      snapshotAtParent(chain.block),
      {
        block: chain.block,
        blockId: '0000001000',
        eventId: SEED_EVENT_ID,
        datetime: new Date(0),
        specVersion: 8_001_020,
      },
      { seeders: SEEDERS.filter(({ entity }) => ENTITIES.includes(entity)), accountRows }
    );
  });

  it('seeds each venue with its details and signers', () => {
    expect(rows('Venue')['0000000004']).toMatchObject({
      ownerId: SENDER,
      type: 'Exchange',
      details: 'A venue',
      signers: [SIGNER],
    });
  });

  it('seeds each instruction with its status, venue, memo, mediators and leg count', () => {
    expect(rows('Instruction')['0000000007']).toMatchObject({
      status: 'Created',
      venueId: '0000000004',
      type: 'SettleOnAffirmation',
      memo: 'a'.repeat(32),
      mediators: [MEDIATOR],
      legCount: 2,
    });
    expect(rows('Instruction')['0000000009'].status).toBe('Failed');
    expect(rows('Instruction')['0000000010'].status).toBe('Locked');
  });

  it('skips an instruction with no status, finished under a runtime that never pruned it', () => {
    expect(rows('Instruction')['0000000011']).toBeUndefined();
  });

  it('seeds each leg, an account side under the identity its key names', () => {
    expect(rows('Leg')['0000000007/0']).toMatchObject({
      legType: 'Fungible',
      fromPortfolioId: `${SENDER}/0`,
      toAccountId: KEY,
      toId: RECEIVER,
      assetId: ASSET,
      amount: '500',
    });
    expect(rows('Leg')['0000000008/0']).toMatchObject({
      legType: 'OffChain',
      fromId: SENDER,
      toId: RECEIVER,
    });
  });

  it('seeds the parties and their approvals as the chain holds them', () => {
    expect(
      Object.keys(rows('InstructionParty'))
        .filter(id => id.startsWith('0000000007'))
        .sort()
    ).toEqual(
      [
        `0000000007/${MEDIATOR}/true`,
        `0000000007/${RECEIVER}/false`,
        `0000000007/${SENDER}/false`,
      ].sort()
    );
    expect(rows('InstructionAffirmation')[`0000000007/${SENDER}/0`]).toMatchObject({
      status: 'Affirmed',
    });
    expect(rows('InstructionAffirmation')[`0000000007/${KEY}`]).toMatchObject({
      status: 'Pending',
      identityId: RECEIVER,
    });
    expect(rows('InstructionAffirmation')[`0000000007/mediator/${MEDIATOR}`]).toMatchObject({
      status: 'Affirmed',
      expiry: new Date(1_900_000_000_000).toISOString(),
    });
  });

  it("keeps the approvals of a migrated off-chain leg's portfolios, which the chain still holds", () => {
    expect(
      Object.keys(rows('InstructionAffirmation'))
        .filter(id => id.startsWith('0000000008'))
        .sort()
    ).toEqual([`0000000008/${RECEIVER}/0`, `0000000008/${SENDER}/0`].sort());
  });
});

/** Before 6.0 an instruction's status is a field of its details, and a leg is a plain transfer */
describe('before 6.0', () => {
  let chain: FakeChain;
  const rows = (entity: string) => byId(chain.rows(entity));
  const TICKER = '0x41434d450000000000000000'; // ACME
  const NO_ASSET = '0x4e4f41535345540000000000'; // NOASSET

  beforeAll(async () => {
    chain = fakeChain(5_001_002);
    chain.put('asset.tokens', [TICKER], {
      totalSupply: 1_000,
      ownerDid: SENDER,
      divisible: true,
      assetType: { EquityCommon: null },
    });
    chain.put('settlement.venueInfo', [4], { creator: SENDER, venueType: 'Exchange' });
    chain.put('settlement.instructionDetails', [7], {
      ...details(7),
      status: { Pending: null },
    });
    chain.put('settlement.instructionLegs', [7, 0], {
      from: portfolio(SENDER),
      to: portfolio(RECEIVER),
      asset: TICKER,
      amount: 500,
    });
    chain.put('settlement.instructionDetails', [8], {
      ...details(8),
      status: { Failed: null },
    });
    chain.put('settlement.instructionLegs', [8, 0], {
      from: portfolio(SENDER),
      to: portfolio(RECEIVER),
      asset: NO_ASSET,
      amount: 9,
    });
    await seed(
      snapshotAtParent(chain.block),
      {
        block: chain.block,
        blockId: '0000001000',
        eventId: SEED_EVENT_ID,
        datetime: new Date(0),
        specVersion: 5_001_002,
      },
      { seeders: SEEDERS.filter(({ entity }) => ENTITIES.includes(entity)), accountRows }
    );
  });

  it('seeds each instruction with the status its details hold', () => {
    expect(rows('Instruction')['0000000007'].status).toBe('Created');
    expect(rows('Instruction')['0000000008'].status).toBe('Failed');
  });

  it("reads a leg as the handlers do: an asset's ticker fungible, another's off-chain", () => {
    expect(rows('Leg')['0000000007/0']).toMatchObject({
      legType: 'Fungible',
      ticker: 'ACME',
      fromPortfolioId: `${SENDER}/0`,
      toPortfolioId: `${RECEIVER}/0`,
      amount: '500',
    });
    expect(rows('Leg')['0000000008/0']).toMatchObject({ legType: 'OffChain', ticker: 'NOASSET' });
    expect(rows('Leg')['0000000008/0'].assetId).toBeUndefined();
  });
});
