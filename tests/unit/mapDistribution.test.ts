/**
 * `Distribution.remaining`, as `capitalDistribution.distributions` holds it: lowered by each
 * benefit claimed, before its tax, and nothing once the rest is reclaimed.
 */
import {
  handleBenefitClaimed,
  handleReclaimed,
} from '../../src/mappings/entities/assets/mapCorporateActions';
import { codec, MockDb, mockStore, tupleEvent } from './helpers';

const ASSET = '0x1234567890abcdef1234567890abcdef';
const CA_ID = codec({ assetId: ASSET, localId: 3 });
const ID = `${ASSET}/3`;

describe("a distribution's remaining amount", () => {
  let db: MockDb;

  beforeEach(() => {
    db = mockStore({
      Distribution: {
        [ID]: { id: ID, amount: BigInt(1000), remaining: BigInt(1000), taxes: BigInt(0) },
      },
    });
  });

  it('is lowered by a claimed benefit, before its tax', async () => {
    await handleBenefitClaimed(
      tupleEvent({
        section: 'capitalDistribution',
        method: 'BenefitClaimed',
        data: [codec(TEST_DID), codec(TEST_DID), CA_ID, codec({}), codec(300), codec(100000)],
      })
    );

    expect(db.Distribution[ID]).toMatchObject({ remaining: BigInt(700), taxes: BigInt(30) });
  });

  it('is nothing once the rest is reclaimed', async () => {
    await handleReclaimed(
      tupleEvent({
        section: 'capitalDistribution',
        method: 'Reclaimed',
        data: [codec(TEST_DID), CA_ID, codec(1000)],
      })
    );

    expect(db.Distribution[ID]).toMatchObject({ remaining: BigInt(0) });
  });
});
