import {
  handleBallotCreated,
  handleBallotMetaChanged,
  handleBallotRangeChanged,
  handleBallotRcvChanged,
  handleBallotRemoved,
  handleBallotVoteCast,
} from '../../src/mappings/entities/assets/mapCorporateBallot';
import { codec, mockStore, tupleEvent } from './helpers';

const ASSET_ID = '0xassetballot00000000000000000000';
const DID_A = TEST_DID;
const caIdCodec = (localId = 0) => codec({ assetId: ASSET_ID, local_id: localId });
const ballotId = `${ASSET_ID}/0`;

const seedBallot = () =>
  mockStore({
    CorporateBallot: {
      [ballotId]: {
        id: ballotId,
        assetId: ASSET_ID,
        startDate: new Date(1_000),
        endDate: new Date(2_000),
        meta: JSON.stringify({ title: 'Old', motions: [] }),
        rcv: false,
        isRemoved: false,
      },
    },
  });

describe('handleBallotCreated', () => {
  it('creates a CorporateBallot from the range, meta and rcv params', async () => {
    const db = mockStore();

    await handleBallotCreated(
      tupleEvent({
        section: 'corporateBallot',
        method: 'Created',
        data: [
          codec(DID_A),
          caIdCodec(0),
          codec({ start: 1_000, end: 2_000 }),
          codec({ title: 'Annual Meeting', motions: [] }),
          codec(true),
        ],
      })
    );

    const ballot = db.CorporateBallot[ballotId];

    expect(ballot).toMatchObject({
      assetId: ASSET_ID,
      corporateActionId: ballotId,
      startDate: new Date(1_000),
      endDate: new Date(2_000),
      rcv: true,
      isRemoved: false,
    });
    expect(JSON.parse(ballot.meta)).toMatchObject({ title: 'Annual Meeting' });
  });
});

describe('handleBallotMetaChanged', () => {
  it('overwrites meta', async () => {
    const db = seedBallot();

    await handleBallotMetaChanged(
      tupleEvent({
        section: 'corporateBallot',
        method: 'MetaChanged',
        data: [codec(DID_A), caIdCodec(0), codec({ title: 'Updated', motions: [] })],
      })
    );

    expect(JSON.parse(db.CorporateBallot[ballotId].meta)).toMatchObject({ title: 'Updated' });
  });
});

describe('handleBallotRangeChanged', () => {
  it('overwrites startDate/endDate', async () => {
    const db = seedBallot();

    await handleBallotRangeChanged(
      tupleEvent({
        section: 'corporateBallot',
        method: 'RangeChanged',
        data: [codec(DID_A), caIdCodec(0), codec({ start: 5_000, end: 6_000 })],
      })
    );

    expect(db.CorporateBallot[ballotId]).toMatchObject({
      startDate: new Date(5_000),
      endDate: new Date(6_000),
    });
  });
});

describe('handleBallotRcvChanged', () => {
  it('overwrites rcv', async () => {
    const db = seedBallot();

    await handleBallotRcvChanged(
      tupleEvent({
        section: 'corporateBallot',
        method: 'RCVChanged',
        data: [codec(DID_A), caIdCodec(0), codec(true)],
      })
    );

    expect(db.CorporateBallot[ballotId].rcv).toBe(true);
  });
});

describe('handleBallotRemoved', () => {
  it('sets isRemoved without deleting the row', async () => {
    const db = seedBallot();

    await handleBallotRemoved(
      tupleEvent({
        section: 'corporateBallot',
        method: 'Removed',
        data: [codec(DID_A), caIdCodec(0)],
      })
    );

    expect(db.CorporateBallot[ballotId].isRemoved).toBe(true);
  });
});

describe('handleBallotVoteCast', () => {
  it('writes per-motion vote weights in motion order', async () => {
    const db = mockStore();

    await handleBallotVoteCast(
      tupleEvent({
        section: 'corporateBallot',
        method: 'VoteCast',
        data: [
          codec(DID_A),
          caIdCodec(0),
          codec([
            { power: 100, fallback: null },
            { power: 50, fallback: 2 },
          ]),
        ],
        blockNumber: '42',
        idx: 3,
      })
    );

    const vote = Object.values(db.CorporateBallotVote)[0] as any;

    expect(vote).toMatchObject({
      ballotId,
      voterId: DID_A,
      votes: [
        { power: BigInt(100), fallback: undefined },
        { power: BigInt(50), fallback: 2 },
      ],
    });
  });
});
