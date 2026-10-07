import {
  handleBallotCreated,
  handleBallotMetaChanged,
  handleBallotRangeChanged,
  handleBallotRcvChanged,
  handleBallotRemoved,
  handleBallotVoteCast,
} from '../../src/mappings/entities/assets/mapCorporateBallot';
import { IndexerAnomaly } from '../../src/types';
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
  const ballotCreated = () =>
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
    });

  it('creates a CorporateBallot from the range, meta and rcv params', async () => {
    const db = mockStore({ CorporateAction: { [ballotId]: { id: ballotId } } });

    await handleBallotCreated(ballotCreated());

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

  it('keeps the ballot, without its corporate action, when the index does not hold the action', async () => {
    const db = mockStore();
    const anomaly = jest.spyOn(IndexerAnomaly.prototype, 'save').mockResolvedValue(undefined);

    await handleBallotCreated(ballotCreated());

    expect(db.CorporateBallot[ballotId]).toMatchObject({ assetId: ASSET_ID, rcv: true });
    expect(db.CorporateBallot[ballotId].corporateActionId).toBeUndefined();
    expect(anomaly).toHaveBeenCalledTimes(1);
    anomaly.mockRestore();
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

  /**
   * The chain keys `Votes` on `(CAId, IdentityId)`, so a second `VoteCast` while the ballot is open
   * replaces the first. Two rows would leave the voter counted twice in any tally.
   */
  it('replaces a voter’s earlier vote rather than adding a second row', async () => {
    const db = mockStore();

    const voteCast = (power: number, idx: number) =>
      tupleEvent({
        section: 'corporateBallot',
        method: 'VoteCast',
        data: [codec(DID_A), caIdCodec(0), codec([{ power, fallback: null }])],
        blockNumber: '42',
        idx,
      });

    await handleBallotVoteCast(voteCast(100, 3));
    await handleBallotVoteCast(voteCast(250, 7));

    const rows = Object.values(db.CorporateBallotVote) as any[];

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: `${ballotId}/${DID_A}`,
      votes: [{ power: BigInt(250), fallback: undefined }],
      createdEventId: '0000000042/0000000003',
      updatedEventId: '0000000042/0000000007',
    });
  });
});

/**
 * Every string in `BallotMeta` is `Bytes` on chain, including the ones nested inside each motion, so
 * they all arrive hex-encoded. The motions hold what is actually being voted on, so leaving them
 * encoded means nothing can display a ballot without decoding it first.
 */
describe('ballot meta decoding', () => {
  it('decodes the nested motion titles, info links and choices, not just the outer title', async () => {
    const db = mockStore();

    await handleBallotCreated(
      tupleEvent({
        section: 'corporateBallot',
        method: 'Created',
        data: [
          codec(DID_A),
          caIdCodec(0),
          codec({ start: 1_000, end: 2_000 }),
          codec({
            title: '0x416e6e75616c204d656574696e67',
            motions: [
              {
                title: '0x4170706f696e742061756469746f72',
                info_link: '0x68747470733a2f2f612e696f',
                choices: ['0x596573', '0x4e6f'],
              },
            ],
          }),
          codec(false),
        ],
      })
    );

    expect(JSON.parse(db.CorporateBallot[ballotId].meta)).toEqual({
      title: 'Annual Meeting',
      motions: [{ title: 'Appoint auditor', infoLink: 'https://a.io', choices: ['Yes', 'No'] }],
    });
  });
});
